import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {Transform, Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {SFTPWrapper, Stats} from 'ssh2';
import type {SSHConnectionManager} from './ssh-connection-manager.js';
import {assertUnrestricted} from '../utils/execution-policy.js';
import {ToolError} from '../utils/tool-error.js';

const stat = (sftp: SFTPWrapper, file: string) => new Promise<Stats>((resolve,reject) => sftp.stat(file,(e,s)=>e?reject(e):resolve(s)));
const remove = (sftp: SFTPWrapper, file: string) => new Promise<void>((resolve,reject)=>sftp.unlink(file,e=>e?reject(e):resolve()));

/** Relay through this process with backpressure; never materialize file bytes as tool output. */
async function transferRemoteFileInternal(manager: SSHConnectionManager, args: {
  sourceConnectionName: string; sourcePath: string; destinationConnectionName: string; destinationPath: string;
  overwrite?: boolean; timeoutMs?: number; maxBytes?: number; resumable?: boolean; transferId?: string;
}) {
  const source = manager.resolveConnectionName(args.sourceConnectionName), destination = manager.resolveConnectionName(args.destinationConnectionName);
  const sourceConfig=manager.getConfig(source), destinationConfig=manager.getConfig(destination);
  assertUnrestricted(sourceConfig,'Cross-host transfer');assertUnrestricted(destinationConfig,'Cross-host transfer');
  return manager.withSftp(source, from=>manager.withSftp(destination,async to=>{
    const input=await manager.resolveRemotePath(from,args.sourcePath,source);
    const target=await manager.resolveRemotePath(to,args.destinationPath,destination,true);
    if(source===destination && input===target) throw new ToolError('COMMAND_VALIDATION_FAILED','Source and destination are the same file');
    if(args.transferId && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(args.transferId))throw new ToolError('COMMAND_VALIDATION_FAILED','Invalid transferId');
    const transferId=args.transferId??randomUUID();
    const resumable=args.resumable||args.transferId!==undefined;
    const temporary=path.posix.join(path.posix.dirname(target),`.ssh-mcp-transfer-${transferId}`);
    await manager.resolveRemotePath(to,temporary,destination,true);
    const info=await stat(from,input);
    const limit=args.maxBytes ?? 256*1024*1024;
    if(!info.isFile() || info.size>limit) throw new ToolError('COMMAND_VALIDATION_FAILED','Source must be a regular file within maxBytes');
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),args.timeoutMs ?? 60000);
    let created=false,published=false,bytes=0,resumedBytes=0;
    const hash=createHash('sha256');
    try {
      if(args.transferId){
        const partial=await new Promise<Stats>((resolve,reject)=>to.lstat(temporary,(e,s)=>e?reject(e):resolve(s)));
        if(!partial.isFile() || partial.size>info.size)throw new Error('Invalid partial file: must be a regular file no larger than source');
        created=true;resumedBytes=partial.size;bytes=resumedBytes;
        if(resumedBytes){
          const prefix=createHash('sha256'),previous=createHash('sha256');
          await pipeline(from.createReadStream(input,{start:0,end:resumedBytes-1}),new Writable({write(chunk,_e,done){prefix.update(chunk);hash.update(chunk);done();}}),{signal:controller.signal});
          await pipeline(to.createReadStream(temporary),new Writable({write(chunk,_e,done){previous.update(chunk);done();}}),{signal:controller.signal});
          if(prefix.digest('hex')!==previous.digest('hex'))throw new Error('Partial file differs from source; refusing to resume');
        }
      }
      // Resume after prefix validation; a new temporary file is always exclusive.
      const output=to.createWriteStream(temporary,{flags:args.transferId?'r+':'wx',start:resumedBytes,mode:0o600});
      output.once('open',()=>{created=true;});
      await pipeline(from.createReadStream(input,{start:resumedBytes}),new Transform({transform(chunk,_encoding,done){
        bytes+=chunk.length;
        if(bytes>limit) return done(new Error('Source exceeded maxBytes during transfer'));
        hash.update(chunk);done(null,chunk);
      }}),output,{signal:controller.signal});
      const digest=hash.digest('hex'), after=await stat(from,input);
      if(bytes!==info.size || after.size!==info.size || after.mtime!==info.mtime) throw new Error('Source changed during transfer');
      const verify=createHash('sha256');let verifiedBytes=0;
      await pipeline(to.createReadStream(temporary),new Writable({write(chunk,_encoding,done){verifiedBytes+=chunk.length;verify.update(chunk);done();}}),{signal:controller.signal});
      if(verifiedBytes!==bytes || verify.digest('hex')!==digest) throw new Error('Destination SHA-256 verification failed');
      controller.signal.throwIfAborted();
      if(manager.getConfig(source)!==sourceConfig || manager.getConfig(destination)!==destinationConfig) throw new Error('Configuration changed during transfer; refusing publication');
      await new Promise<void>((resolve,reject)=>{
        const done=(e?:Error|null)=>e?reject(e):resolve();
        // Both extensions are atomic; lack of support fails instead of weakening guarantees.
        if(args.overwrite) to.ext_openssh_rename(temporary,target,done);
        else to.ext_openssh_hardlink(temporary,target,done);
      });
      published=true;
      let cleanupPending=false;
      if(!args.overwrite) try{await remove(to,temporary);}catch{cleanupPending=true;}
      return {sourceConnectionName:source,destinationConnectionName:destination,sourcePath:input,destinationPath:target,
        transferId,resumedBytes,bytes,sha256:digest,verified:true,published:true,cleanupPending,temporaryPath:cleanupPending?temporary:null};
    } catch(error) {
      let cleanupPending=created;
      if(created&&!published&&!resumable) try{await remove(to,temporary);cleanupPending=false;}catch{}
      const failure=new ToolError(controller.signal.aborted?'OPERATION_TIMEOUT':'SFTP_ERROR',
        `Cross-host transfer failed: ${error instanceof Error?error.message:'unknown transfer error'}. Destination publication ${published?'confirmed':'not confirmed'}${cleanupPending?`; temporary file may remain at ${temporary}`:''}`,false);
      Object.assign(failure,{transferId,temporaryPath:temporary,resumable:!!resumable,publication:'unknown',nextAction:resumable?'Inspect destination; if unpublished, retry same endpoints and paths with this transferId.':'Inspect destination before retrying.'});
      throw failure;
    } finally {clearTimeout(timer);}
  }));
}

const activeDestinations=new Set<string>();
export async function transferRemoteFile(manager:SSHConnectionManager,args:Parameters<typeof transferRemoteFileInternal>[1]) {
  const key=JSON.stringify([args.destinationConnectionName,path.posix.normalize(args.destinationPath)]);
  if(activeDestinations.has(key))throw new ToolError('RESOURCE_BUSY','Another transfer to this destination is active in this service');
  activeDestinations.add(key);
  try{return await transferRemoteFileInternal(manager,args);}finally{activeDestinations.delete(key);}
}
