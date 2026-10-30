import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeCommand, executeCommandInputSchema } from './execute-command.js';
import { SSHConnectionManager } from '../services/ssh-connection-manager.js';
import { executionResultShape, newExecutionResult, type ExecutionResult } from '../utils/execution-result.js';
import { toToolError } from '../utils/tool-error.js';

const {connectionName: _connectionName, ...sharedInput} = executeCommandInputSchema;
export const executeManyInputSchema = {
  ...sharedInput,
  targets: z.array(z.string().min(1)).min(1).max(16).refine(v => new Set(v).size === v.length, 'targets must be unique'),
  concurrency: z.number().int().min(1).max(8).default(4).describe('Maximum active targets; use 1 for serial execution. Every target runs even if another fails.'),
  maxTotalBytes: z.number().int().min(16).max(1048576).default(65536).describe('Aggregate output payload budget, divided equally between targets. Per-target maxBytes also applies. Metadata and notices are additional.'),
};
export function registerExecuteManyTool(server: McpServer) {
  server.registerTool('ssh_exec_many', {
    description: 'Run the same command/script/steps/action on 1–16 explicitly named connections with bounded concurrency. Returns ordered per-host structured results, separate exit codes and full log paths. No fallback target and no automatic retries or rollback. Use concurrency=1 for serial runs; all targets are attempted. Text is a compact summary; full output is in structuredContent.results.',
    inputSchema: executeManyInputSchema,
    outputSchema: {results:z.array(z.object(executionResultShape)),succeeded:z.number().int(),failed:z.number().int()},
  }, async ({targets, concurrency, maxTotalBytes, ...args}) => {
    const manager = SSHConnectionManager.getInstance();
    const results = new Array<ExecutionResult>(targets.length);
    let cursor = 0;
    await Promise.all(Array.from({length: Math.min(concurrency, targets.length)}, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= targets.length) return;
        const connectionName = targets[index];
        const perHost = {...args, connectionName, maxBytes:Math.min(args.maxBytes, Math.floor(maxTotalBytes / targets.length))};
        const run = async () => {
          try {
            manager.resolveConnectionName(connectionName);
            const response = await executeCommand(perHost);
            return response.structuredContent;
          } catch (error) {
            const failure = toToolError(error, 'UNKNOWN_ERROR');
            manager.activity?.log.markFailed();
            return {...newExecutionResult(args.steps?.length), connectionName, failureStage:'validation' as const,
              output:failure.message, error:{code:failure.code,message:failure.message,retriable:failure.retriable}};
          }
        };
        results[index] = manager.activity
          ? await manager.activity.log.run('ssh_exec', 'mcp', perHost, connectionName, run)
          : await run();
      }
    }));
    const succeeded = results.filter(r => r.completed && r.exitCode === 0 && !r.error).length;
    const failed = results.length - succeeded;
    if (failed) manager.activity?.log.markFailed();
    return {isError:failed > 0, structuredContent:{results,succeeded,failed},
      content:[{type:'text' as const,text:results.map(r => `${r.connectionName}: ${r.error?.code ?? (r.completed ? `exit ${r.exitCode}` : 'incomplete')}${r.fullOutputPath ? `; log ${r.fullOutputPath}` : ''}`).join('\n')}]};
  });
}
