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
