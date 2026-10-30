import { registerExecuteManyTool } from './execute-many.js';
import { redactValue } from '../utils/output-redaction.js';
import { registerTransferTool } from './transfer.js';
import { toToolError } from '../utils/tool-error.js';
import { newExecutionResult } from '../utils/execution-result.js';
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { DurableSessions } from "../services/durable-sessions.js";
import { registerAgentTools } from "./agent-tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerExecuteCommandTool } from "./execute-command.js";
import { registerJobTools } from "./jobs.js";
import { registerUploadTool } from "./upload.js";
import { registerDownloadTool } from "./download.js";
import { registerListServersTool } from "./list-servers.js";
import { registerFileIoTools } from "./file-io.js";
import { registerMaintenanceTools } from "./maintenance.js";

/**
 * Register all tools
 * @param server MCP server instance
 */
export function registerAllTools(server: McpServer): void {
  const manager = SSHConnectionManager.getInstance();
  // Wrap the public registration API so every tool shares the same audit boundary.
  const target = server;
  server = new Proxy(target, {
    get(instance, property) {
      if (property === 'registerTool') return (name: string, config: any, handler: (...args: any[]) => any) =>
        (instance.registerTool as Function).call(instance, name, config, async (...callArgs: any[]) => {
          // The SDK passes request context as the first argument for schema-less tools.
          // Record only validated tool arguments, never headers or transport metadata.
          let args = config.inputSchema ? (callArgs[0] || {}) : {};
          if (config.inputSchema?.connectionName) {
            try { args = {...args, connectionName: manager.resolveConnectionName(args.connectionName)}; callArgs[0] = args; }
            catch (error) {
              const e = toToolError(error, 'UNKNOWN_ERROR');
              const failure = {code: e.code, message: e.message, retriable: false};
              const structuredContent = name === 'ssh_exec'
                ? {...newExecutionResult(args.steps?.length), connectionName: args.connectionName ?? null, failureStage: 'validation', output: e.message, error: failure}
                : {connectionName: args.connectionName ?? null, error: failure};
              const result = {isError: true, structuredContent, content: [{type: 'text', text: JSON.stringify(failure)}]};
              return redactValue(manager.activity ? await manager.activity.log.run(name, 'mcp', args, args.connectionName, async () => result) : result);
            }
          }
          if (!manager.activity) return redactValue(await handler(...callArgs));

          const global = ['ssh_exec_many', 'ssh_server_list', 'ssh_config_reload', 'ssh_session_list', 'ssh_session_log_cleanup', 'ssh_forward_list'].includes(name);
          let connectionName = global || name === 'ssh_file_transfer' ? undefined : args.connectionName || manager.getDefaultConnectionName();
          if (args.sessionName && !['ssh_session_start', 'ssh_session_ensure'].includes(name)) {
            try { connectionName = new DurableSessions(manager).connectionName(args.sessionName); } catch {}
          }
          if (args.forwardId) {
            const forward = manager.interactive.listForwards().find(item => item.forwardId === args.forwardId);
            connectionName = forward ? forward.connectionName || manager.getDefaultConnectionName() : undefined;
          }
          return redactValue(await manager.activity.log.run(name, 'mcp', args, connectionName, () => handler(...callArgs),
            (id, result) => manager.activity?.observe(id, name, args, result)));
        });
      return Reflect.get(instance, property, instance);
    },
  });
  registerExecuteCommandTool(server);
  registerExecuteManyTool(server);
  registerJobTools(server);
  registerUploadTool(server);
  registerTransferTool(server);
  registerDownloadTool(server);
  registerListServersTool(server);
  registerFileIoTools(server);
  registerAgentTools(server);
  registerMaintenanceTools(server);
}
