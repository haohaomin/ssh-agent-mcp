import { connectionName } from "./common.js";
import { environment } from "./common.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { ToolError, toToolError } from "../utils/tool-error.js";
import { executionResultShape, newExecutionResult } from '../utils/execution-result.js';

/**
 * Register execute command tool
 */
export function registerExecuteCommandTool(server: McpServer): void {
  server.registerTool(
    "ssh_exec",
    {
      description:
        "Execute a command, a multiline script via stdin, or ordered steps on a connected server. " +
        "Supports noninteractive sudo, remote-file environment injection and bounded head/tail output. Use ssh_upload for existing local files. " +
        "Returns structuredContent with exitCode, signal, timedOut, steps and output log metadata, plus legacy text. " +
        "On actions-only connections use action (fixed administrator-defined executable and arguments); other execution/file/session/forwarding channels are disabled. " +
        "Unrestricted execution has the SSH account's privileges; regex filters and path checks are not a sandbox. " +
        "A non-zero exit code is returned as the command's output followed by '[exit code] N' (not as a tool error).",
      outputSchema: executionResultShape,
      inputSchema: executeCommandInputSchema,
    },
    executeCommand,
  );
}

export const executeCommandInputSchema = {
        resourceKey: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/).optional().describe("Cooperative remote account lock; requires flock. Same key serializes participating exec/jobs across MCP processes. Nonblocking conflict exits 75. Unavailable with actions-only or command filters."),
        action: z.string().min(1).optional().describe('Administrator-defined action name on an actions-only connection. Mutually exclusive with command/script/steps and execution overrides. See ssh_server_list for available actions.'),
        env: environment,
        envFromRemoteFiles: z.record(
          z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
          z.string().startsWith('/').refine(value => !value.includes('\0'), 'NUL is not allowed'),
        ).optional().describe("Environment variable to absolute remote text-file path. Values are read only remotely; trailing newlines are removed. Requires exec transport. Do not print secrets or enable shell tracing."),
        command: z
          .string().min(1)
          .optional()
          .describe("Command to execute. Provide exactly one of command, script or steps."),
        script: z
          .string().min(1)
          .optional()
          .describe(
            "Script sent verbatim to bash, sh or python3 stdin. Requires exec transport. For shell scripts use failFast; Python exits on uncaught exceptions automatically.",
          ),
        steps: z.array(z.string().min(1)).min(1).optional().describe("Ordered shell steps sharing cwd and variables. Each step reports its number and exit code. Requires exec transport."),
        stopOnError: z.boolean().optional().describe("Stop steps on the first error (default: true). If false, continue and return the first failed step's status. Explicit exit/exec can end the shell."),
        failFast: z.boolean().optional().describe("Shell script only: enable errexit, plus pipefail for bash (default: false). Omit for python3; normal shell errexit exceptions apply."),
        interpreter: z
          .enum(["bash", "sh", "python3"])
          .optional()
          .describe("Script interpreter (default: bash). python3 runs unbuffered from stdin and must be installed remotely. steps supports only bash/sh."),
        sudo: z
          .boolean()
          .optional()
          .describe(
            "Run through sudo -n -- sh -c. Requires passwordless permission to run the wrapper shell. env/sudo/remote-file injection are unavailable on connections with command filters.",
          ),
        maxBytes: z
          .number().int().positive()
          .default(65536)
          .describe(
            "Output payload budget in bytes (default: 65536); status and truncation notices are outside this budget. Keeps a UTF-8-safe head/tail and attempts to save full captured output locally. The connection's maxOutputBytes is a separate hard capture limit.",
          ),
        cwd: z.string().optional().describe("Working directory for command execution"),
        connectionName,
        timeoutMs: z
          .number().int().positive()
          .optional()
          .describe(
            "Command execution timeout in milliseconds (optional; overrides the connection's commandTimeoutMs or shellCommandTimeoutMs, which defaults to 30000ms)",
          ),
      };

export async function executeCommand({ resourceKey, action, command, script, steps, stopOnError, failFast, interpreter, sudo, maxBytes, cwd, env, envFromRemoteFiles, connectionName, timeoutMs }: z.infer<z.ZodObject<typeof executeCommandInputSchema>>) {
      const sshManager = SSHConnectionManager.getInstance();
      try {
        if ([command, script, steps, action].filter(value => value !== undefined).length !== 1) {
          throw new ToolError(
            "COMMAND_VALIDATION_FAILED",
            "Exactly one of command, script or steps, or an administrator-defined action must be provided.",
            false,
          );
        }

        const result = await sshManager.executeCommandDetailed(
          command,
          cwd,
          connectionName,
          {
            ...(resourceKey === undefined ? {} : {resourceKey}),
            ...(action === undefined ? {} : {action}),
            timeout: timeoutMs,
            env,
            envFromRemoteFiles,
            script,
            steps,
            stopOnError,
            failFast,
            interpreter,
            sudo: sudo ?? false,
            maxBytes: maxBytes ?? 65536,
          },
        );
        if (result.error) sshManager.activity?.log.markFailed();
        const isError = result.error !== null && !(result.completed && result.error.code === 'COMMAND_EXECUTION_ERROR');
        return {
          content: [{ type: "text" as const, text: isError ? JSON.stringify(result.error, null, 2) : result.output }],
          structuredContent: result,
          ...(isError ? {isError: true} : {}),
        };
      } catch (error: unknown) {
        const toolError = toToolError(error, "UNKNOWN_ERROR");

        Logger.handleError(toolError, "Failed to execute command");
        const structuredContent = newExecutionResult(steps?.length);
        structuredContent.connectionName = connectionName ?? null;
        structuredContent.failureStage = 'validation';
        structuredContent.output = toolError.message;
        structuredContent.error = {code: toolError.code, message: toolError.message, retriable: toolError.retriable};
        return {
          structuredContent,
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
          isError: true,
        };
      }
    }
