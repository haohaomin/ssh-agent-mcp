import { connectionName } from "./common.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { toToolError } from "../utils/tool-error.js";

/**
 * Register file upload tool
 */
export function registerUploadTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.registerTool(
    "ssh_upload",
    {
      description: "Upload a file, or a whole directory (recursively; symlinks skipped, max 2000 files), to connected server",
      inputSchema: {
        localPath: z.string().describe("Local path"),
        remotePath: z.string().describe("Remote path (POSIX absolute like /home/user/file.txt, or Windows drive-absolute like C:/Users/file.txt)"),
        timeoutMs: z.number().int().positive().max(7 * 24 * 60 * 60 * 1000).optional().describe("SFTP operation timeout. Large files automatically extend the configured timeout by size; this value is the minimum."),
        connectionName,
      },
    },
    async ({ localPath, remotePath, timeoutMs, connectionName }) => {
      try {
        const result = await sshManager.upload(localPath, remotePath, connectionName, timeoutMs);
        return {
          content: [{ type: "text", text: result }],
        };
      } catch (error: unknown) {
        const toolError = toToolError(error, "UNKNOWN_ERROR");
        Logger.handleError(toolError, "Failed to upload file");
        return {
          content: [{
            type: "text",
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
  );
}
