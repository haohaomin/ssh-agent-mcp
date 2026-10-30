import {z} from 'zod';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {SSHConnectionManager} from '../services/ssh-connection-manager.js';
import {transferRemoteFile} from '../services/remote-transfer.js';
import {toToolError} from '../utils/tool-error.js';
export function registerTransferTool(server:McpServer) {
  server.registerTool('ssh_file_transfer',{
    description:'Copy one regular file between two SSH connections through a bounded, backpressured SFTP relay. No local file or file-content tool output. resumable retains partials; retry with transferId verifies the full prefix before appending. Only one writer may own a transferId. Verify destination SHA-256 before atomic publication. Default refuses overwrite; requires OpenSSH hardlink extension (or posix-rename with overwrite=true). A client timeout does not prove publication failed: inspect the destination before retrying.',
    inputSchema:{sourceConnectionName:z.string().min(1),sourcePath:z.string().min(1),destinationConnectionName:z.string().min(1),destinationPath:z.string().min(1),
      resumable:z.boolean().default(false).describe('Retain partial temporary file on failure for verified retry'),transferId:z.string().uuid().optional().describe('Retry an interrupted transfer with the same endpoints/paths; verifies the complete existing prefix before append. Requires exclusive ownership of the partial file.'),
      overwrite:z.boolean().default(false),maxBytes:z.number().int().positive().max(1024*1024*1024).default(256*1024*1024),timeoutMs:z.number().int().positive().max(240000).default(60000)},
  },async args=>{
    try{const result=await transferRemoteFile(SSHConnectionManager.getInstance(),args);return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};}
    catch(error){const e=toToolError(error,'SFTP_ERROR');const failure={code:e.code,message:e.message,retriable:e.retriable};return {isError:true,content:[{type:'text',text:JSON.stringify(failure)}],structuredContent:{error:failure,...('transferId' in e ? {transferId:e.transferId,temporaryPath:(e as any).temporaryPath,resumable:(e as any).resumable,publication:(e as any).publication,nextAction:(e as any).nextAction}: {})}};}
  });
}
