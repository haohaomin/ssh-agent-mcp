import { connectionName } from "./common.js";
import { environment } from "./common.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { ToolError, toToolError } from "../utils/tool-error.js";


function errorResult(error: unknown, context: string) {
  const toolError = toToolError(error, "UNKNOWN_ERROR");
  Logger.handleError(toolError, context);
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(
        {
          code: toolError.code,
          message: toolError.message,
          retriable: toolError.retriable,
        },
        null,
        2,
      ),
    }],
    structuredContent: {error: {code: toolError.code, message: toolError.message, retriable: toolError.retriable},
      ...('jobId' in toolError ? {jobId: String(toolError.jobId), state: 'unknown', nextAction: 'Query ssh_job_status with this jobId and the same connectionName before retrying.'} : {})},
    isError: true,
  };
}

const jobOutputSchema = {
  connectionName: z.string().optional(), jobId: z.string().optional(), state: z.string().optional(),
  exitCode: z.number().nullable().optional(), pid: z.number().nullable().optional(), elapsedSeconds: z.number().nullable().optional(),
  offsetBytes: z.number().nullable().optional(), nextOffsetBytes: z.number().nullable().optional(), totalBytes: z.number().nullable().optional(),
  output: z.string().optional(), message: z.string().optional(), remoteLogPath: z.string().optional(), remoteLogPathBase: z.string().optional(), nextAction: z.string().optional(),
  error: z.object({code:z.string(),message:z.string(),retriable:z.boolean()}).optional(),
};
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Background jobs: commands that outlive ssh_exec's timeout. State is
 * kept on the remote host, so jobs survive MCP restarts and dropped connections.
 */
export function registerJobTools(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.registerTool(
    "ssh_job_start",
    {
      description:
        "Start a long-running command in the background on the server and return a job id immediately. " +
        "Use ssh_job_status to read its output and exit code, ssh_job_kill to stop it. " +
        "Prefer this over ssh_exec for builds, deploys or anything that may exceed the command timeout.",
      outputSchema: jobOutputSchema,
      inputSchema: {
        resourceKey: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/).optional().describe("Remote flock key shared with ssh_exec; contention produces job exit 75, not a retry. Requires flock."),
        env: environment,
        command: z.string().min(1).optional().describe("Command to run in the background; choose command or script"),
        script: z.string().min(1).optional().describe("Multiline source saved verbatim in a private remote job file; never executed through a caller-built quoting layer"),
        interpreter: z.enum(['bash','sh','python3']).optional(),
        failFast: z.boolean().optional().describe('Shell scripts only; enable errexit and bash pipefail'),
        cwd: z.string().optional().describe("Working directory for the command"),
        connectionName,
      },
    },
    async ({ resourceKey, command, script, interpreter, failFast, cwd, env, connectionName }) => {
      try {
        if ([command, script].filter(v => v !== undefined).length !== 1) throw new ToolError('COMMAND_VALIDATION_FAILED', 'Choose exactly one of command or script');
        if (script === undefined && (interpreter !== undefined || failFast !== undefined)) throw new ToolError('COMMAND_VALIDATION_FAILED', 'interpreter/failFast require script');
        const { jobId, message } = await sshManager.jobStart((script ?? command)!, cwd, connectionName,
          {resourceKey, script: script !== undefined, interpreter: script !== undefined ? interpreter ?? 'bash' : undefined, failFast, env});
        return {...textResult(`${message}\njobId: ${jobId}\nNext: ssh_job_status with this jobId.`),
          structuredContent: {connectionName: connectionName ?? sshManager.getDefaultConnectionName(), jobId, state: 'accepted', message,
            remoteLogPath: `.ssh-mcp-jobs/${jobId}/out`, remoteLogPathBase: 'ssh-account-home', nextAction: 'ssh_job_status'}};
      } catch (error: unknown) {
        return errorResult(error, "Failed to start job");
      }
    },
  );

  server.registerTool(
    "ssh_job_status",
    {
      description:
        "Show state (running/exited/killed/lost), exit code, elapsed time and output of a background job. " +
        "Without offset it returns the last part of the output; with offset it returns output from that byte, " +
        "and the reply names the next offset so repeated polling only reads what is new.",
      outputSchema: jobOutputSchema,
      inputSchema: {
        jobId: z.string().describe("Job id returned by ssh_job_start"),
        offsetBytes: z.number().int().nonnegative().optional().describe("Byte offset to read output from (optional)"),
        tailBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Without offset: how many trailing bytes of output to show (default 8192)"),
        maxBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max bytes of output to return in one call (default 65536)"),
        connectionName,
      },
    },
    async ({ jobId, offsetBytes, tailBytes, maxBytes, connectionName }) => {
      try {
        const status = await sshManager.jobStatusDetailed(jobId, {offset: offsetBytes, tailBytes, maxBytes}, connectionName);
        return {...textResult(status.output), structuredContent: status};
      } catch (error: unknown) {
        return errorResult(error, "Failed to read job status");
      }
    },
  );

  server.registerTool(
    "ssh_job_kill",
    {
      description: "Stop a running background job (SIGTERM, then SIGKILL after 5s), including its child processes.",
      inputSchema: {
        jobId: z.string().describe("Job id returned by ssh_job_start"),
        connectionName,
      },
    },
    async ({ jobId, connectionName }) => {
      try {
        return textResult(await sshManager.jobKill(jobId, connectionName));
      } catch (error: unknown) {
        return errorResult(error, "Failed to kill job");
      }
    },
  );

  server.registerTool(
    "ssh_job_list",
    {
      description: "List recent background jobs on the server with their state. Finished jobs are pruned after 7 days.",
      inputSchema: {
        limit: z.number().int().positive().max(100).optional().describe("Max jobs to list (default 20)"),
        connectionName,
      },
    },
    async ({ limit, connectionName }) => {
      try {
        return textResult(await sshManager.jobList(limit ?? 20, connectionName));
      } catch (error: unknown) {
        return errorResult(error, "Failed to list jobs");
      }
    },
  );
}
