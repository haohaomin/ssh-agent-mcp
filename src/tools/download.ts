import { connectionName } from "./common.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { toToolError } from "../utils/tool-error.js";

/**
 * Register file download tool
 */
export function registerDownloadTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.registerTool(
    "ssh_download",
    {
      description: "Download a file, or a whole remote directory (recursively; symlinks skipped, max 2000 files), from connected server",
      inputSchema: {
        remotePath: z.string().describe("Remote path (POSIX absolute like /home/user/file.txt, or Windows drive-absolute like C:/Users/file.txt)"),
        localPath: z.string().describe("Local path"),
        timeoutMs: z.number().int().positive().max(7 * 24 * 60 * 60 * 1000).optional().describe("SFTP operation timeout. Large files automatically extend the configured timeout by size; this value is the minimum."),
        connectionName,
      },
    },
    async ({ remotePath, localPath, timeoutMs, connectionName }) => {
      try {
        const result = await sshManager.download(remotePath, localPath, connectionName, timeoutMs);
        return {
          content: [{ type: "text", text: result }],
        };
      } catch (error: unknown) {
        const toolError = toToolError(error, "UNKNOWN_ERROR");
        Logger.handleError(toolError, "Failed to download file");
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
