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
import { DurableSessions } from '../build/services/durable-sessions.js';
import { registerAllTools } from '../build/tools/index.js';
import { importOpenSsh } from '../build/utils/openssh-import.js';
import { shellQuote } from '../build/utils/shell.js';
import { localSshd } from './helpers/local-sshd.js';

for (const backend of ['ssh2', 'openssh']) test(`disconnect through MCP and web (${backend})`, { timeout: 45000 }, async t => {
  const fixture = await localSshd(t), manager = SSHConnectionManager.getInstance();
  const config = backend === 'ssh2' ? { ...fixture.config } : { ...importOpenSsh(fixture.clientConfig).configs.fixture, pty: false };
  config.commandTemplate = `export HOME=${shellQuote(fixture.root)}; <command>`;
  manager.setConfig({ fixture: config, alternate: { ...config } }); manager.scheduleStatusCollection = () => {};
  const previous = process.env.SSH_AGENT_STATE_DIR; process.env.SSH_AGENT_STATE_DIR = path.join(fixture.root, 'state');
  const sessions = new DurableSessions(manager);
  const server = new McpHttpServer({ host: '127.0.0.1', port: 0, path: '/mcp' }, () => {
    const mcp = new McpServer({ name: 'disconnect-test', version: '1' }); registerAllTools(mcp); return mcp;
  }, manager, '/ui');
  const endpoint = await server.listen(), client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: {connectionName: 'fixture', ...args} });
    const text = result.content.map(c => c.text || '').join('\n');
    assert.ok(!result.isError, text); return text;
  };
  const web = async (route, body) => {
    const response = await fetch(new URL('/ui/api/' + route, endpoint), body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200); return response.json();
  };
  let job;
  try {
    await t.test('closes only selected host resources, preserves remote jobs, and suppresses automatic reconnect', async () => {
      await manager.connect('fixture'); await manager.connect('alternate');
      await sessions.start('selected', 'fixture'); await sessions.start('other', 'alternate');
      const forward = JSON.parse(await call('ssh_forward_start', { connectionName: 'fixture', remoteHost: '127.0.0.1', remotePort: fixture.port }));
      const reverse = JSON.parse(await call('ssh_forward_reverse', { connectionName: 'fixture', localPort: fixture.port }));
      const otherForward = JSON.parse(await call('ssh_forward_start', { connectionName: 'alternate', remoteHost: '127.0.0.1', remotePort: fixture.port }));
      job = /jobId: (job-[\w-]+)/.exec(await call('ssh_job_start', { command: 'sleep 20', cwd: fixture.root }))[1];
      const disconnected = JSON.parse(await call('ssh_server_disconnect'));
      assert.equal(disconnected.connectionName, 'fixture');
      assert.deepEqual(disconnected.stoppedSessions, ['selected']);
      assert.deepEqual(disconnected.stoppedForwards.sort(), [forward.forwardId, reverse.forwardId].sort());
      assert.equal(disconnected.remoteJobsPreserved, true);
      assert.equal((await sessions.read('selected')).closed, true);
      assert.equal((await sessions.read('other')).closed, false);
      assert.deepEqual(manager.interactive.listForwards().map(f => f.forwardId), [otherForward.forwardId]);
      await delay(1600);
      assert.equal((await web('jobs?connectionName=fixture')).paused, true);
      assert.equal(manager.getAllServerInfos().find(s => s.name === 'fixture').connected, false);
      assert.equal(manager.getAllServerInfos().find(s => s.name === 'alternate').connected, true);
      const repeated = JSON.parse(await call('ssh_server_disconnect', { connectionName: 'fixture' }));
      assert.deepEqual(repeated.stoppedSessions, []); assert.deepEqual(repeated.stoppedForwards, []);
      assert.match(await call('ssh_job_status', { jobId: job }), /\[state\]\s+running/);
      assert.equal(manager.isManuallyDisconnected('fixture'), false);
      await call('ssh_job_kill', { jobId: job }); job = undefined;
    });
    await t.test('web disconnect is audited and explicit reconnect resumes requests', async () => {
      const result = await web('disconnect', { connectionName: 'alternate' });
      assert.equal(result.connected, false); assert.deepEqual(result.stoppedSessions, ['other']);
      assert.equal((await sessions.read('other')).closed, true);
      assert.equal(manager.interactive.listForwards().length, 0);
      const records = (await web('activity')).records;
      assert.ok(records.some(r => r.operation === 'web_disconnect' && r.connectionName === 'alternate' && r.status === 'succeeded'));
      assert.ok(records.some(r => r.operation === 'ssh_server_disconnect' && r.connectionName === 'fixture'));
      await web('connect', { connectionName: 'alternate' });
      assert.match(await call('ssh_exec', { command: 'printf resumed', connectionName: 'alternate' }), /resumed/);
      const bad = await client.callTool({ name: 'ssh_server_disconnect', arguments: { connectionName: 'unknown' } });
      assert.equal(bad.isError, true);
      assert.equal(manager.getAllServerInfos().find(s => s.name === 'alternate').connected, true);
    });
    await t.test('concurrent terminal startup and disconnect cannot leave an untracked live terminal', async () => {
      let release;
      const started = manager.withSessionStart('fixture', () => new Promise(resolve => { release = resolve; }));
      await assert.rejects(manager.disconnectServer('fixture'), /changing/);
      release(); await started;
      const disconnect = manager.disconnectServer('fixture');
      await assert.rejects(sessions.start('racing', 'fixture'), /disconnecting/);
      await assert.rejects(manager.connect('fixture'), /disconnecting/);
      await disconnect;
    });
  } finally {
    if (job) await manager.jobKill(job, 'fixture').catch(() => {});
    for (const name of ['selected', 'other', 'racing']) await sessions.stop(name).catch(() => {});
    await client.close(); await server.close(); manager.disconnect();
    if (previous === undefined) delete process.env.SSH_AGENT_STATE_DIR; else process.env.SSH_AGENT_STATE_DIR = previous;
  }
});
