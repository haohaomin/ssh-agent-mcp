import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpHttpServer } from '../build/core/http-server.js';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';
import { registerAllTools } from '../build/tools/index.js';
import { DurableSessions } from '../build/services/durable-sessions.js';
import { importOpenSsh } from '../build/utils/openssh-import.js';
import { shellQuote } from '../build/utils/shell.js';
import { localSshd } from './helpers/local-sshd.js';

async function until(check, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(30); }
  throw new Error('Timed out waiting for activity');
}
for (const backend of ['ssh2', 'openssh']) test(`live MCP activity, streaming, diff, jobs, sessions and history (${backend})`, { timeout: 45000 }, async t => {
  const fixture = await localSshd(t), manager = SSHConnectionManager.getInstance();
  const config = backend === 'ssh2' ? fixture.config : { ...importOpenSsh(fixture.clientConfig).configs.fixture, allowedRemotePaths: [fixture.root], pty: false };
  config.commandTemplate = `export HOME=${shellQuote(fixture.root)}; <command>`;
  manager.setConfig({ fixture: config }); manager.scheduleStatusCollection = () => {};
  const oldState = process.env.SSH_AGENT_STATE_DIR; process.env.SSH_AGENT_STATE_DIR = path.join(fixture.root, 'state');
  const create = () => { const mcp = new McpServer({ name: 'activity-test', version: '1' }); registerAllTools(mcp); return mcp; };
  let server = new McpHttpServer({ host: '127.0.0.1', port: 0, path: '/mcp', token: 'test-activity-token' }, create, manager, '/ui');
  const endpoint = await server.listen(), origin = new URL(endpoint).origin;
  const client = new Client({ name: 'activity-client', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: 'Bearer test-activity-token' } } });
  const headers = { Authorization: 'Bearer test-activity-token' };
  const abort = new AbortController(); let reader, job;
  const events = []; let stream;
  const sessionName = `audit-live-${backend}`;
  const invoke = (name, args = {}) => client.callTool({ name, arguments: args });
  const records = async () => (await (await fetch(`${origin}/ui/api/activity`, { headers })).json()).records;
  try {
    await client.connect(transport);
    await t.test('schema-less server list records only tool arguments and global scope', async () => {
      await invoke('ssh_server_list');
      const record = (await records()).find(r => r.operation === 'ssh_server_list');
      assert.deepEqual(JSON.parse(record.input), {});
      assert.equal(record.connectionName, undefined);
      assert.ok(!record.input.includes('requestInfo'));
      assert.match(record.result, /fixture/);
    });
    await t.test('history and SSE require the HTTP bearer token', async () => {
      for (const suffix of ['activity', 'activity/events']) assert.equal((await fetch(`${origin}/ui/api/${suffix}`)).status, 401);
      const response = await fetch(`${origin}/ui/api/activity/events`, { headers, signal: abort.signal });
      assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
      reader = response.body.getReader();
      stream = (async () => { let pending = ''; const decoder = new TextDecoder();
        try { while (true) { const { value, done } = await reader.read(); if (done) break; pending += decoder.decode(value, { stream: true }); let at; while ((at = pending.indexOf('\n\n')) >= 0) { const event = pending.slice(0, at); pending = pending.slice(at + 2); if (event.startsWith('data: ')) events.push(JSON.parse(event.slice(6))); } } } catch (error) { if (!abort.signal.aborted) throw error; }
      })();
      await until(() => events.some(event => event.type === 'snapshot'));
    });
    await t.test('command output arrives over SSE before execution completes, failures retain result', async () => {
      let finished = false;
      const command = invoke('ssh_exec', { command: "printf 'FIRST\\n'; sleep 2; printf 'LAST\\n'" }).finally(() => { finished = true; });
      await until(() => events.find(event => event.record?.operation === 'ssh_exec' && event.record.status === 'running' && event.record.output.includes('FIRST')));
      assert.equal(finished, false); await command;
      let record = (await records()).find(r => r.operation === 'ssh_exec'); assert.equal(record.status, 'succeeded'); assert.match(record.result, /LAST/);
      await invoke('ssh_exec', { command: 'printf failure; exit 7' }); record = (await records()).filter(r => r.operation === 'ssh_exec').at(-1);
      assert.equal(record.status, 'failed'); assert.match(record.result, /exit code.*7/);
    });
    await t.test('shell transport streams output before its completion marker', async () => {
      manager.reloadConfig({ fixture: { ...config, transportMode: 'shell' } });
      try {
        let finished = false;
        const command = invoke('ssh_exec', { command: "printf 'SHELL_STREAM_FIRST\\n'; sleep 2; printf 'SHELL_STREAM_LAST\\n'" }).finally(() => { finished = true; });
        await until(() => events.find(event => event.record?.status === 'running' && event.record.output.includes('SHELL_STREAM_FIRST')));
        assert.equal(finished, false); const result = await command; assert.match(result.content[0].text, /SHELL_STREAM_LAST/);
      } finally { manager.reloadConfig({ fixture: config }); }
    });
    await t.test('file changes carry a unified diff and denied changes remain visible', async () => {
      const file = path.join(fixture.root, 'edit.txt'); fs.writeFileSync(file, 'before\n');
      await invoke('ssh_file_edit', { remotePath: file, edits: [{ oldText: 'before', newText: 'after' }] });
      const record = (await records()).filter(r => r.operation === 'ssh_file_edit').at(-1);
      assert.match(record.diff, /-before/); assert.match(record.diff, /\+after/); assert.equal(record.status, 'succeeded');
      await invoke('ssh_file_read', { remotePath: '/etc/passwd' });
      assert.equal((await records()).at(-1).status, 'failed');
    });
    await t.test('background job completion and output are followed without client status polling', async () => {
      const result = await invoke('ssh_job_start', { command: 'sleep 1; printf JOB_FINISHED', cwd: fixture.root });
      job = /jobId: (\S+)/.exec(result.content[0].text)[1];
      const record = await until(async () => (await records()).find(r => r.jobId === job && r.status === 'succeeded'));
      assert.equal(record.jobState, 'exited'); assert.match(record.output, /JOB_FINISHED/);
    });
    await t.test('terminal input and subsequent shared output are captured automatically', async () => {
      await invoke('ssh_session_start', { sessionName });
      await invoke('ssh_session_write', { sessionName, input: "printf 'SESSION_%s\\n' 'LIVE'\n" });
      const record = await until(async () => (await records()).find(r => r.operation === 'session_output' && r.output.includes('SESSION_LIVE')));
      assert.equal(record.connectionName, 'fixture'); assert.equal(record.status, 'running');
      assert.ok((await records()).some(r => r.operation === 'ssh_session_write' && r.input.includes('SESSION_')));
      await invoke('ssh_session_stop', { sessionName });
      await until(async () => (await records()).find(r => r.id === record.id && r.status === 'succeeded'));
    });
    await t.test('web mutations are recorded and history survives server restart', async () => {
      const response = await fetch(`${origin}/ui/api/file/create`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ remotePath: path.join(fixture.root, 'web.txt'), content: 'web' }) });
      assert.equal(response.status, 200); const before = await records(); assert.ok(before.some(r => r.source === 'web'));
      abort.abort(); await stream; await client.close(); await server.close();
      server = new McpHttpServer({ host: '127.0.0.1', port: 0, path: '/mcp', token: 'test-activity-token' }, create, manager, '/ui');
      const newEndpoint = await server.listen();
      const after = await (await fetch(new URL('/ui/api/activity', newEndpoint), { headers })).json();
      assert.ok(after.records.some(r => r.id === before.at(-1).id)); assert.equal(after.storageError, undefined);
    });
  } finally {
    abort.abort(); await stream?.catch(() => {}); await client.close().catch(() => {});
    await new DurableSessions(manager).stop(sessionName).catch(() => {}); if (job) await manager.jobKill(job, 'fixture').catch(() => {});
    await server.close(); manager.disconnect();
    if (oldState === undefined) delete process.env.SSH_AGENT_STATE_DIR; else process.env.SSH_AGENT_STATE_DIR = oldState;
  }
});
