import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerMaintenanceTools } from '../build/tools/maintenance.js';
import { DurableSessions, sessionPaths, writeSessionMeta } from '../build/services/durable-sessions.js';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';
import { CommandLineParser } from '../build/cli/command-line-parser.js';
import { localSshd } from './helpers/local-sshd.js';

test('closed session log cleanup is dry-run by default and removes only when requested', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ssh-maintenance-'));const previous=process.env.SSH_AGENT_STATE_DIR;process.env.SSH_AGENT_STATE_DIR=root;
  t.after(()=>{if(previous===undefined)delete process.env.SSH_AGENT_STATE_DIR;else process.env.SSH_AGENT_STATE_DIR=previous;fs.rmSync(root,{recursive:true,force:true});});
  const paths=sessionPaths('closed');fs.writeFileSync(paths.log,'old output');writeSessionMeta(paths.meta,{sessionName:'closed',configHash:'x',socketPath:path.join(root,'missing.sock'),logPath:paths.log,pid:2147483647,startedAt:'2000-01-01T00:00:00.000Z',closed:true});
  const manager=SSHConnectionManager.getInstance();manager.setConfig({fixture:{host:'127.0.0.1',port:1,username:'fixture'}});t.after(()=>manager.disconnect());
  const sessions=new DurableSessions(manager);
  const empty=sessionPaths('starting');fs.writeFileSync(empty.lock,'');await assert.rejects(sessions.start('starting'),/starting or being cleaned/);assert.ok(fs.existsSync(empty.lock));
  const preview=await sessions.cleanup({maxAgeDays:0});assert.equal(preview.dryRun,true);assert.deepEqual(preview.candidates.map(item=>item.sessionName),['closed']);assert.ok(fs.existsSync(paths.log));
  const deleted=await sessions.cleanup({maxAgeDays:0,dryRun:false});assert.deepEqual(deleted.deleted,['closed']);assert.equal(fs.existsSync(paths.meta),false);assert.equal(fs.existsSync(paths.log),false);
});

test('diagnostics redact credentials from successes and failures; reload uses startup source', async t => {
  const manager=SSHConnectionManager.getInstance();
  const original={getConfig:manager.getConfig,reloadFromSource:manager.reloadFromSource,connect:manager.connect,withSftp:manager.withSftp};
  t.after(()=>Object.assign(manager,original));
  manager.getConfig=()=>({host:'example.test',port:22,username:'ops',password:'secret',privateKey:'/tmp/private-key',backend:'ssh2'});
  manager.connect=async()=>{};
  manager.withSftp=async(_name,operation)=>operation({readdir(_path,callback){callback(null,[]);}});
  manager.reloadFromSource=()=>({added:['fixture'],changed:[],removed:[],preserved:[]});
  const tools={};registerMaintenanceTools({registerTool(name,_meta,handler){tools[name]=handler;}});
  const diagnosis=JSON.parse((await tools.ssh_server_diagnose({connectionName:'fixture'})).content[0].text);
  assert.equal(diagnosis.ok,true);assert.equal(JSON.stringify(diagnosis).includes('secret'),false);assert.equal(JSON.stringify(diagnosis).includes('private-key'),false);
  const reload=await tools.ssh_config_reload({});assert.equal(JSON.parse(reload.content[0].text).changes.added[0],'fixture');
  manager.connect=async()=>{throw new Error('secret /tmp/private-key');};
  const failed=JSON.parse((await tools.ssh_server_diagnose({connectionName:'fixture'})).content[0].text);
  assert.equal(failed.ok,false);assert.equal(failed.checks.sftp.skipped,true);assert.doesNotMatch(JSON.stringify(failed),/secret|private-key/);
  manager.reloadFromSource=()=>{throw new Error('secret invalid JSON');};
  const bad=await tools.ssh_config_reload({});assert.equal(bad.isError,true);assert.doesNotMatch(bad.content[0].text,/secret/);
});

test('reload is atomic on invalid patterns and preserves defaults and equivalent configurations', t => {
  const manager=SSHConnectionManager.getInstance();t.after(()=>manager.disconnect());
  const config={host:'example.test',port:22,username:'ops',password:'fake',commandWhitelist:['^ls$']};
  manager.setConfig({stable:config,removed:config},'stable');
  assert.throws(()=>manager.reloadConfig({stable:{...config,commandWhitelist:['[']}}));
  assert.equal(manager.getConfig('stable'),config);
  const next=Object.fromEntries(Object.entries(config).reverse());
  assert.deepEqual(manager.reloadConfig({stable:next,added:config}),{added:['added'],changed:[],removed:['removed'],preserved:['stable']});
  assert.equal(manager.getDefaultConnectionName(),'stable');
});

test('reload re-reads OpenSSH selection and retains CLI policy; broken import keeps old configuration', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ssh-reload-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'config');fs.writeFileSync(file,'Host chosen\n HostName first.test\nHost ignored\n HostName ignored.test\n');
  const args=['--import-ssh-config','--ssh-config-file',file,'--host','chosen','--password','fake','--whitelist','^ls$','--allowed-remote-paths','/srv'];
  const manager=SSHConnectionManager.getInstance();t.after(()=>manager.disconnect());
  manager.setConfig(CommandLineParser.parseArgs(args).configs);manager.setConfigLoader(()=>CommandLineParser.parseArgs(args,true).configs);
  fs.writeFileSync(file,'Host chosen\n HostName second.test\nHost ignored\n HostName ignored.test\n');
  assert.deepEqual(manager.reloadFromSource().changed,['chosen']);
  assert.deepEqual(manager.getAllServerInfos().map(item=>item.name),['chosen']);
  assert.equal(manager.getConfig().host,'second.test');assert.deepEqual(manager.getConfig().commandWhitelist,['^ls$']);assert.deepEqual(manager.getConfig().allowedRemotePaths,['/srv']);
  fs.writeFileSync(file,'Host chosen\n Port invalid\n');assert.throws(()=>manager.reloadFromSource());assert.equal(manager.getConfig().host,'second.test');
});

test('reload retains real unchanged clients and old close events do not evict replacements', {timeout:15000}, async t => {
  const fixture=await localSshd(t),manager=SSHConnectionManager.getInstance();
  manager.setConfig({fixture:fixture.config});const schedule=manager.scheduleStatusCollection;manager.scheduleStatusCollection=()=>{};
  t.after(()=>{manager.disconnect();manager.scheduleStatusCollection=schedule;});
  await manager.connect('fixture');const before=manager.getClient('fixture');
  assert.deepEqual(manager.reloadConfig({fixture:{...fixture.config}}).preserved,['fixture']);assert.equal(manager.getClient('fixture'),before);
  manager.reloadConfig({fixture:{...fixture.config,keepaliveIntervalMs:12345}});await manager.connect('fixture');
  const after=manager.getClient('fixture');assert.notEqual(after,before);before.emit('close');assert.equal(manager.getClient('fixture'),after);
  assert.match(await manager.executeCommand('printf restored',undefined,'fixture'),/restored/);
});

test('cleanup respects age and size together, skips live workers, locks and untrusted paths', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ssh-log-cleanup-')),previous=process.env.SSH_AGENT_STATE_DIR;process.env.SSH_AGENT_STATE_DIR=root;
  t.after(()=>{if(previous===undefined)delete process.env.SSH_AGENT_STATE_DIR;else process.env.SSH_AGENT_STATE_DIR=previous;fs.rmSync(root,{recursive:true,force:true});});
  const make=(name,age,bytes,pid=2147483647)=>{const paths=sessionPaths(name);fs.writeFileSync(paths.log,'x'.repeat(bytes));writeSessionMeta(paths.meta,{sessionName:name,logPath:paths.log,socketPath:'/unused',pid,closed:true,configHash:'x',startedAt:'2000-01-01'});const at=Date.now()/1000-age*86400;fs.utimesSync(paths.meta,at,at);fs.utimesSync(paths.log,at,at);return paths;};
  make('old',60,100);make('recent',2,20);make('newest',1,20);const live=make('live',60,100,process.pid);const locked=make('locked',60,100);fs.writeFileSync(locked.lock,String(process.pid));
  const external=path.join(root,'keep.txt');fs.writeFileSync(external,'do not delete');const altered=make('altered',60,100);const meta=JSON.parse(fs.readFileSync(altered.meta));meta.logPath=external;writeSessionMeta(altered.meta,meta);
  const sessions=new DurableSessions(SSHConnectionManager.getInstance());
  const preview=await sessions.cleanup({maxAgeDays:30,maxTotalBytes:30});assert.deepEqual(preview.candidates.map(item=>item.sessionName),['old','recent']);assert.equal(preview.freedBytes,0);assert.equal(preview.reclaimableBytes,120);
  const removed=await sessions.cleanup({maxAgeDays:30,maxTotalBytes:30,dryRun:false});assert.deepEqual(removed.deleted,['old','recent']);assert.equal(removed.freedBytes,120);
  assert.ok(fs.existsSync(live.log));assert.ok(fs.existsSync(locked.log));assert.ok(fs.existsSync(external));assert.ok(fs.existsSync(sessionPaths('newest').log));
});
