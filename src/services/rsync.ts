import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { shellQuote } from '../utils/shell.js';
import type { SSHConnectionManager } from './ssh-connection-manager.js';
export type SyncOptions = { deleteExtra?: boolean; compress?: boolean; preservePermissions?: boolean; timeoutMs?: number; extraArgs?: string[] };
export async function rsyncTransfer(manager: SSHConnectionManager, localPath: string, remotePath: string, direction: 'upload'|'download', dryRun: boolean, name?: string, exclude: string[] = [], options: SyncOptions = {}) {
  const local = manager.validateLocalPath(localPath,name,direction==='upload'?'read':'write');
  const remote = manager.validateRemotePath(remotePath,name);
  const config = manager.getConfig(name);
  if (config.commandWhitelist?.length || config.commandBlacklist?.length) throw new Error('Rsync requires a connection allowing the remote rsync server command; use SFTP sync for command-filtered connections');
  await manager.connect(name);
  const client = manager.getClient(name);
  // Canonicalize an existing path, or its parent for a new target, before invoking rsync.
  await manager.withSftp(name, sftp => new Promise<void>((resolve,reject)=> {
    sftp.realpath(remote,(error,real)=> {
      if (!error) {try{manager.validateRemotePath(real,name);resolve();}catch(e){reject(e);}return;}
      if (direction==='download') {reject(error);return;}
      sftp.realpath(path.posix.dirname(remote),(e,parent)=>{if(e){reject(e);return;}try{manager.validateRemotePath(parent,name);resolve();}catch(e){reject(e);}});
    });
  }));
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ssh-rsync-'));await fs.chmod(dir,0o700);
  const socketPath=path.join(dir,'bridge.sock'); const sockets=new Set<net.Socket>(); const channels=new Set<any>();
  const server=net.createServer(socket=>{
    sockets.add(socket); socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    let buffer='',channel:any; let initialized=false;
    socket.on('data',chunk=>{
      buffer+=chunk.toString('utf8'); if(buffer.length>2*1024*1024){socket.destroy();return;}
      let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
        let data:any;try{data=JSON.parse(line);}catch{socket.destroy();return;}
        if(!initialized){
          initialized=true;
          if(!Array.isArray(data.command)||data.command[0]!=='rsync'||!data.command.includes('--server')){socket.destroy();return;}
          // rsync supplies already shell-quoted remote arguments. The bridge is private to this operation.
          client.exec(data.command.join(' '),{pty:false},(error,stream)=>{
            if(error){socket.end(JSON.stringify({error:error.message})+'\n');return;}
            channel=stream;channels.add(stream);
            const send=(packet:unknown)=>socket.write(JSON.stringify(packet)+'\n');
            stream.on('data',(b:Buffer)=>send({stdout:b.toString('base64')}));
            stream.stderr.on('data',(b:Buffer)=>send({stderr:b.toString('base64')}));
            stream.on('error',(e:Error)=>send({error:e.message}));
            stream.on('close',(code:number)=>{channels.delete(stream);socket.end(JSON.stringify({exit:code??1})+'\n');});
            socket.on('close',()=>stream.close());send({ready:true});
          });
        }else if(channel){ if(data.stdin)channel.write(Buffer.from(data.stdin,'base64'));if(data.end)channel.end(); }
      }
    });
  });
  try {
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});await fs.chmod(socketPath,0o600);
    const bridge=fileURLToPath(new URL('../cli/rsync-bridge.js',import.meta.url));
    const args=['-a','--stats','--itemize-changes','--no-whole-file','-e',`${shellQuote(process.execPath)} ${shellQuote(bridge)} ${shellQuote(socketPath)}`];
    if(options.preservePermissions===false)args.push('--no-perms');
    if(options.compress!==false)args.push('-z');
    if(dryRun)args.push('--dry-run');if(options.deleteExtra)args.push('--delete-after');
    for(const item of exclude)args.push('--exclude',item);
    // Do not permit transport/server overrides or arbitrary positional arguments.
    for(const flag of options.extraArgs||[]) {if(!/^--(?:checksum|size-only|ignore-existing|existing|update|prune-empty-dirs|numeric-ids|times|perms|links|hard-links|verbose|progress|bwlimit=\d+)$/.test(flag))throw new Error(`Unsupported extra rsync option: ${flag}`);args.push(flag);}
    const remoteArg=`remote:${shellQuote(remote + (remotePath.endsWith('/') && !remote.endsWith('/') ? '/' : ''))}`;
    const localArg=local + (localPath.endsWith(path.sep) && !local.endsWith(path.sep) ? path.sep : '');
    args.push('--',...(direction==='upload'?[localArg,remoteArg]:[remoteArg,localArg]));
    const output=await new Promise<string>((resolve,reject)=>{
      const child=spawn(process.env.SSH_MCP_RSYNC_BIN||'rsync',args,{stdio:['ignore','pipe','pipe']});let out='',settled=false;
      const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(out);};
      const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('Rsync timed out'));},options.timeoutMs??300000);
      const collect=(b:Buffer)=>{out+=b.toString();if(out.length>4*1024*1024){child.kill('SIGKILL');finish(new Error('Rsync output limit exceeded'));}};
      child.stdout.on('data',collect);child.stderr.on('data',collect);child.on('error',finish);child.on('close',code=>finish(code===0?undefined:new Error(`Rsync exit ${code}: ${out}`)));
    });
    return {direction,dryRun,engine:'rsync',deletesFiles:!!options.deleteExtra,output};
  } finally {for(const c of channels)c.close();for(const s of sockets)s.destroy();server.close();await fs.rm(dir,{recursive:true,force:true});}
}
