import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {localSshd} from './helpers/local-sshd.js';
import {SSHConnectionManager} from '../build/services/ssh-connection-manager.js';
import {DurableSessions} from '../build/services/durable-sessions.js';
import {importOpenSsh} from '../build/utils/openssh-import.js';

async function until(check){for(let n=0;n<100;n++){if(await check())return;await delay(20);}assert.fail('condition not reached');}
test('destroying a native forwarding channel terminates its ssh subprocess', {timeout:15000}, async t=>{
  const fixture=await localSshd(t),manager=SSHConnectionManager.getInstance();
  manager.setConfig(importOpenSsh(fixture.clientConfig).configs);manager.scheduleStatusCollection=()=>{};t.after(()=>manager.disconnect());
  await manager.connect('fixture');
  const channel=await new Promise((resolve,reject)=>manager.getClient('fixture').forwardOut('127.0.0.1',0,'127.0.0.1',fixture.port,(e,c)=>e?reject(e):resolve(c)));
  const ended=once(channel.child,'close');channel.destroy();
  assert.equal(channel.child.killed,true,'destroy must terminate the native SSH child');await ended;
});
test('restarting a naturally closed session retires its original worker', {timeout:20000}, async t=>{
  const fixture=await localSshd(t),manager=SSHConnectionManager.getInstance(),previous=process.env.SSH_AGENT_STATE_DIR;
  process.env.SSH_AGENT_STATE_DIR=path.join(fixture.root,'state');manager.setConfig({fixture:fixture.config});
  const sessions=new DurableSessions(manager);let first;const workers=[];
  t.after(async()=>{await sessions.stop('reopen').catch(()=>{});for(const pid of workers){try{process.kill(pid,'SIGTERM');}catch{}}manager.disconnect();if(previous===undefined)delete process.env.SSH_AGENT_STATE_DIR;else process.env.SSH_AGENT_STATE_DIR=previous;});
  first=await sessions.start('reopen','fixture');workers.push(first.pid);await sessions.write('reopen','exit\n');await until(async()=> (await sessions.read('reopen')).closed);
  const second=await sessions.start('reopen','fixture',true);workers.push(second.pid);assert.notEqual(first.pid,second.pid);
  await until(()=>{try{process.kill(first.pid,0);return false;}catch{return true;}});
  await sessions.stop('reopen');
});
test('reverse forwarding cleans up safely after the SSH connection closes', {timeout:15000}, async t=>{
  const fixture=await localSshd(t),manager=SSHConnectionManager.getInstance();
  manager.setConfig({fixture:fixture.config});manager.scheduleStatusCollection=()=>{};t.after(()=>manager.disconnect());
  await manager.interactive.reverseForward('127.0.0.1',fixture.port,0,'fixture');
  const client=manager.getClient('fixture');const closed=once(client,'close');client.end();await closed;
  assert.deepEqual(manager.interactive.listForwards(),[]);
});
