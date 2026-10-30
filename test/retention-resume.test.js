import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID,randomBytes} from 'node:crypto';
import {cleanupExecLogs} from '../build/services/exec-log-retention.js';
import {withResourceLock} from '../build/utils/resource-lock.js';
import {SSHConnectionManager} from '../build/services/ssh-connection-manager.js';
import {transferRemoteFile} from '../build/services/remote-transfer.js';
import {localSshd} from './helpers/local-sshd.js';
import {importOpenSsh} from '../build/utils/openssh-import.js';

test('exec retention previews then deletes only expired/over-budget regular UUID logs',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'retention-')),prev=process.env.SSH_AGENT_STATE_DIR;process.env.SSH_AGENT_STATE_DIR=root;
 t.after(()=>{if(prev===undefined)delete process.env.SSH_AGENT_STATE_DIR;else process.env.SSH_AGENT_STATE_DIR=prev;fs.rmSync(root,{recursive:true,force:true});});
 const dir=path.join(root,'exec-output');fs.mkdirSync(dir);
 const old=path.join(dir,randomUUID()+'.log'),recent=path.join(dir,randomUUID()+'.log'),newest=path.join(dir,randomUUID()+'.log');
 for(const f of [old,recent,newest])fs.writeFileSync(f,'1234567890');fs.utimesSync(old,0,0);fs.utimesSync(recent,new Date(Date.now()-1000),new Date(Date.now()-1000));
 const outside=path.join(root,'outside');fs.writeFileSync(outside,'protected');const link=path.join(dir,randomUUID()+'.log');fs.symlinkSync(outside,link);fs.writeFileSync(path.join(dir,'user.log'),'protected');
 const preview=cleanupExecLogs({maxAgeDays:7,maxTotalBytes:10});assert.equal(preview.candidates.length,2);assert(fs.existsSync(old));
 const done=cleanupExecLogs({maxAgeDays:7,maxTotalBytes:10,dryRun:false});assert.equal(done.deleted.length,2);assert(fs.existsSync(newest));assert(fs.lstatSync(link).isSymbolicLink());assert.equal(fs.readFileSync(outside,'utf8'),'protected');
 assert.equal(cleanupExecLogs({maxAgeDays:0,maxTotalBytes:0,dryRun:false,protectPath:newest}).deleted.length,0);
 fs.rmSync(dir,{recursive:true});fs.symlinkSync(root,dir);assert.throws(()=>cleanupExecLogs(),/real directory/);
});
test('lock keys are validated and commands are passed as shell literals',()=>{
 assert.throws(()=>withResourceLock('id','../escape'),/resourceKey/);const wrapped=withResourceLock("printf 'x'; exit 3",'deployment:api');assert.match(wrapped,/flock -n -E 75/);assert(!wrapped.includes('deployment:api'));assert.equal(withResourceLock('id'),'id');
});
for(const backend of ['ssh2','openssh'])test(`verified resume and retained partials (${backend})`,{timeout:30000},async t=>{
 const clean=[],f=await localSshd({after(fn){clean.push(fn);}}),m=SSHConnectionManager.getInstance();const c=backend==='ssh2'?f.config:{...importOpenSsh(f.clientConfig).configs.fixture,allowedRemotePaths:[f.root],pty:false};m.setConfig({a:c,b:{...c}});
 t.after(async()=>{m.disconnect();for(const fn of clean.reverse())await fn();});
 const source=path.join(f.root,'source'),target=path.join(f.root,'target'),data=randomBytes(1024*1024);fs.writeFileSync(source,data);
 const id=randomUUID(),temp=path.join(f.root,'.ssh-mcp-transfer-'+id);fs.writeFileSync(temp,data.subarray(0,123456),{mode:0o600});
 const args={sourceConnectionName:'a',destinationConnectionName:'b',sourcePath:source,destinationPath:target,transferId:id};
 const result=await transferRemoteFile(m,args);assert.equal(result.resumedBytes,123456);assert(fs.readFileSync(target).equals(data));assert(!fs.existsSync(temp));
 fs.writeFileSync(temp,'wrong prefix');await assert.rejects(transferRemoteFile(m,{...args,overwrite:true}),/differs from source/);assert.equal(fs.readFileSync(temp,'utf8'),'wrong prefix');assert(fs.readFileSync(target).equals(data));
 fs.unlinkSync(temp);fs.symlinkSync(source,temp);await assert.rejects(transferRemoteFile(m,{...args,overwrite:true}),/regular file/);assert(fs.lstatSync(temp).isSymbolicLink());fs.unlinkSync(temp);
 // A timeout leaves an explicit resumable identity rather than claiming success.
 let failure;try{await transferRemoteFile(m,{...args,transferId:undefined,resumable:true,timeoutMs:1});}catch(e){failure=e;}
 assert(failure);assert(failure.transferId);assert.equal(failure.resumable,true);assert(fs.readFileSync(target).equals(data));
});
