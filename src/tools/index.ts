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
  registerExecuteCommandTool(server);
  registerJobTools(server);
  registerUploadTool(server);
  registerDownloadTool(server);
  registerListServersTool(server);
  registerFileIoTools(server);
  registerAgentTools(server);
  registerMaintenanceTools(server);
}
