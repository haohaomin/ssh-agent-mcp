import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {installRedactionValues,loadRedactionValues,redactText,redactValue,RedactionStream} from '../build/utils/output-redaction.js';
import {OpenSshDiagnostics} from '../build/utils/openssh-diagnostics.js';
import {SSHConnectionManager} from '../build/services/ssh-connection-manager.js';
import {RemoteFiles} from '../build/services/remote-files.js';
import {registerAllTools} from '../build/tools/index.js';
import {ActivityLog} from '../build/services/activity-log.js';
import {importOpenSsh} from '../build/utils/openssh-import.js';
import {shellQuote} from '../build/utils/shell.js';
import {localSshd} from './helpers/local-sshd.js';

test('exact redaction handles JSON escaping, long prefixes, all chunk boundaries and incomplete stream endings',()=>{
  const secret='test-'+randomUUID()+'\n"escaped"';
  installRedactionValues([secret,JSON.stringify(secret).slice(1,-1), 'prefix-short', 'prefix-short-and-long']);
  try{
    assert.equal(redactText('before '+secret+' after'),'before [REDACTED] after');
    assert.equal(JSON.parse(redactText(JSON.stringify({message:secret}))).message,'[REDACTED]');
    assert.deepEqual(redactValue({a:[secret]}),{a:['[REDACTED]']});
    for(const value of [secret,'prefix-short-and-long'])for(let i=0;i<=value.length;i++){
      const stream=new RedactionStream();
      const output=stream.write('before '+value.slice(0,i))+stream.write(value.slice(i)+' after')+stream.finishMasked();
      assert.equal(output,'before [REDACTED] after',`split ${i}`);
    }
    const stream=new RedactionStream();assert.equal(stream.write('before '+secret.slice(0,10)),'before ');assert.equal(stream.finishMasked(),'[REDACTED]');
    assert.equal(redactText('ok '+secret.slice(0,10),true),'ok [REDACTED]');
    installRedactionValues(['x'.repeat(65000)+'y']);
    assert.equal(redactText('x'.repeat(65000),true),'[REDACTED]');
  }finally{installRedactionValues([]);}
});

test('redaction config fails closed and only reads administrator-supplied local sources',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'redaction-config-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const secret='fixture-'+randomUUID(),file=path.join(root,'secret');fs.writeFileSync(file,secret+'\n',{mode:0o600});
  assert.ok(loadRedactionValues({a:{redactLocalFiles:[file]}}).includes(secret));
  for(const config of [{redactLocalFiles:['relative']},{redactLocalFiles:[root]},{redactLocalFiles:[file+'-missing']},{redactEnv:['MISSING_TEST_REDACTION_ENV']},{redactLocalFiles:'bad'}])assert.throws(()=>loadRedactionValues({a:config}));
  const manager=SSHConnectionManager.getInstance();manager.setConfig({a:{host:'localhost',username:'test',redactLocalFiles:[file]}});
  assert.throws(()=>manager.reloadConfig({b:{host:'localhost',redactLocalFiles:[file+'-missing']}}));
  assert.equal(manager.getConfig('a').host,'localhost');assert.equal(redactText(secret),'[REDACTED]');
  manager.setConfig({});
});

test('OpenSSH diagnostics: exact native close line only, UTF-8 split and huge stderr lines preserved',async()=>{
  const filter=new OpenSshDiagnostics(),diagnostics=[];let output='';filter.on('diagnostic',d=>diagnostics.push(d));filter.on('data',b=>output+=b.toString());
  filter.write(Buffer.from('immediate-progress'));assert.equal(output,'immediate-progress');filter.write(Buffer.from('\n'));output='';
  const input='warning: 保留\nShared connection to test.example closed.\r\nuser says Shared connection to test.example closed.\n'+ 'x'.repeat(3000)+'Shared connection to test.example closed.\nPermission denied\n';
  for(const byte of Buffer.from(input))filter.write(Buffer.from([byte]));
  await new Promise(resolve=>filter.end(resolve));
  assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].kind,'shared_connection_closed');
  assert.equal(output,input.replace('Shared connection to test.example closed.\r\n',''));
});

for(const backend of ['ssh2','openssh'])test(`real SSH: inode editing, fanout failure isolation, redacted output/logs (${backend})`,{timeout:60000},async t=>{
  // Reverse teardown order: close clients before removing the SSH fixture.
  const clean=[];const fixture=await localSshd({after:fn=>clean.push(fn)}), manager=SSHConnectionManager.getInstance();
  const oldState=process.env.SSH_AGENT_STATE_DIR;process.env.SSH_AGENT_STATE_DIR=path.join(fixture.root,'state');
  const secret='synthetic-'+randomUUID(),file=path.join(fixture.root,'test-secret');fs.writeFileSync(file,secret,{mode:0o600});
  const config={...(backend==='ssh2'?fixture.config:importOpenSsh(fixture.clientConfig).configs.fixture),pty:false,commandTemplate:`export HOME=${shellQuote(fixture.root)}; <command>`,allowedRemotePaths:[fixture.root],redactLocalFiles:[file]};
  manager.setConfig({a:config,b:config});manager.scheduleStatusCollection=()=>{};
  const definitions=new Map();registerAllTools({registerTool(name,meta,fn){definitions.set(name,{meta,fn});}});
  const invoke=(name,args)=>{const {meta,fn}=definitions.get(name);return fn(z.object(meta.inputSchema||{}).parse(args));};
  const files=new RemoteFiles(manager);
  try{
    const target=path.join(fixture.root,'config.txt'),observer=target+'.mounted';fs.writeFileSync(target,'old content with long tail\n');fs.linkSync(target,observer);
    const inode=fs.statSync(target).ino,edits=[{oldText:'old content with long tail\n',newText:'new\n'}];
    const preview=await files.edit(target,edits,'a',{dryRun:true,writeMode:'inPlace'});
    await assert.rejects(files.edit(target,edits,'a',{writeMode:'inPlace'}),/expectedSha256/);
    await assert.rejects(files.edit(target,edits,'a',{writeMode:'inPlace',expectedSha256:'0'.repeat(64)}),/hash differs/);
    const edited=await files.edit(target,edits,'a',{writeMode:'inPlace',expectedSha256:preview.beforeSha256});
    assert.equal(edited.atomic,false);assert.equal(edited.inodePreserved,true);assert.equal(fs.statSync(target).ino,inode);
    assert.equal(fs.readFileSync(observer,'utf8'),'new\n');assert.equal(fs.readFileSync(edited.backupPath,'utf8'),'old content with long tail\n');assert.equal(fs.statSync(edited.backupPath).mode&0o777,0o600);
    // Empty files truncate through the same handle; the atomic default replaces the inode.
    const beforeEmpty=await files.readText(target,'a');await files.replace(target,'',beforeEmpty.sha256,'a',{writeMode:'inPlace'});assert.equal(fs.statSync(target).size,0);assert.equal(fs.statSync(target).ino,inode);
    const empty=await files.readText(target,'a');await files.replace(target,'atomic',empty.sha256,'a');assert.notEqual(fs.statSync(target).ino,inode);assert.equal(fs.readFileSync(observer,'utf8'),'');

    const batch=await invoke('ssh_exec_many',{targets:['a','missing','b'],steps:['printf per-host','false'],concurrency:2,maxTotalBytes:120});
    assert.equal(batch.isError,true);assert.equal(batch.structuredContent.failed,3);assert.deepEqual(batch.structuredContent.results.map(r=>r.connectionName),['a','missing','b']);
    assert.deepEqual(batch.structuredContent.results.map(r=>r.exitCode),[1,null,1]);assert.equal(batch.structuredContent.results[1].started,false);
    const success=await invoke('ssh_exec_many',{targets:['b','a'],script:'printf ok',concurrency:1});assert.equal(success.structuredContent.succeeded,2);
    const omitted=await invoke('ssh_exec',{command:'true'});assert.equal(omitted.isError,true);assert.equal(omitted.structuredContent.started,false);

    const response=await invoke('ssh_exec',{connectionName:'a',script:'cat "$KEY_FILE"; printf "\\n"; cat "$KEY_FILE" >&2; printf "\\n"; printf "%01000d" 0',env:{KEY_FILE:file},maxBytes:64});
    assert.ok(!JSON.stringify(response).includes(secret));assert.equal(response.structuredContent.exitCode,0);
    const full=fs.readFileSync(response.structuredContent.fullOutputPath,'utf8');assert.ok(full.includes('[REDACTED]'));assert.ok(!full.includes(secret));
    assert.equal(fs.statSync(response.structuredContent.fullOutputPath).mode&0o777,0o600);
    const editor=await files.readText(file,'a');assert.equal(editor.redacted,true);assert.equal(editor.content,'[REDACTED]');
    await assert.rejects(files.replace(file,editor.content,editor.sha256,'a'),/whole-file replacement/);assert.equal(fs.readFileSync(file,'utf8'),secret);
    const read=await invoke('ssh_file_read',{connectionName:'a',remotePath:file});assert.ok(!JSON.stringify(read).includes(secret));
    const page=await invoke('ssh_file_read',{connectionName:'a',remotePath:file,offsetBytes:8,maxBytes:10});assert.ok(page.content[0].text.endsWith('[REDACTED]'));assert.ok(!page.content[0].text.includes(secret.slice(8,18)));
    const job=await invoke('ssh_job_start',{connectionName:'a',command:`cat '${file}'`});
    const jobId=job.structuredContent.jobId;let status;
    for(let i=0;i<100;i++){status=(await invoke('ssh_job_status',{connectionName:'a',jobId})).structuredContent;if(status.state==='exited')break;await delay(20);}
    assert.equal(status.state,'exited');assert.ok(status.output.includes('[REDACTED]'));assert.ok(!status.output.includes(secret));
    const jobPage=await invoke('ssh_job_status',{connectionName:'a',jobId,offsetBytes:8,maxBytes:10});assert.ok(!jobPage.isError);assert.equal(jobPage.structuredContent.nextOffsetBytes,18);assert.ok(jobPage.structuredContent.output.endsWith('[REDACTED]'));
    const jobTail=await manager.jobStatus(jobId,{tailBytes:10,maxBytes:10},'a');assert.ok(jobTail.endsWith('[REDACTED]'));
    // Cumulative live frames must never publish a partial prefix or the final secret.
    const log=new ActivityLog(path.join(fixture.root,'activity'),()=>[]),frames=[];log.subscribe(e=>frames.push(JSON.stringify(e)));
    await log.run('ssh_exec','mcp',{},'a',async()=>{const report=log.outputReporter();for(let i=1;i<=secret.length;i++)report(secret.slice(0,i));return {output:secret};});
    assert.ok(frames.every(frame=>!frame.includes(secret)));assert.ok(!JSON.stringify(log.list()).includes(secret));log.close();
    // Terminal output and its on-disk transcript use a stateful redactor before append.
    const transcript=path.join(fixture.root,'terminal.log');await manager.interactive.start('redaction','a',false,{logPath:transcript});
    manager.interactive.write('redaction',`cat '${file}'; printf '\\nEND_MARKER\\n'\n`);
    let terminal='';for(let i=0;i<200;i++){terminal=manager.interactive.read('redaction').output;if(terminal.includes('[REDACTED]'))break;await delay(20);}
    assert.ok(terminal.includes('[REDACTED]'));assert.ok(!terminal.includes(secret));assert.ok(!fs.readFileSync(transcript,'utf8').includes(secret));manager.interactive.stop('redaction');
    // A native PTY produces a real multiplexing close diagnostic on stderr.
    if(backend==='openssh'){
      manager.reloadConfig({a:{...config,pty:true},b:config});
      const native=await invoke('ssh_exec',{connectionName:'a',command:'printf native-ok'});
      assert.ok(!native.structuredContent.output.includes('Shared connection'));
      assert.ok(native.structuredContent.transportDiagnostics.some(d=>d.kind==='shared_connection_closed'));
    }
  }finally{
    manager.disconnect();manager.setConfig({});await delay(100);
    if(oldState===undefined)delete process.env.SSH_AGENT_STATE_DIR;else process.env.SSH_AGENT_STATE_DIR=oldState;
    for(const cleanup of clean.reverse())await cleanup();
  }
});

test('fanout enforces concurrency, ordered results and per-target budgets without retry',async()=>{
  const manager=SSHConnectionManager.getInstance(),original=manager.executeCommandDetailed;
  const config={host:'localhost',username:'test'};manager.setConfig(Object.fromEntries(['one','two','three','four'].map(n=>[n,config])));
  const definitions=new Map();registerAllTools({registerTool(name,meta,fn){definitions.set(name,{meta,fn});}});
  const {meta,fn}=definitions.get('ssh_exec_many');const schema=z.object(meta.inputSchema);
  assert.throws(()=>schema.parse({targets:['one','one'],command:'true'}));assert.throws(()=>schema.parse({targets:['one'],command:'true',concurrency:9}));assert.throws(()=>schema.parse({command:'true'}));
  let active=0,peak=0;const budgets=[],calls=[];
  manager.executeCommandDetailed=async(_cmd,_cwd,name,options)=>{
    active++;peak=Math.max(peak,active);calls.push(name);budgets.push(options.maxBytes);
    await delay(name==='one'?30:5);active--;
    return {connectionName:name,completed:true,exitCode:0,error:null,output:'ok',fullOutputPath:null};
  };
  try{
    const result=await fn(schema.parse({targets:['one','two','three','four'],command:'true',concurrency:2,maxTotalBytes:100,maxBytes:1000}));
    assert.equal(peak,2);assert.deepEqual(calls,['one','two','three','four']);assert.deepEqual(budgets,[25,25,25,25]);assert.deepEqual(result.structuredContent.results.map(r=>r.connectionName),calls);
  }finally{manager.executeCommandDetailed=original;manager.setConfig({});}
});
