import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {localSshd} from './helpers/local-sshd.js';
import {SSHConnectionManager} from '../build/services/ssh-connection-manager.js';
import {DurableSessions} from '../build/services/durable-sessions.js';
import {importOpenSsh} from '../build/utils/openssh-import.js';

async function until(check){for(let n=0;n<100;n++){if(await check())return;await delay(50);}assert.fail('tmux condition not reached');}
async function setup(t,backend){
  const fixture=await localSshd(t),manager=SSHConnectionManager.getInstance();
  const config=backend==='ssh2'?fixture.config:importOpenSsh(fixture.clientConfig).configs.fixture;
  manager.setConfig({fixture:config});
  const previous={TMUX:process.env.TMUX,TMUX_TMPDIR:process.env.TMUX_TMPDIR,SSH_AGENT_STATE_DIR:process.env.SSH_AGENT_STATE_DIR};
  // Separate tmux server, with no personal tmux configuration or existing user sessions.
  const tmp=fs.mkdtempSync('/tmp/ssh-tmux-test-');fs.chmodSync(tmp,0o700);
  delete process.env.TMUX;process.env.TMUX_TMPDIR=tmp;process.env.SSH_AGENT_STATE_DIR=path.join(tmp,'state');
  execFileSync('tmux',['-f','/dev/null','new-session','-d','-s','test-keeper'],{stdio:'pipe'});
  const sessions=new DurableSessions(manager);const workers=[];
  t.after(()=>{for(const pid of workers){try{process.kill(pid,'SIGTERM');}catch{}}spawnSync('tmux',['kill-server']);manager.disconnect();fs.rmSync(tmp,{recursive:true,force:true});for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  return {fixture,sessions,workers};
}
for(const backend of ['ssh2','openssh'])test(`real tmux observer displays output, reuses pane, and closes on stop (${backend})`,{timeout:20000},async t=>{
  const {fixture,sessions,workers}=await setup(t,backend);
  const first=await sessions.start('observed','fixture',false,{observerMode:'tmux',cwd:fixture.root});workers.push(first.pid);
  assert.equal(first.observer.mode,'tmux');const target=first.observer.attachCommand.split(' ').at(-1);
  const pane=execFileSync('tmux',['display-message','-p','-t',target,'#{pane_id}'],{encoding:'utf8'}).trim();
  await sessions.write('observed','printf "TMUX_%s\\n" "真实观察"\n');
  await until(()=>execFileSync('tmux',['capture-pane','-p','-t',target],{encoding:'utf8'}).includes('TMUX_真实观察'));
  const reopened=new DurableSessions(SSHConnectionManager.getInstance());
  const reused=await reopened.start('observed','fixture',true,{observerMode:'tmux'});assert.equal(reused.pid,first.pid);assert.equal(reused.observer.mode,'tmux');
  assert.equal(execFileSync('tmux',['display-message','-p','-t',target,'#{pane_id}'],{encoding:'utf8'}).trim(),pane);
  await sessions.stop('observed');assert.notEqual(spawnSync('tmux',['has-session','-t',target]).status,0);
  assert.match(sessions.transcript('observed').output,/TMUX_真实观察/);
});
for(const backend of ['ssh2','openssh'])test(`autoClose removes the tmux observer when the remote shell exits (${backend})`,{timeout:20000},async t=>{
  const {sessions,workers}=await setup(t,backend);
  const first=await sessions.start('auto','fixture',false,{observerMode:'tmux',autoClose:true});workers.push(first.pid);
  assert.equal(first.observer.mode,'tmux');const target=first.observer.attachCommand.split(' ').at(-1);
  await sessions.write('auto','exit\n');
  await until(()=>{try{process.kill(first.pid,0);return false;}catch{return true;}});
  assert.notEqual(spawnSync('tmux',['has-session','-t',target]).status,0,'observer must not survive autoClose');
});
