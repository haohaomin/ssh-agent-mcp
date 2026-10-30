import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SSHConnectionManager} from '../build/services/ssh-connection-manager.js';
import {ToolError} from '../build/utils/tool-error.js';
import {registerExecuteCommandTool} from '../build/tools/execute-command.js';

function setup(t, config = {}) {
  const manager = SSHConnectionManager.getInstance();
  manager.setConfig({fixture: {host:'127.0.0.1', port:1, username:'fixture', ...config}});
  t.after(() => manager.disconnect());
  return manager;
}
function stateDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-exec-budget-'));
  const previous = process.env.SSH_AGENT_STATE_DIR;
  process.env.SSH_AGENT_STATE_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.SSH_AGENT_STATE_DIR;
    else process.env.SSH_AGENT_STATE_DIR = previous;
    fs.rmSync(root, {recursive:true, force:true});
  });
  return root;
}
for (const filters of [{commandWhitelist:['^ls$']}, {commandBlacklist:['sudo']}]) {
  test(`reject environment/elevation before connecting with ${Object.keys(filters)[0]}`, async t => {
    const manager = setup(t, filters);
    let calls = 0;
    t.mock.method(manager, 'ensureConnected', async () => { calls++; throw new Error('must not connect'); });
    for (const options of [{env:{PATH:'/tmp/evil'}}, {sudo:true}, {envFromRemoteFiles:{KEY:'/tmp/key'}}]) {
      await assert.rejects(manager.executeCommand('ls', undefined, 'fixture', options), error => error.code === 'COMMAND_VALIDATION_FAILED');
    }
    assert.equal(calls, 0);
  });
}
test('invalid execution options fail before any connection or command side effect', async t => {
  const manager = setup(t);
  let calls = 0;
  t.mock.method(manager, 'ensureConnected', async () => { calls++; throw new Error('must not connect'); });
  for (const [command, options] of [
    ['true', {maxBytes:0}], ['true', {maxBytes:NaN}], ['true', {maxBytes:Number.MAX_SAFE_INTEGER+1}],
    [undefined, {}], ['true', {script:'true'}], ['true', {steps:['true']}],
    [undefined, {steps:[]}], [undefined, {steps:['']}], [undefined, {script:'true', steps:['true']}],
    ['true', {interpreter:'sh'}], [undefined, {script:'true', interpreter:'bash; false'}],
    [undefined, {steps:['print(1)'],interpreter:'python3'}],
    [undefined, {script:'print(1)',interpreter:'python3',failFast:true}],
    [undefined, {script:'print(1)',interpreter:'python3',failFast:false}],
    ['true', {failFast:true}], [undefined, {script:'true',stopOnError:true}],
    ['true', {env:{'BAD;key':'x'}}], ['true', {envFromRemoteFiles:{'BAD;key':'/tmp/key'}}],
    ['true', {envFromRemoteFiles:{KEY:'relative'}}], ['true', {env:{KEY:'x'},envFromRemoteFiles:{KEY:'/tmp/key'}}],
  ]) await assert.rejects(manager.executeCommand(command, undefined, 'fixture', options), error => error.code === 'COMMAND_VALIDATION_FAILED');
  assert.equal(calls, 0);
});
test('whitelist rejects script/steps and blacklist checks script body', async t => {
  const manager = setup(t, {commandWhitelist:['.*']});
  await assert.rejects(manager.executeCommand(undefined, undefined, 'fixture', {script:'ls'}), /commandWhitelist/);
  await assert.rejects(manager.executeCommand(undefined, undefined, 'fixture', {steps:['ls']}), /commandWhitelist/);
  manager.setConfig({fixture:{host:'127.0.0.1',username:'fixture',commandBlacklist:['forbidden']}});
  await assert.rejects(manager.executeCommand(undefined, undefined, 'fixture', {script:'printf forbidden'}), /blacklist/);
});
test('Python scripts check the actual interpreter invocation and body against command filters', async t => {
  const manager=setup(t,{commandBlacklist:['^python3 -u -$']});
  let connections=0;
  t.mock.method(manager,'ensureConnected',async()=>{connections++;throw new Error('must not connect');});
  await assert.rejects(manager.executeCommand(undefined,undefined,'fixture',{script:'print(1)',interpreter:'python3'}),/blacklist/);
  manager.setConfig({fixture:{host:'127.0.0.1',username:'fixture',commandBlacklist:['forbidden']}});
  await assert.rejects(manager.executeCommand(undefined,undefined,'fixture',{script:'print("forbidden")',interpreter:'python3'}),/blacklist/);
  manager.setConfig({fixture:{host:'127.0.0.1',username:'fixture',commandWhitelist:['.*']}});
  await assert.rejects(manager.executeCommand(undefined,undefined,'fixture',{script:'print(1)',interpreter:'python3'}),/commandWhitelist/);
  assert.equal(connections,0);
});
test('shell transport refuses script, steps and remote-file injection', async t => {
  const manager = setup(t, {transportMode:'shell'});
  for (const [command, options] of [[undefined,{script:'true'}], [undefined,{steps:['true']}], ['true',{envFromRemoteFiles:{KEY:'/tmp/key'}}]]) {
    await assert.rejects(manager.executeCommand(command, undefined, 'fixture', options), error => error.code === 'UNSUPPORTED_IN_SHELL_MODE');
  }
});
test('remote file injection honors configured path roots before connecting', async t => {
  const manager = setup(t, {allowedRemotePaths:['/srv/allowed']});
  await assert.rejects(manager.executeCommand('true', undefined, 'fixture', {envFromRemoteFiles:{KEY:'/etc/passwd'}}), error => error.code === 'REMOTE_PATH_NOT_ALLOWED');
});
test('output budget preserves UTF-8, exact limit, private full capture and failure status', async t => {
  const manager = setup(t), root = stateDir(t);
  let output = '始abcdefghij终';
  let failure;
  t.mock.method(manager, 'runCommandInternal', async () => { if (failure) throw failure; return output; });
  assert.equal(await manager.executeCommand('unused',undefined,'fixture',{maxBytes:Buffer.byteLength(output)}), output);
  assert(!fs.existsSync(path.join(root,'exec-output')));
  const text = await manager.executeCommand('unused',undefined,'fixture',{maxBytes:8});
  assert(!text.includes('\ufffd'));
  const file = /full output: ([^\n]+)\]/.exec(text)[1];
  assert.equal(fs.readFileSync(file,'utf8'), output);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  for (const suffix of ['[exit code] 7', '[signal] SIGTERM', '[exit code] 137\n[signal] KILL']) {
    failure = new ToolError('COMMAND_EXECUTION_ERROR', output+'\n'+suffix, false, true, suffix);
    await assert.rejects(manager.executeCommand('unused',undefined,'fixture',{maxBytes:1}), error => {
      assert.equal(error.commandRan,true);
      assert(error.message.endsWith(suffix));
      assert.equal(error.resultSuffix,suffix);
      return true;
    });
  }
});
test('a full-output storage failure retains success or failure instead of replacing the result', async t => {
  const manager = setup(t), root = stateDir(t);
  fs.writeFileSync(path.join(root,'exec-output'),'not a directory');
  let failure = false, executions = 0;
  t.mock.method(manager, 'runCommandInternal', async () => {
    executions++;
    if (failure) throw new ToolError('COMMAND_EXECUTION_ERROR','abcdefghijklmnop\n[exit code] 7',false,true,'[exit code] 7');
    return 'abcdefghijklmnop';
  });
  let handler;
  registerExecuteCommandTool({registerTool(n, m, h) { handler=h; }});
  const success = await handler({command:'unused',maxBytes:8});
  assert.equal(success.isError,undefined);
  assert.match(success.content[0].text,/abcd\n/);
  assert.match(success.content[0].text,/full output unavailable: EEXIST/);
  assert.match(success.content[0].text,/mnop$/);
  failure=true;
  const failed = await handler({command:'unused',maxBytes:1});
  assert.equal(failed.isError,undefined);
  assert.match(failed.content[0].text,/full output unavailable/);
  assert.match(failed.content[0].text,/\[exit code\] 7$/);
  assert.equal(executions,2);
});
