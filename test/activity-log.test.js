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
    log.run('ssh_exec', 'mcp', { command: 'second' }, 'b', async () => { const output = log.outputReporter(); output('second output'); await delay(5); return { content: [{ type: 'text', text: 'second output\n[exit code] 7' }] }; }),
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
