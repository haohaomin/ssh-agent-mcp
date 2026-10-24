import { fileURLToPath } from 'node:url';
import { shellQuote } from '../utils/shell.js';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { IPty } from 'node-pty';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import type { SSHConfig } from '../models/types.js';
const require=createRequire(import.meta.url);
class ProcessChannel extends Duplex {
  stderr: NodeJS.ReadableStream;
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    super({emitClose:false});this.stderr=child.stderr;
    child.stdout.on('data',data=>{if(!this.push(data))child.stdout.pause();});child.stdout.on('end',()=>this.push(null));
    child.stdin.on('error',error=>this.destroy(error));
    child.on('error',error=>this.destroy(error));
    child.on('close',(code,signal)=>{this.emit('exit',code,signal||undefined);this.emit('close',code,signal||undefined);});
  }
  _read(){this.child.stdout.resume();}
  _write(chunk:Buffer,_encoding:BufferEncoding,callback:(e?:Error|null)=>void){this.child.stdin.write(chunk,callback);}
  _final(callback:()=>void){this.child.stdin.end();callback();}
  _destroy(error:Error|null,callback:(error?:Error|null)=>void){
    this.child.kill('SIGTERM');
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    callback(error);
  }
  close(){this.destroy();}
  signal(signal:string){this.child.kill(signal as NodeJS.Signals);}
}
class PtyChannel extends Duplex {
  stderr = new PassThrough();
  private decoder = new StringDecoder('utf8');
  private exited = false;
  constructor(private terminal: IPty) {
    super({emitClose:false});
    terminal.onData(data => { if(!this.push(data))terminal.pause(); });
    terminal.onExit(({exitCode,signal}) => {
      this.exited=true;this.stderr.end();this.push(null);
      this.emit('exit',exitCode,signal);this.emit('close',exitCode,signal);
    });
  }
  _read(){this.terminal.resume();}
  _write(chunk:Buffer,_encoding:BufferEncoding,callback:(error?:Error|null)=>void){
    try{this.terminal.write(this.decoder.write(chunk));callback();}catch(error){callback(error as Error);}
  }
  _destroy(error:Error|null,callback:(error?:Error|null)=>void){if(!this.exited){try{this.terminal.kill();}catch{}}callback(error);}
  close(){this.destroy();}
  setWindow(rows:number,cols:number){this.terminal.resize(cols,rows);}
}
/** ssh2-shaped adapter: native SSH owns authentication/config, SFTPStream owns file protocol. */
export class OpenSshClient extends EventEmitter {
  private dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssh-agent-native-'));
  private socket=path.join(this.dir,'control');
  private master?: ChildProcessWithoutNullStreams;
  private children=new Set<ChildProcessWithoutNullStreams>();
  private terminals=new Set<IPty>();
  private forwards=new Map<number,{server:net.Server;channels:Set<Duplex>}>();
  private ended=false;
  constructor(private config:SSHConfig){super();fs.chmodSync(this.dir,0o700);}
  private get target(){return this.config.nativeTarget||this.config.host;}
  private args(extra:string[]=[]){
    const args=['-S',this.socket,'-o',this.config.password||this.config.passphrase?'BatchMode=no':'BatchMode=yes','-o','ControlMaster=no'];
    if(this.config.nativeConfigFile)args.push('-F',this.config.nativeConfigFile);
    return [...args,...(this.config.nativeOptions||[]),...extra,'--',this.target];
  }
  private environment(){
    const askpass = path.join(this.dir, 'askpass');
    if(this.config.password||this.config.passphrase) fs.writeFileSync(askpass, '#!/bin/sh\nexec '+shellQuote(process.execPath)+' '+shellQuote(fileURLToPath(new URL('../cli/native-askpass.js',import.meta.url)))+' "$@"\n',{mode:0o700});
    return {...process.env,...((this.config.password||this.config.passphrase)?{SSH_ASKPASS:askpass,SSH_ASKPASS_REQUIRE:'force',DISPLAY:'ssh-agent',SSH_AGENT_NATIVE_PASSWORD:this.config.password,SSH_AGENT_NATIVE_PASSPHRASE:this.config.passphrase}:{}),...(this.config.agent?{SSH_AUTH_SOCK:this.config.agent}:{})};
  }
  private run(args:string[]){
    const child=spawn(process.env.SSH_MCP_SSH_BIN||'ssh',args,{stdio:'pipe',env:this.environment()});this.children.add(child);child.once('close',()=>this.children.delete(child));return child;}
  connect(){
    this.master=this.run(this.args(['-M','-N','-o','ControlMaster=yes','-o','ControlPersist=no']));
    let stderr='';this.master.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-8192);});
    this.master.on('error',error=>this.emit('error',error));
    let ready=false;
    const timer=setInterval(()=>{
      if(this.ended){clearInterval(timer);return;}
      if(fs.existsSync(this.socket))execFile(process.env.SSH_MCP_SSH_BIN||'ssh',this.args(['-O','check']),{timeout:1000},error=>{
        if(!error&&!ready&&!this.ended){ready=true;clearInterval(timer);this.emit('ready');}
      });
    },50);
    this.master.once('close',()=>{clearInterval(timer);if(!ready&&!this.ended)this.emit('error',new Error(`OpenSSH connection failed: ${stderr}`));this.emit('close');});
    return this;
  }
  exec(command:string, options:any, callback:any){
    const child=this.run([...this.args([options?.pty?'-tt':'-T','-o','RemoteCommand=none']),command]);
    const channel=new ProcessChannel(child);callback(undefined,channel);
  }
  shell(options:any,callback:any){
    try{
      const pty=require('node-pty') as typeof import('node-pty');
      const terminal=pty.spawn(process.env.SSH_MCP_SSH_BIN||'ssh',this.args(['-tt']),{name:options?.term||'xterm-256color',cols:options?.cols||120,rows:options?.rows||30,env:this.environment(),encoding:null});
      this.terminals.add(terminal);terminal.onExit(()=>this.terminals.delete(terminal));
      callback(undefined,new PtyChannel(terminal));
    }catch(error){callback(error);}
  }
  sftp(callback:any){
    // Isolated adapter to ssh2's pinned SFTP protocol implementation; channel transport is a native ssh subprocess.
    const {SFTP}=require('ssh2/lib/protocol/SFTP.js');
    const child=this.run([...this.args(['-T','-o','RemoteCommand=none','-s']),'sftp']);let called=false;
    const protocol=new SFTP({_protocol:{_remoteIdentRaw:'SSH-2.0-OpenSSH',channelData:(_id:number,data:Buffer)=>child.stdin.write(data),channelClose:()=>child.stdin.end()}},{type:'session',incoming:{id:0,window:Infinity,packetSize:32768,state:'open'},outgoing:{id:0,window:Infinity,packetSize:32768,state:'open'}});
    const finish=(error?:Error)=>{if(called)return;called=true;callback(error,error?undefined:protocol);};
    protocol.on('ready',()=>finish());protocol.on('error',(e:Error)=>finish(e));child.on('error',finish);
    let stderr='';child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-4096);});
    child.on('close',()=>{finish(new Error(`SFTP closed: ${stderr}`));protocol.push(null);protocol.emit('close');});
    child.stdout.on('data',data=>protocol.push(data));
    protocol._init();
  }

  forwardOut(_host:string,_port:number,remoteHost:string,remotePort:number,callback:any){
    const child=this.run(this.args(['-W',`${remoteHost.includes(':')?'['+remoteHost+']':remoteHost}:${remotePort}`]));callback(undefined,new ProcessChannel(child));
  }
  forwardIn(bindHost:string,port:number,callback:any){
    // Let OpenSSH expose its remote forward to a private loopback listener that emits ssh2-style channels.
    const channels=new Set<Duplex>();
    const listener=net.createServer(socket=>{channels.add(socket);socket.on('error',()=>{});socket.on('close',()=>channels.delete(socket));this.emit('tcp connection',{destPort:assigned},()=>socket,()=>socket.destroy());});
    let assigned=port;
    listener.once('error',callback);listener.listen(0,'127.0.0.1',()=>{
      const localPort=(listener.address() as net.AddressInfo).port;
      execFile(process.env.SSH_MCP_SSH_BIN||'ssh',this.args(['-O','forward','-R',`${bindHost}:${port}:127.0.0.1:${localPort}`]),{timeout:10000},(error,stdout)=>{
        if(error){listener.close();callback(error);return;}
        if(port===0)assigned=Number(stdout.trim());
        this.forwards.set(assigned,{server:listener,channels});callback(undefined,assigned);
      });
    });
  }
  unforwardIn(bindHost:string,port:number,callback:any){
    const entry=this.forwards.get(port);if(!entry){callback();return;}
    const localPort=(entry.server.address() as net.AddressInfo)?.port;
    execFile(process.env.SSH_MCP_SSH_BIN||'ssh',this.args(['-O','cancel','-R',`${bindHost}:${port}:127.0.0.1:${localPort}`]),{timeout:10000},error=>{entry.server.close();for(const c of entry.channels)c.destroy();this.forwards.delete(port);callback(error);});
  }
  end(){if(this.ended)return;this.ended=true;for(const e of this.forwards.values()){e.server.close();for(const c of e.channels)c.destroy();}for(const child of this.children)child.kill();for(const terminal of this.terminals){try{terminal.kill();}catch{}}fs.rmSync(this.dir,{recursive:true,force:true});}
  destroy(){this.end();}
}
