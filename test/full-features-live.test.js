import {spawn} from 'node:child_process';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {localSshd} from './helpers/local-sshd.js';
import {SSHConnectionManager} from '../build/services/ssh-connection-manager.js';
import {RemoteFiles} from '../build/services/remote-files.js';
import {importOpenSsh} from '../build/utils/openssh-import.js';
import {DurableSessions} from '../build/services/durable-sessions.js';

test('native config + certificate authentication, SFTP, regex and atomic edits against real sshd',{timeout:30000},async t=>{
  const fixture=await localSshd(t),manager=SSHConnectionManager.getInstance();
  // Disable raw key authorization: this test must authenticate with the signed certificate.
  fs.writeFileSync(path.join(fixture.root,'user.pub'),'');
  const imported=importOpenSsh(fixture.clientConfig);assert.equal(imported.configs.fixture.backend,'openssh');
  manager.setConfig({fixture:{...imported.configs.fixture,allowedRemotePaths:[fixture.root],allowedLocalPaths:[fixture.root],pty:false}});manager.scheduleStatusCollection=()=>{};t.after(()=>manager.disconnect());
  assert.match(await manager.executeCommand('printf native-ok',undefined,'fixture'),/native-ok/);
  const files=new RemoteFiles(manager),file=path.join(fixture.root,'text.txt');await files.create(file,'before\nHello 123\nafter\n','fixture');
  const found=await files.search(fixture.root,'hello \\d+','grep',100,'fixture',[],{regex:true,ignoreCase:true,contextBefore:1,contextAfter:1,filePattern:'*.txt'});
  assert.equal(found.results.length,3);assert.equal(found.results[1].match,true);
  await files.edit(file,[{oldText:'Hello 123',newText:'updated'}],'fixture');assert.match(fs.readFileSync(file,'utf8'),/updated/);
});
test('rsync over ssh2 bridge: preview, real delta transfer, deletion and download',{timeout:30000},async t=>{
  const fixture=await localSshd(t),manager=SSHConnectionManager.getInstance();manager.setConfig({fixture:fixture.config});manager.scheduleStatusCollection=()=>{};t.after(()=>manager.disconnect());
  const files=new RemoteFiles(manager),local=path.join(fixture.root,'local'),remote=path.join(fixture.root,'remote');fs.mkdirSync(local);fs.mkdirSync(remote);
  fs.writeFileSync(path.join(local,'large'),Buffer.alloc(2*1024*1024,65));fs.writeFileSync(path.join(remote,'obsolete'),'delete');
  const options={engine:'rsync',deleteExtra:true,compress:false};
  await files.sync(local+'/',remote+'/','upload',true,'fixture',[],options);assert.ok(fs.existsSync(path.join(remote,'obsolete')));
  await files.sync(local+'/',remote+'/','upload',false,'fixture',[],options);assert.ok(!fs.existsSync(path.join(remote,'obsolete')));assert.ok(fs.existsSync(path.join(remote,'large')));
  const fd=fs.openSync(path.join(local,'large'),'r+');fs.writeSync(fd,Buffer.from('B'),0,1,1024);fs.closeSync(fd);const next=Date.now()/1000+4;fs.utimesSync(path.join(local,'large'),next,next);
  const transfer=await files.sync(local+'/',remote+'/','upload',false,'fixture',[],options);assert.match(transfer.output,/Matched data:\s*[1-9]/i);assert.equal(fs.readFileSync(path.join(remote,'large'))[1024],66);
  fs.writeFileSync(path.join(remote,'new'),'download');await files.sync(local+'/',remote+'/','download',false,'fixture',[],{engine:'rsync'});assert.equal(fs.readFileSync(path.join(local,'new'),'utf8'),'download');
});
test('detached terminal survives MCP manager restart and preserves full transcript',{timeout:30000},async t=>{
  const fixture=await localSshd(t),previous=process.env.SSH_AGENT_STATE_DIR;process.env.SSH_AGENT_STATE_DIR=path.join(fixture.root,'state');
  const manager=SSHConnectionManager.getInstance();manager.setConfig({fixture:fixture.config});manager.scheduleStatusCollection=()=>{};
  let sessions=new DurableSessions(manager);let started=false,workerPid;
  t.after(async()=>{if(started){await sessions.stop('durable').catch(()=>{});if(workerPid){try{process.kill(workerPid,'SIGTERM');}catch{}}}manager.disconnect();if(previous===undefined)delete process.env.SSH_AGENT_STATE_DIR;else process.env.SSH_AGENT_STATE_DIR=previous;});
  const code = `import {SSHConnectionManager} from './build/services/ssh-connection-manager.js';import {DurableSessions} from './build/services/durable-sessions.js';let input='';for await(const chunk of process.stdin)input+=chunk;const {config,cwd}=JSON.parse(input);const manager=SSHConnectionManager.getInstance();manager.setConfig({fixture:config});const sessions=new DurableSessions(manager);const result=await sessions.start('durable','fixture',false,{cwd});console.log(JSON.stringify(result));`;
  const first=await new Promise((resolve,reject)=>{const parent=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['pipe','pipe','pipe']});let output='',error='';parent.stdout.on('data',b=>output+=b);parent.stderr.on('data',b=>error+=b);parent.on('error',reject);parent.on('close',status=>status===0?resolve(JSON.parse(output)):reject(new Error(error)));parent.stdin.end(JSON.stringify({config:fixture.config,cwd:fixture.root}));});started=true;workerPid=first.pid;
  await sessions.write('durable','export SAVED_VALUE=preserved\n');await delay(100);
  manager.disconnect();manager.setConfig({fixture:fixture.config});sessions=new DurableSessions(manager);
  const reused=await sessions.start('durable','fixture',true);assert.equal(reused.pid,first.pid);assert.equal(reused.reused,true);
  await sessions.write('durable','printf "value=%s\\n" "$SAVED_VALUE"\n');
  let log;for(let i=0;i<200;i++){log=sessions.transcript('durable');if(log.output.includes('value=preserved'))break;await delay(20);}
  assert.match(log.output,/value=preserved/);assert.equal(fs.statSync(log.logPath).mode&0o777,0o600);
  await sessions.stop('durable');started=false;assert.match(sessions.transcript('durable').output,/value=preserved/);
});
test('native ProxyCommand and Match exec are deferred until connection; both forwarding directions work',{timeout:30000},async t=>{
  const net=await import('node:net');
  const fixture=await localSshd(t),manager=SSHConnectionManager.getInstance(),marker=path.join(fixture.root,'matched');
  const proxy=path.join(fixture.root,'proxy.cjs');fs.writeFileSync(proxy,`const net=require('node:net');const socket=net.connect(Number(process.argv[3]),process.argv[2]);socket.on('error',()=>process.exit(1));process.stdin.pipe(socket).pipe(process.stdout);`);
  const config=fs.readFileSync(fixture.clientConfig,'utf8').replace('Match host 127.0.0.1',` ProxyCommand "${process.execPath}" "${proxy}" %h %p\nMatch exec "touch ${marker}"`);fs.writeFileSync(fixture.clientConfig,config);
  const imported=importOpenSsh(fixture.clientConfig);assert.ok(!fs.existsSync(marker));manager.setConfig(imported.configs);manager.scheduleStatusCollection=()=>{};t.after(()=>manager.disconnect());
  await manager.connect('fixture');assert.ok(fs.existsSync(marker));
  const echo=net.createServer(socket=>{socket.on('error',()=>{});socket.pipe(socket);});await new Promise(r=>echo.listen(0,'127.0.0.1',r));t.after(()=>echo.close());
  const roundtrip=port=>new Promise((resolve,reject)=>{const socket=net.connect(port,'127.0.0.1',()=>socket.write('native'));socket.setTimeout(5000,()=>socket.destroy(new Error('timeout')));socket.on('error',reject);socket.once('data',b=>{socket.destroy();resolve(b.toString());});});
  const forward=await manager.interactive.forward('127.0.0.1',echo.address().port,0,'fixture');assert.equal(await roundtrip(forward.localPort),'native');manager.interactive.stopForward(forward.forwardId);
  const reverse=await manager.interactive.reverseForward('127.0.0.1',echo.address().port,0,'fixture');assert.equal(await roundtrip(reverse.remotePort),'native');manager.interactive.stopForward(reverse.forwardId);
});
