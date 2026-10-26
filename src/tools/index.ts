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
          if (!manager.activity) return handler(...callArgs);
          // The SDK passes request context as the first argument for schema-less tools.
          // Record only validated tool arguments, never headers or transport metadata.
          const args = config.inputSchema ? (callArgs[0] || {}) : {};
          const global = ['ssh_server_list', 'ssh_config_reload', 'ssh_session_list', 'ssh_session_log_cleanup', 'ssh_forward_list'].includes(name);
          let connectionName = global ? undefined : args.connectionName || manager.getDefaultConnectionName();
          if (args.sessionName && !['ssh_session_start', 'ssh_session_ensure'].includes(name)) {
            try { connectionName = new DurableSessions(manager).connectionName(args.sessionName); } catch {}
          }
          if (args.forwardId) {
            const forward = manager.interactive.listForwards().find(item => item.forwardId === args.forwardId);
            connectionName = forward ? forward.connectionName || manager.getDefaultConnectionName() : undefined;
          }
          return manager.activity.log.run(name, 'mcp', args, connectionName, () => handler(...callArgs),
            (id, result) => manager.activity?.observe(id, name, args, result));
        });
      return Reflect.get(instance, property, instance);
    },
  });
  registerExecuteCommandTool(server);
  registerJobTools(server);
  registerUploadTool(server);
  registerDownloadTool(server);
  registerListServersTool(server);
  registerFileIoTools(server);
  registerAgentTools(server);
  registerMaintenanceTools(server);
}
