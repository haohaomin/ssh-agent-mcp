import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ActivityMonitor} from '../build/services/activity-monitor.js';

test('restored job tracking waits for an explicit connection before polling remote status', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'activity-offline-'));
  const previous=process.env.SSH_AGENT_STATE_DIR; process.env.SSH_AGENT_STATE_DIR=root;
  let connected=false, polls=0;
  const manager={getAllServerInfos:()=>[{name:'fixture',host:'fixture',port:22,username:'test',connected}],getConfig:()=>({}),getDefaultConnectionName:()=> 'fixture',isManuallyDisconnected:()=>false,
    jobStatus:async()=>{polls++;return '[state] exited\n[exit code] 0\ncompleted';}};
  let monitor=new ActivityMonitor(manager);
  try {
    const id=monitor.log.start('ssh_job_start','mcp',{},'fixture');
    monitor.log.update(id,{jobId:'job-offline',status:'running'});monitor.close();
    monitor=new ActivityMonitor(manager);
    await monitor.poll();assert.equal(polls,0);assert.equal(monitor.log.get(id).status,'running');
    connected=true;await monitor.poll();assert.equal(polls,1);assert.equal(monitor.log.get(id).status,'succeeded');
  } finally {monitor.close();if(previous===undefined)delete process.env.SSH_AGENT_STATE_DIR;else process.env.SSH_AGENT_STATE_DIR=previous;fs.rmSync(root,{recursive:true,force:true});}
});

test('same-name terminal replacement keeps new output out of the previous activity record', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'activity-replacement-'));
  const previous=process.env.SSH_AGENT_STATE_DIR; process.env.SSH_AGENT_STATE_DIR=root;
  const manager={getAllServerInfos:()=>[{name:'fixture',host:'fixture',port:22,username:'test'}],getConfig:()=>({})};
  const monitor=new ActivityMonitor(manager);
  let identity='instance-1', output='old output', reads=0, replaceDuringRead=false;
  monitor.sessions={
    instanceIdentity:()=>identity, connectionName:()=> 'fixture',
    read:async()=>{reads++;if(replaceDuringRead){identity='instance-3';output='third output';}return {closed:false};},
    transcript:()=>({totalBytes:output.length,output}),
  };
  try {
    monitor.observe('', 'ssh_session_start', {sessionName:'terminal'}, {});
    await monitor.poll();
    const first=monitor.log.list()[0];assert.equal(first.output,'old output');
    identity='instance-2';output='new output';
    monitor.observe('', 'ssh_session_start', {sessionName:'terminal'}, {});
    monitor.observe('', 'ssh_session_write', {sessionName:'terminal'}, {});
    assert.equal(monitor.log.list().length,2);
    await monitor.poll();
    assert.equal(monitor.log.get(first.id).status,'interrupted');
    assert.equal(monitor.log.get(first.id).output,'old output');
    const second=monitor.log.list()[1];assert.equal(second.output,'new output');
    replaceDuringRead=true;await monitor.poll();
    assert.equal(monitor.log.get(second.id).status,'interrupted');
    assert.equal(monitor.log.get(second.id).output,'new output');
    const legacy=monitor.log.start('session_output','monitor',{sessionName:'terminal'},'fixture');
    const before=reads;await monitor.poll();
    assert.equal(reads,before);assert.equal(monitor.log.get(legacy).status,'interrupted');
  } finally {monitor.close();if(previous===undefined)delete process.env.SSH_AGENT_STATE_DIR;else process.env.SSH_AGENT_STATE_DIR=previous;fs.rmSync(root,{recursive:true,force:true});}
});
