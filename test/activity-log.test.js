import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ActivityLog } from '../build/services/activity-log.js';

function fixture(t, secrets = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-test-'));
  const log = new ActivityLog(path.join(root, 'history.json'), () => secrets);
  t.after(() => { log.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return log;
}
test('concurrent operations keep output and outcomes separate, including nonzero exits', async t => {
  const log = fixture(t), events = [];
  log.subscribe(event => events.push(event));
  await Promise.all([
    log.run('ssh_exec', 'mcp', { command: 'first' }, 'a', async () => { const output = log.outputReporter(); await delay(20); output('first output'); return { content: [{ type: 'text', text: 'first output' }] }; }),
    log.run('ssh_exec', 'mcp', { command: 'second' }, 'b', async () => { const output = log.outputReporter(); output('second output'); await delay(5); log.markFailed(); return { content: [{ type: 'text', text: 'second output\n[exit code] 7' }] }; }),
  ]);
  const [first, second] = log.list(); assert.equal(first.output, 'first output'); assert.equal(second.output, 'second output');
  assert.equal(first.status, 'succeeded'); assert.equal(second.status, 'failed');
  assert.ok(events.some(event => event.record?.status === 'running')); assert.ok(events.some(event => event.record?.status === 'succeeded'));
  await assert.rejects(log.run('ssh_file_edit', 'web', {}, 'a', () => { throw new Error('denied'); }), /denied/);
  assert.equal(log.list().at(-1).status, 'failed');
});
test('known credentials, split chunks, structured secrets and JSON secrets are redacted before publication and persistence', async t => {
  const log = fixture(t, ['known-password', 'http-token-value']); const snapshots = [];
  log.subscribe(event => snapshots.push(JSON.stringify(event)));
  await log.run('ssh_exec', 'mcp', { command: 'echo known-password', env: { API_KEY: 'environment-secret' } }, 'host', async () => {
    const output = log.outputReporter(); output('value: known-pass'); log.flush();
    output('value: known-password');
    return { content: [{ type: 'text', text: '{"password":"unknown-secret","token":"http-token-value"}' }] };
  });
  log.flush();
  const all = snapshots.join('\n') + fs.readFileSync(log.file, 'utf8');
  for (const secret of ['known-password', 'known-pass', 'http-token-value', 'environment-secret', 'unknown-secret']) assert.ok(!all.includes(secret), secret);
  assert.equal(fs.statSync(log.file).mode & 0o777, 0o600);
});
test('bounded history survives restart and unfinished synchronous operations become interrupted', async t => {
  const log = fixture(t);
  for (let i = 0; i < 205; i++) await log.run('ssh_exec', 'mcp', { command: `command ${i}` }, 'host', () => 'x'.repeat(80000));
  log.start('ssh_exec', 'mcp', { command: 'unfinished' }, 'host'); log.flush();
  assert.equal(log.list().length, 200); assert.ok(fs.statSync(log.file).size < 6 * 1024 * 1024);
  const restored = new ActivityLog(log.file); assert.equal(restored.list().length, 200); assert.equal(restored.list().at(-1).status, 'interrupted'); restored.close();
});
test('history I/O errors do not change the operation result', async t => {
  const log = fixture(t); fs.mkdirSync(log.file);
  assert.equal(await log.run('ssh_exec', 'mcp', {}, 'host', () => 'ok'), 'ok');
  log.flush(); assert.match(log.storageError, /写入失败/);
});
test('historical schema-less list context is removed without losing operation results', t => {
  const log = fixture(t);
  const now = new Date().toISOString();
  fs.writeFileSync(log.file, JSON.stringify([{id:'legacy-list',operation:'ssh_server_list',source:'mcp',connectionName:'wrong-default',status:'succeeded',startedAt:now,updatedAt:now,input:JSON.stringify({requestId:2,signal:{},requestInfo:{headers:{authorization:'old-request-token'}}}),output:'',result:'Configured SSH servers'}]));
  const restored = new ActivityLog(log.file);
  assert.equal(restored.list()[0].input,'{}'); assert.equal(restored.list()[0].connectionName,undefined);
  assert.equal(restored.list()[0].result,'Configured SSH servers');
  restored.close(); assert.ok(!fs.readFileSync(log.file,'utf8').includes('requestInfo'));
});
test('restart interrupts unfinished session requests and persists the repair without a new operation', t => {
  const log = fixture(t);
  const read = log.start('ssh_session_read', 'mcp', { sessionName: 'terminal' }, 'host');
  const write = log.start('web_session_write', 'web', { sessionName: 'terminal' }, 'host');
  const output = log.start('session_output', 'monitor', { sessionName: 'terminal' }, 'host');
  log.close();
  const restored = new ActivityLog(log.file);
  for (const id of [read, write]) {
    assert.equal(restored.get(id).status, 'interrupted');
    assert.ok(restored.get(id).finishedAt);
  }
  assert.equal(restored.get(output).status, 'running');
  restored.close();
  const persisted = JSON.parse(fs.readFileSync(log.file, 'utf8'));
  assert.equal(persisted.find(r => r.id === read).status, 'interrupted');
  assert.equal(persisted.find(r => r.id === write).status, 'interrupted');
});

test('output markers are data and do not turn successful reads or commands into failures', async t => {
  const log = fixture(t);
  for (const operation of ['ssh_exec', 'ssh_file_read', 'ssh_session_read', 'web_command']) {
    await log.run(operation, 'mcp', {}, 'host', () => ({ content: [{ type: 'text', text: '[exit code] 9\n[signal] TERM\nCommand terminated by signal' }] }));
    assert.equal(log.list().at(-1).status, 'succeeded', operation);
  }
  await log.run('ssh_exec', 'mcp', {}, 'host', () => {
    log.markFailed();
    return { content: [{ type: 'text', text: '[exit code] 0\n[exit code] 7' }] };
  });
  assert.equal(log.list().at(-1).status, 'failed');
});

test('temporary history write failure retries without another operation and announces recovery', async t => {
  const log = fixture(t), events = [];
  log.subscribe(event => events.push(event.type));
  fs.mkdirSync(log.file);
  await log.run('ssh_exec', 'mcp', { command: 'record-me' }, 'host', () => 'completed');
  log.flush(); assert.ok(log.storageError);
  fs.rmdirSync(log.file);
  const deadline = Date.now() + 3000;
  while ((!fs.existsSync(log.file) || log.storageError) && Date.now() < deadline) await delay(30);
  assert.equal(log.storageError, undefined);
  assert.equal(JSON.parse(fs.readFileSync(log.file, 'utf8'))[0].result, 'completed');
  assert.ok(events.includes('storage-recovered'));
  assert.equal(fs.statSync(log.file).mode & 0o777, 0o600);
});

test('closing after a storage failure makes one final save attempt and leaves no retry timer', async t => {
  const log = fixture(t), events = [];
  log.subscribe(event => events.push(event.type));
  fs.mkdirSync(log.file);
  await log.run('ssh_exec', 'mcp', {}, 'host', () => 'completed');
  log.flush(); assert.ok(log.storageError);
  fs.rmdirSync(log.file);
  log.close(); log.close();
  assert.equal(JSON.parse(fs.readFileSync(log.file, 'utf8'))[0].result, 'completed');
  assert.equal(events.filter(type => type === 'closed').length, 1);
  assert.equal(log.timer, undefined);
});

test('persistent storage failures stop retrying after the log closes', async t => {
  const log = fixture(t), events = [];
  log.subscribe(event => events.push(event.type));
  fs.mkdirSync(log.file);
  await log.run('ssh_exec', 'mcp', {}, 'host', () => 'completed');
  log.flush(); log.close();
  assert.equal(log.timer, undefined);
  fs.rmdirSync(log.file);
  await delay(1200);
  assert.equal(fs.existsSync(log.file), false);
  assert.equal(events.at(-1), 'closed');
});
