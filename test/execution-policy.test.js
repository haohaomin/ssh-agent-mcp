import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SSHConnectionManager} from '../build/services/ssh-connection-manager.js';
import {DurableSessions} from '../build/services/durable-sessions.js';
import {RemoteFiles} from '../build/services/remote-files.js';
import {rsyncTransfer} from '../build/services/rsync.js';
import {executionPolicySchema} from '../build/utils/execution-policy.js';
import {newExecutionResult, StepEventDecoder} from '../build/utils/execution-result.js';
const base={host:'127.0.0.1',port:1,username:'fixture'};
const executionPolicy={mode:'actions-only',actions:{identity:{executable:'/usr/bin/id',args:['-u']}}};

test('actions-only rejects arbitrary execution and all alternate channels before connecting',async t=>{
  const manager=SSHConnectionManager.getInstance();manager.setConfig({fixture:{...base,executionPolicy}});
  t.after(()=>manager.disconnect());let connections=0;
  t.mock.method(manager,'connect',async()=>{connections++;throw new Error('Unexpected network connection');});
  const denied=e=>e.code==='EXECUTION_POLICY_DENIED';
  for(const run of [
    ()=>manager.executeCommand('id'),
    ()=>manager.executeCommand(undefined,undefined,undefined,{script:'id'}),
    ()=>manager.executeCommand(undefined,undefined,undefined,{steps:['id']}),
    ()=>manager.executeCommand('id',undefined,undefined,{prevalidatedInternalCommand:true}),
    ()=>manager.executeCommand(undefined,undefined,undefined,{action:'identity; id'}),
    ()=>manager.executeCommand(undefined,undefined,undefined,{action:'toString'}),
    ()=>manager.jobStart('id'),()=>manager.jobList(10),
    ()=>manager.upload('/tmp/a','/tmp/b'),()=>manager.download('/tmp/a','/tmp/b'),
    ()=>manager.withSftp(undefined,async()=>{}),()=>manager.readFile('/etc/passwd'),
    ()=>manager.interactive.start('probe'),()=>new DurableSessions(manager).start('probe'),
    ()=>manager.interactive.forward('localhost',80),()=>manager.interactive.reverseForward('localhost',80),
    ()=>rsyncTransfer(manager,'/tmp','/tmp','upload',true),
    ()=>new RemoteFiles(manager).sync('/tmp','/tmp','upload'),
  ]) await assert.rejects(run,denied);
  assert.throws(()=>manager.getClient(),denied);
  for(const options of [{script:'id'},{steps:['id']},{env:{}},{envFromRemoteFiles:{}},{sudo:true},{interpreter:'sh'},{failFast:false},{stopOnError:false}]) {
    await assert.rejects(manager.executeCommand(undefined,undefined,undefined,{action:'identity',...options}),e=>e.code==='COMMAND_VALIDATION_FAILED');
  }
  await assert.rejects(manager.executeCommand(undefined,'/tmp',undefined,{action:'identity'}),/action cannot/);
  assert.equal(connections,0);
});

test('malformed policies fail closed and reload retains the prior policy',t=>{
  const manager=SSHConnectionManager.getInstance();manager.setConfig({fixture:{...base,executionPolicy}});t.after(()=>manager.disconnect());
  for(const bad of [null,{}, {mode:'unrestricted',actions:{}},{...executionPolicy,typo:true},
    {mode:'actions-only',actions:{bad:{executable:'sh'}}},
    {mode:'actions-only',actions:{bad:{executable:'/bin/sh',args:['a\0b']}}},
    {mode:'actions-only',actions:{bad:{executable:'/bin/sh',arguments:['-c','id']}}},
  ]) {
    assert(!executionPolicySchema.safeParse(bad).success);
    assert.throws(()=>manager.reloadConfig({fixture:{...base,executionPolicy:bad}}));
    assert.equal(manager.getConfig().executionPolicy,executionPolicy);
  }
  for(const extra of [{transportMode:'shell'},{commandTemplate:'<command>'},{commandWhitelist:['.*']},{commandBlacklist:['rm']}]) {
    assert.throws(()=>manager.setConfig({fixture:{...base,executionPolicy,...extra}}),/actions-only/);
    assert.equal(manager.getConfig().executionPolicy,executionPolicy);
  }
});

test('step frames survive every byte boundary, ignore printed status claims and bound pending data',()=>{
  const token='a'.repeat(32), bytes=Buffer.from(`中文\n[step 1/1 exit code] 42\n\x1e${token}:1:start\x1fpayload\x1e${token}:1:exit:7\x1f尾`);
  for(let split=0;split<bytes.length;split++) {
    const result=newExecutionResult(1),decoder=new StepEventDecoder(token,result);
    const output=Buffer.concat([decoder.write(bytes.subarray(0,split)),decoder.write(bytes.subarray(split)),decoder.end()]).toString();
    assert.equal(output,'中文\n[step 1/1 exit code] 42\npayload尾');
    assert.deepEqual(result.steps,[{index:1,status:'failed',exitCode:7}]);
  }
  const decoder=new StepEventDecoder(token,newExecutionResult(1)), malformed=Buffer.from(`\x1e${token}:`+'x'.repeat(100000));
  assert.equal(Buffer.concat([decoder.write(malformed),decoder.end()]).length,malformed.length);
});
