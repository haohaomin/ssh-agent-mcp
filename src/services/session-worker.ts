import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { SSHConnectionManager } from './ssh-connection-manager.js';
import { configHash, writeSessionMeta, type SessionMeta } from './durable-sessions.js';
process.once('message',async({sessionName,connectionName,config,options,paths}:any)=>{
  const manager=SSHConnectionManager.getInstance();const key=connectionName||'default';manager.setConfig({[key]:config});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ssh-session-'));fs.chmodSync(directory,0o700);const socketPath=path.join(directory,'socket');
  let server:net.Server|undefined;
  let cleaned=false;
  const cleanup=()=>{
    if(cleaned)return;cleaned=true;
    // The parent adds observer metadata after startup. Read it back instead of
    // overwriting it with the worker's original snapshot on shutdown.
    try {
      const latest=JSON.parse(fs.readFileSync(paths.meta,'utf8')) as SessionMeta;
      if(latest.pid===process.pid){
        if(latest.observerSession)spawnSync('tmux',['kill-session','-t',latest.observerSession],{timeout:5000});
        writeSessionMeta(paths.meta,{...latest,closed:true});
      }
    }catch{}
    manager.disconnect();server?.close();fs.rmSync(directory,{recursive:true,force:true});
  };
  process.on('SIGTERM',()=>{cleanup();process.exit(0);});process.on('SIGINT',()=>{cleanup();process.exit(0);});
  try{
    const info=await manager.interactive.start(sessionName,key,false,{...options,logPath:paths.log});
    const meta:SessionMeta={sessionName,connectionName,configHash:configHash(config),socketPath,logPath:paths.log,pid:process.pid,startedAt:new Date().toISOString()};
    writeSessionMeta(paths.meta,meta);
    server=net.createServer(socket=>{socket.setEncoding('utf8');let data='';socket.on('error',()=>{});socket.setTimeout(15000,()=>socket.destroy());socket.on('data',chunk=>{
      data+=chunk.toString();if(data.length>1024*1024){socket.destroy();return;}const at=data.indexOf('\n');if(at<0)return;socket.removeAllListeners('data');
      let stop=false;
      try {const {method,args}=JSON.parse(data.slice(0,at));let result:unknown;
        if(method==='info')result=manager.interactive.list().find(s=>s.sessionName===sessionName);
        else if(method==='read')result=manager.interactive.read(sessionName,args.offset,args.maxChars);
        else if(method==='write')result=manager.interactive.write(sessionName,args.input);
        else if(method==='stop'){result=manager.interactive.stop(sessionName);stop=true;}
        else throw new Error('Unknown session operation');
        socket.end(JSON.stringify({result})+'\n',()=>{if(stop){cleanup();process.exit(0);}});
      }catch(e){socket.end(JSON.stringify({error:(e as Error).message})+'\n');}
    });});
    await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(socketPath,resolve);});fs.chmodSync(socketPath,0o600);
    if(options.autoClose)setInterval(()=>{const current=manager.interactive.list().find(s=>s.sessionName===sessionName);if(!current||current.closed){cleanup();process.exit(0);}},1000).unref();
    process.send?.({result:{...(info as object),...meta}});
  }catch(e){cleanup();process.send?.({error:(e as Error).message},()=>process.exit(1));}
});
