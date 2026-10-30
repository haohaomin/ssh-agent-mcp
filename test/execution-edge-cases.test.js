import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SSHConnectionManager} from '../build/services/ssh-connection-manager.js';
import {registerExecuteCommandTool} from '../build/tools/execute-command.js';

const config={host:'127.0.0.1',port:1,username:'fixture'};
function setup(t,events,extra={}) {
  const manager=SSHConnectionManager.getInstance();manager.setConfig({fixture:{...config,...extra}});
  const stream=new EventEmitter();stream.stderr=new EventEmitter();stream.close=()=>stream.emit('close');stream.end=()=>{};
  const client={exec(_cmd,_opts,callback){queueMicrotask(()=>{callback(undefined,stream);setImmediate(()=>events(stream));});}};
  t.mock.method(manager,'ensureConnected',async()=>client);t.after(()=>manager.disconnect());
  let handler;registerExecuteCommandTool({registerTool(_n,_c,h){handler=h;}});
  return {manager,handler,client,stream};
}
function state(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssh-edge-test-')),previous=process.env.SSH_AGENT_STATE_DIR;
  process.env.SSH_AGENT_STATE_DIR=dir;
  t.after(()=>{if(previous===undefined)delete process.env.SSH_AGENT_STATE_DIR;else process.env.SSH_AGENT_STATE_DIR=previous;fs.rmSync(dir,{recursive:true,force:true});});
}

test('channel closes without exit status: report unknown completion instead of success',async t=>{
  const {handler}=setup(t,stream=>{stream.emit('data',Buffer.from('partial result'));stream.emit('close');});
  const r=await handler({command:'deploy'});
  assert.equal(r.isError,true);assert.equal(r.structuredContent.exitCode,null);
  assert.equal(r.structuredContent.completed,false);assert(r.structuredContent.started);assert.equal(r.structuredContent.failureStage,'execution');
  assert.match(r.structuredContent.output,/partial result/);
});

test('stream error preserves captured stdout/stderr and bounded private log',async t=>{
  state(t);
  const {handler}=setup(t,stream=>{
    stream.emit('data',Buffer.from('deployment-progress-123456789'));
    stream.stderr.emit('data',Buffer.from('warning-before-disconnect'));
    stream.emit('error',new Error('connection reset'));
  });
  const r=await handler({command:'deploy',maxBytes:8});
  assert(r.isError);assert(!r.structuredContent.completed);assert(r.structuredContent.truncated);
  assert(r.structuredContent.fullOutputPath);
  const saved=fs.readFileSync(r.structuredContent.fullOutputPath,'utf8');
  assert.match(saved,/deployment-progress/);assert.match(saved,/warning-before-disconnect/);assert.match(saved,/connection reset/);
});

test('policy reload during asynchronous setup prevents a previously admitted command from dispatching',async t=>{
  const {manager,handler}=setup(t,()=>{});let dispatched=false;
  t.mock.method(manager,'ensureConnected',async()=>{
    manager.reloadConfig({fixture:{...config,executionPolicy:{mode:'actions-only',actions:{}}}});
    return {exec(_c,_o,callback){dispatched=true;const stream=new EventEmitter();stream.stderr=new EventEmitter();stream.close=()=>{};callback(undefined,stream);setImmediate(()=>stream.emit('close',0));}};
  });
  const r=await handler({command:'previously-authorized-command'});
  assert.equal(dispatched,false);assert(r.isError);assert.equal(r.structuredContent.started,false);
});

test('queued shell command rechecks policy after the preceding command finishes',async t=>{
  const {manager}=setup(t,()=>{}, {transportMode:'shell'});
  let release,dispatched=false;
  manager.shellQueues.set('fixture',new Promise(resolve=>{release=resolve;}));
  t.mock.method(manager,'executeShellCommand',async()=>{dispatched=true;return 'unexpected';});
  const pending=manager.runShellCommand('previously-authorized-command',undefined,'fixture',100);
  manager.reloadConfig({fixture:{...config,executionPolicy:{mode:'actions-only',actions:{}}}});
  release();
  await assert.rejects(pending,e=>e.code==='EXECUTION_POLICY_DENIED');assert(!dispatched);
});

test('equivalent configuration reload does not reject an admitted execution',async t=>{
  const {manager,handler,client}=setup(t,stream=>stream.emit('close',0));
  t.mock.method(manager,'ensureConnected',async()=>{manager.reloadConfig({fixture:{...config}});return client;});
  const r=await handler({command:'true'});assert(!r.isError);assert.equal(r.structuredContent.exitCode,0);
});
