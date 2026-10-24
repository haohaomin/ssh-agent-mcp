import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { fork, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SSHConnectionManager } from './ssh-connection-manager.js';
export function stateDirectory(){const dir=process.env.SSH_AGENT_STATE_DIR||path.join(os.homedir(),'.local','state','ssh-agent-mcp');fs.mkdirSync(dir,{recursive:true,mode:0o700});return dir;}
function sorted(value:any):any {if(Array.isArray(value))return value.map(sorted);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])]));return value;}
export function writeSessionMeta(file:string,metadata:SessionMeta){const temporary=file+'.'+process.pid+'.tmp';fs.writeFileSync(temporary,JSON.stringify(metadata),{mode:0o600});fs.renameSync(temporary,file);}
export function configHash(config:unknown){return createHash('sha256').update(JSON.stringify(sorted(config))).digest('hex');}
export type SessionMeta={sessionName:string;connectionName?:string;configHash:string;socketPath:string;logPath:string;pid:number;startedAt:string;closed?:boolean;observerSession?:string};
export function sessionPaths(name:string){const id=createHash('sha256').update(name).digest('hex').slice(0,24);const root=stateDirectory();return {meta:path.join(root,id+'.json'),lock:path.join(root,id+'.lock'),log:path.join(root,id+'.log')};}
export function sessionRequest(meta:SessionMeta,method:string,args:any={}):Promise<any>{
  return new Promise((resolve,reject)=>{const socket=net.connect(meta.socketPath);socket.setEncoding('utf8');let data='',done=false;const finish=(error?:Error,result?:unknown)=>{if(done)return;done=true;socket.destroy();error?reject(error):resolve(result);};
    socket.setTimeout(15000,()=>finish(new Error('Session worker timed out')));socket.on('error',finish);
    socket.on('connect',()=>socket.write(JSON.stringify({method,args})+'\n'));
    socket.on('data',chunk=>{data+=chunk.toString();if(data.length>8*1024*1024){finish(new Error('Session response too large'));return;}const at=data.indexOf('\n');if(at>=0){try{const reply=JSON.parse(data.slice(0,at));reply.error?finish(new Error(reply.error)):finish(undefined,reply.result);}catch(e){finish(e as Error);}}});
    socket.on('close',()=>{if(!done)finish(new Error('Session worker closed without a response'));});
  });
}
export class DurableSessions {
  constructor(private manager:SSHConnectionManager){}
  private meta(name:string):SessionMeta {const metadata=JSON.parse(fs.readFileSync(sessionPaths(name).meta,'utf8')) as SessionMeta;
    if(metadata.sessionName!==name||metadata.configHash!==configHash(this.manager.getConfig(metadata.connectionName)))throw new Error('Session connection configuration changed; restore the matching configuration to access this worker');return metadata;}
  async start(sessionName:string,connectionName?:string,ensure=false,options:any={}):Promise<any>{
    const config=this.manager.getConfig(connectionName);
    if(config.commandWhitelist?.length||config.commandBlacklist?.length)throw new Error('Interactive shells require an unrestricted connection');
    const paths=sessionPaths(sessionName);
    if(fs.existsSync(paths.meta)){
      const meta=this.meta(sessionName);
      try {const info=await sessionRequest(meta,'info');if(!info.closed){if(!ensure)throw new Error('Session name already in use');if(meta.connectionName!==connectionName)throw new Error('Session belongs to another connection');return {...info,...meta,reused:true,observer:this.observe(meta,options.observerMode)};}
        // A closed shell can leave its worker alive for log reads; retire it before reusing the name.
        await this.stop(sessionName);
      }
      catch(error){if((error as NodeJS.ErrnoException).code!=='ECONNREFUSED'&&(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    let lock:number;
    try{lock=fs.openSync(paths.lock,'wx',0o600);}catch{const pid=Number(fs.readFileSync(paths.lock,'utf8'));let alive=false;try{if(pid>0){process.kill(pid,0);alive=true;}}catch{}if(!alive){fs.rmSync(paths.lock,{force:true});return this.start(sessionName,connectionName,ensure,options);}throw new Error('Session is starting in another process; retry shortly');}
    fs.writeSync(lock,String(process.pid));fs.closeSync(lock);
    const child=fork(fileURLToPath(new URL('./session-worker.js',import.meta.url)),[],{execArgv:[],detached:true,stdio:['ignore','ignore','ignore','ipc'],env:process.env});
    try {
      const result:any=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{child.kill();reject(new Error('Session startup timed out'));},Math.max(30000,config.connectionTimeoutMs||0)+15000);
        child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Session worker exited during startup'));});
        child.once('message',(message:any)=>{clearTimeout(timer);message.error?reject(new Error(message.error)):resolve(message.result);});
        child.send({sessionName,connectionName,config,options,paths});
      });
      child.disconnect();child.unref();
      result.observer=this.observe(result,options.observerMode);
      return {...result,reused:false};
    }catch(error){child.kill();throw error;}finally{fs.rmSync(paths.lock,{force:true});}
  }
  private observe(meta:SessionMeta,mode?:string){
    if(mode!=='tmux')return {mode:'transcript',logPath:meta.logPath};
    const session='ssh-agent-'+createHash('sha256').update(meta.sessionName).digest('hex').slice(0,16);
    if(meta.observerSession===session && spawnSync('tmux',['has-session','-t',session],{timeout:5000}).status===0)return {mode:'tmux',attachCommand:`tmux attach -t ${session}`,logPath:meta.logPath};
    const observer=spawnSync('tmux',['new-session','-d','-s',session,'tail','-F',meta.logPath],{encoding:'utf8',timeout:5000});
    if(observer.status===0){writeSessionMeta(sessionPaths(meta.sessionName).meta,{...meta,observerSession:session});return {mode:'tmux',attachCommand:`tmux attach -t ${session}`,logPath:meta.logPath};}
    return {mode:'transcript',reason:'tmux unavailable; follow the log file',logPath:meta.logPath};
  }
  async list(){const result=[];for(const file of fs.readdirSync(stateDirectory()).filter(f=>f.endsWith('.json'))){let meta:SessionMeta;try{meta=JSON.parse(fs.readFileSync(path.join(stateDirectory(),file),'utf8'));this.meta(meta.sessionName);}catch{continue;}try{result.push({...await sessionRequest(meta,'info'),...meta});}catch{result.push({...meta,closed:true});}}return result;}
  async read(name:string,offset=0,maxChars=65536){const meta=this.meta(name);try{return await sessionRequest(meta,'read',{offset,maxChars});}catch(e){if(!['ECONNREFUSED','ENOENT'].includes((e as NodeJS.ErrnoException).code||''))throw e;return {...meta,closed:true,logAvailable:fs.existsSync(meta.logPath)};}}
  write(name:string,input:string){return sessionRequest(this.meta(name),'write',{input});}
  async stop(name:string){const meta=this.meta(name);try{return await sessionRequest(meta,'stop');}catch(e){if(!['ECONNREFUSED','ENOENT'].includes((e as NodeJS.ErrnoException).code||''))throw e;writeSessionMeta(sessionPaths(name).meta,{...meta,closed:true});return {stopped:name,logPath:meta.logPath};}finally{if(meta.observerSession)spawnSync('tmux',['kill-session','-t',meta.observerSession],{timeout:5000});}}
  transcript(name:string,offsetBytes=0,maxBytes=65536){this.meta(name);const log=sessionPaths(name).log;const fd=fs.openSync(log,'r');try{const size=fs.fstatSync(fd).size;const buffer=Buffer.alloc(Math.min(maxBytes,Math.max(0,size-offsetBytes)));const read=fs.readSync(fd,buffer,0,buffer.length,offsetBytes);return {sessionName:name,logPath:log,output:buffer.subarray(0,read).toString('utf8'),nextOffsetBytes:offsetBytes+read,totalBytes:size};}finally{fs.closeSync(fd);}}
}
