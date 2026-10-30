import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {localSshd} from './helpers/local-sshd.js';
import {SSHConnectionManager} from '../build/services/ssh-connection-manager.js';
import {registerAllTools} from '../build/tools/index.js';
import {importOpenSsh} from '../build/utils/openssh-import.js';
import {toToolError,ToolError} from '../build/utils/tool-error.js';
import {shellQuote} from '../build/utils/shell.js';

function toolsFor(manager){const tools={};registerAllTools({registerTool(n,c,h){tools[n]=a=>h(z.object(c.inputSchema||{}).parse(a));}});return tools;}
test('multiple hosts fail closed before any network access; explicit targets and one-host defaults resolve',async t=>{
 const m=SSHConnectionManager.getInstance(),c={host:'127.0.0.1',port:1,username:'fixture'};
 m.setConfig({a:c,b:c});t.after(()=>m.disconnect());let calls=0;
 t.mock.method(m,'executeCommand',async()=>{calls++;return 'ok';});
 const tools=toolsFor(m);
 for(const name of ['ssh_exec','ssh_job_start','ssh_server_disconnect']){const r=await tools[name]({command:'id'});assert(r.isError);assert.equal(r.structuredContent.error.code,'CONNECTION_REQUIRED');}
 assert.equal(calls,0);
 assert.equal((await tools.ssh_exec({command:'id',connectionName:'b'})).structuredContent.connectionName,'b');
 assert.equal((await tools.ssh_exec({command:'id',connectionName:'missing'})).structuredContent.error.code,'CONNECTION_NOT_FOUND');
 m.setConfig({a:c});assert.equal((await tools.ssh_exec({command:'id'})).structuredContent.connectionName,'a');
});
test('error-like objects keep diagnostic fields without serializing request secrets',()=>{
 const e=toToolError({message:'connect failed',code:'ECONNRESET',level:'client-socket',request:{password:'never-output'}},'SSH_CONNECTION_FAILED');
 assert.match(e.message,/ECONNRESET/);assert(!e.message.includes('never-output'));assert(!e.message.includes('[object Object]'));
});
test('ambiguous job start returns the generated ID for status inspection',async t=>{
 const m=SSHConnectionManager.getInstance();m.setConfig({a:{host:'127.0.0.1',port:1,username:'fixture'}});t.after(()=>m.disconnect());
 t.mock.method(m,'runJobScript',async()=>{throw new ToolError('COMMAND_TIMEOUT','channel timed out',true);});
 const r=await toolsFor(m).ssh_job_start({script:'echo started'});assert(r.isError);assert.match(r.structuredContent.jobId,/^job-/);assert.equal(r.structuredContent.state,'unknown');
});

for(const backend of ['ssh2','openssh']) test(`operational workflows over SSH (${backend})`,{timeout:60000},async t=>{
 const cleanups=[],a=await localSshd({after(f){cleanups.push(f);}}),b=await localSshd({after(f){cleanups.push(f);}}),m=SSHConnectionManager.getInstance();
 t.after(async()=>{m.disconnect();for(const clean of cleanups.reverse())await clean();});
 const cfg=f=>({...backend==='ssh2'?f.config:importOpenSsh(f.clientConfig).configs.fixture,allowedRemotePaths:[f.root],pty:false,commandTemplate:`export HOME=${shellQuote(f.root)}; <command>`});
 m.setConfig({a:cfg(a),b:cfg(b)});const tools=toolsFor(m);
 const call=async(name,args)=>{const r=await tools[name](args);assert(!r.isError,JSON.stringify(r));return r.structuredContent;};
 await t.test('Python job keeps quotes/env and survives connection loss, status ignores log claims',async()=>{
   const r=await call('ssh_job_start',{connectionName:'a',script:'import os,time\ntime.sleep(0.2)\nprint("[state] running")\nprint(os.environ["VALUE"])\nraise SystemExit(7)',interpreter:'python3',env:{VALUE:"中文 '$HOME'"}});
   m.disconnect();let status;
   for(let i=0;i<60;i++){status=await call('ssh_job_status',{connectionName:'a',jobId:r.jobId});if(status.state==='exited')break;await delay(20);}
   assert.equal(status.state,'exited');assert.equal(status.exitCode,7);assert.match(status.output,/中文 '\$HOME'/);assert(status.nextOffsetBytes>0);
   assert.equal(fs.statSync(path.join(a.root,'.ssh-mcp-jobs',r.jobId,'cmd')).mode&0o777,0o600);
   const end=await call('ssh_job_status',{connectionName:'a',jobId:r.jobId,offsetBytes:status.nextOffsetBytes});assert.equal(end.offsetBytes,end.nextOffsetBytes);
 });
 await t.test('shell job failFast stops later steps and invalid python options fail early',async()=>{
   const r=await call('ssh_job_start',{connectionName:'a',script:'false | true\nprintf should-not-run',failFast:true});let s;
   for(let i=0;i<50;i++){s=await call('ssh_job_status',{connectionName:'a',jobId:r.jobId});if(s.state==='exited')break;await delay(20);}
   assert.equal(s.exitCode,1);assert(!s.output.includes('should-not-run'));
   assert((await tools.ssh_job_start({connectionName:'a',script:'print(1)',interpreter:'python3',failFast:false})).isError);
 });
 await t.test('binary cross-host transfer verifies content; no overwrite and atomic overwrite work',async()=>{
   const source=path.join(a.root,'binary'),target=path.join(b.root,'copy'),data=randomBytes(35*1024*1024);fs.writeFileSync(source,data);
   const args={sourceConnectionName:'a',sourcePath:source,destinationConnectionName:'b',destinationPath:target};
   const r=await call('ssh_file_transfer',args);assert.equal(r.sha256,createHash('sha256').update(data).digest('hex'));assert.equal(r.bytes,data.length);assert(fs.readFileSync(target).equals(data));
   fs.writeFileSync(source,'replacement');assert((await tools.ssh_file_transfer(args)).isError);assert(fs.readFileSync(target).equals(data));
   await call('ssh_file_transfer',{...args,overwrite:true});assert.equal(fs.readFileSync(target,'utf8'),'replacement');
   assert(!fs.readdirSync(b.root).some(n=>n.startsWith('.ssh-mcp-transfer-')));
   assert((await tools.ssh_file_transfer({...args,maxBytes:1})).isError);
   const link=path.join(b.root,'escape');fs.symlinkSync('/etc/passwd',link);
   assert((await tools.ssh_file_transfer({...args,destinationPath:link,overwrite:true})).isError);
 });
 await t.test('timeout and checksum corruption leave the original destination unchanged',async()=>{
   const source=path.join(a.root,'large'),target=path.join(b.root,'retained');fs.writeFileSync(source,randomBytes(2*1024*1024));fs.writeFileSync(target,'original');
   const args={sourceConnectionName:'a',sourcePath:source,destinationConnectionName:'b',destinationPath:target,overwrite:true};
   const timed=await tools.ssh_file_transfer({...args,timeoutMs:1});assert(timed.isError);assert.equal(fs.readFileSync(target,'utf8'),'original');
   const original=m.withSftp.bind(m);
   m.withSftp=(name,work)=>original(name,sftp=>{
     if(name==='b'){const read=sftp.createReadStream.bind(sftp);sftp.createReadStream=(file,...args)=>{fs.appendFileSync(file,'corrupted');return read(file,...args);};}
     return work(sftp);
   });
   try{const corrupted=await tools.ssh_file_transfer(args);assert(corrupted.isError);assert.match(corrupted.content[0].text,/SHA-256/);assert.equal(fs.readFileSync(target,'utf8'),'original');}
   finally{m.withSftp=original;}
   assert(!fs.readdirSync(b.root).some(n=>n.startsWith('.ssh-mcp-transfer-')));
 });
 await t.test('restricted endpoints refuse cross-host transfer',async()=>{
   m.setConfig({a:cfg(a),b:{...b.config,executionPolicy:{mode:'actions-only',actions:{}}}});
   const r=await tools.ssh_file_transfer({sourceConnectionName:'a',sourcePath:path.join(a.root,'binary'),destinationConnectionName:'b',destinationPath:path.join(b.root,'denied')});
   assert(r.isError);assert.equal(r.structuredContent.error.code,'EXECUTION_POLICY_DENIED');
 });
});
