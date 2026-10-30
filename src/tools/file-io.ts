import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SSHConnectionManager } from '../services/ssh-connection-manager.js';
import { RemoteFiles } from '../services/remote-files.js';
import { toToolError } from '../utils/tool-error.js';
import { connectionName, remotePath } from './common.js';
function errorResult(error: unknown) {
  const e = toToolError(error, 'UNKNOWN_ERROR');
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ code: e.code, message: e.message, retriable: e.retriable }) }] };
}
function result(value: unknown) { return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] }; }
export function registerFileIoTools(server: McpServer): void {
  const manager = SSHConnectionManager.getInstance(), files = new RemoteFiles(manager);
  server.registerTool('ssh_file_read', {
    description: 'Read UTF-8 text over SFTP. Select bytes for byte pagination, or lines for numbered lines (up to 4 MiB).',
    inputSchema: { remotePath, connectionName, format: z.enum(['bytes','lines']).default('bytes'),
      offsetBytes: z.number().int().nonnegative().optional(), maxBytes: z.number().int().positive().max(4*1024*1024).optional(),
      startLine: z.number().int().positive().optional(), lineCount: z.number().int().positive().max(2000).optional() }
  }, async a => {
    try {
      if (a.format === 'lines') {
        if (a.offsetBytes !== undefined || a.maxBytes !== undefined) throw new Error('Byte parameters require format=bytes');
        return result(await files.view(a.remotePath, a.startLine ?? 1, a.lineCount ?? 200, a.connectionName));
      }
      if (a.startLine !== undefined || a.lineCount !== undefined) throw new Error('Line parameters require format=lines');
      return result(await manager.readFile(a.remotePath, { offset: a.offsetBytes, length: a.maxBytes }, a.connectionName));
    } catch(e) { return errorResult(e); }
  });
  server.registerTool('ssh_file_write', {
    description: 'Write UTF-8 text using mode=create (exclusive, default), overwrite, or append. Parent directory must exist. For an existing local file, use ssh_upload(localPath, remotePath) without reading its contents into the conversation.',
    inputSchema: { remotePath, connectionName, content: z.string().max(4*1024*1024), mode: z.enum(['create','overwrite','append']).default('create'), permissions: z.number().int().min(0).max(0o777).optional() }
  }, async a => {
    try {
      if (!a.mode || a.mode === 'create') return result(await files.create(a.remotePath, a.content, a.connectionName, a.permissions));
      return result(await manager.writeFile(a.remotePath, a.content, { append: a.mode === 'append', mode: a.permissions }, a.connectionName));
    } catch(e) { return errorResult(e); }
  });
  server.registerTool('ssh_directory_list', {
    description: 'List a remote directory via SFTP without downloading file contents. Does not traverse subdirectories.',
    inputSchema: { remotePath, connectionName, includeHidden: z.boolean().default(false), maxResults: z.number().int().positive().max(2000).default(200) }
  }, async a => {
    try { return result(await files.list(a.remotePath, a.includeHidden, a.maxResults, a.connectionName)); }
    catch(e) { return errorResult(e); }
  });
}
