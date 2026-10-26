import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpHttpServer } from '../build/core/http-server.js';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';
import { DurableSessions } from '../build/services/durable-sessions.js';
import { importOpenSsh } from '../build/utils/openssh-import.js';
import { shellQuote } from '../build/utils/shell.js';
import { localSshd } from './helpers/local-sshd.js';

for (const backend of ['ssh2', 'openssh']) test(`Workbench HTTP workflows against real sshd (${backend})`, { timeout: 45000 }, async t => {
  const fixture = await localSshd(t), manager = SSHConnectionManager.getInstance();
  const config = backend === 'ssh2' ? fixture.config : { ...importOpenSsh(fixture.clientConfig).configs.fixture, allowedRemotePaths: [fixture.root], pty: false };
  config.commandTemplate = `export HOME=${shellQuote(fixture.root)}; <command>`;
  manager.setConfig({ fixture: config }); manager.scheduleStatusCollection = () => {};
  const oldState = process.env.SSH_AGENT_STATE_DIR; process.env.SSH_AGENT_STATE_DIR = path.join(fixture.root, 'state');
  const sessions = new DurableSessions(manager), sessionName = `web-${backend}`;
  const server = new McpHttpServer({ host: '127.0.0.1', port: 0, path: '/mcp' }, () => new McpServer({ name: 'web-test', version: '1' }), manager, '/workbench');
  const endpoint = await server.listen(), origin = new URL(endpoint).origin;
  const call = async (route, data, status = 200) => {
    const response = await fetch(`${origin}/workbench/api${route}`, data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  let job;
  try {
    await t.test('canonical URL and relative static assets', async () => {
      const response = await fetch(`${origin}/workbench`, { redirect: 'manual' });
      assert.equal(response.status, 308); assert.equal(response.headers.get('location'), '/workbench/');
      for (const file of ['', 'app.js', 'activity.js', 'ui-model.js', 'styles.css', 'favicon.svg']) assert.equal((await fetch(`${origin}/workbench/${file}`)).status, 200);
    });
    await t.test('opening the jobs view does not establish an offline SSH connection', async () => {
      assert.equal(manager.getAllServerInfos()[0].connected, false);
      assert.equal((await call('/jobs')).paused, true);
      assert.equal(manager.getAllServerInfos()[0].connected, false);
      await call('/jobs?connectionName=unknown', undefined, 400);
    });
    await t.test('connect, real diagnosis and reconnect', async () => {
      await call('/connect', { connectionName: 'fixture' }); const previous = manager.getClient('fixture');
      const diagnosis = await call('/diagnose', { connectionName: 'fixture' }); assert.equal(diagnosis.ok, true); assert.equal(diagnosis.checks.local.backend, backend);
      await call('/reconnect', { connectionName: 'fixture' }); assert.notEqual(manager.getClient('fixture'), previous);
      assert.match((await call('/command', { command: 'printf ui-中文', connectionName: 'fixture' })).output, /ui-中文/);
      const summary = await call('/servers'); assert.equal(summary.servers[0].initialPath, fixture.root); assert.equal(summary.servers[0].connected, true);
      assert.ok(!JSON.stringify(summary).includes(config.privateKey || 'user-cert.pub'));
    });
    await t.test('full text reads preserve digits, tabs, BOM and content beyond 64 KiB', async () => {
      const content = '\ufeff123\t中文\r\n' + 'line\n'.repeat(20000), file = path.join(fixture.root, 'large.txt');
      fs.writeFileSync(file, content);
      const read = await call(`/file?path=${encodeURIComponent(file)}`); assert.equal(read.content, content); assert.match(read.sha256, /^[a-f0-9]{64}$/);
      const directory = await call(`/files?path=${encodeURIComponent(fixture.root)}`); assert.equal(directory.resolvedPath, fixture.root); assert.ok(directory.entries.some(item => item.name === 'large.txt'));
      await call('/file?path=/etc/passwd', undefined, 400);
      fs.symlinkSync('/etc/passwd', path.join(fixture.root, 'escape')); await call(`/file?path=${encodeURIComponent(path.join(fixture.root, 'escape'))}`, undefined, 400);
    });
    await t.test('initial file directory resolves safely and arbitrary relative paths stay rejected', async () => {
      assert.equal((await call('/files?path=.')).resolvedPath, fixture.root);
      await call('/files?path=../', undefined, 400);
      const liveConfig = manager.getConfig('fixture'), allowed = liveConfig.allowedRemotePaths;
      liveConfig.allowedRemotePaths = undefined;
      try {
        // Resolve the SFTP home through the public route, independently of the login shell's HOME override.
        const result = await call('/files?path=.');
        assert.ok(path.isAbsolute(result.resolvedPath));
      } finally { liveConfig.allowedRemotePaths = allowed; }
    });
    await t.test('preview, atomic edit, backup, stale-version rejection and restore', async () => {
      const file = path.join(fixture.root, 'edit.txt'); fs.writeFileSync(file, 'before\n');
      const read = await call(`/file?path=${encodeURIComponent(file)}`);
      const data = { remotePath: file, content: 'after\n', expectedSha256: read.sha256, backup: true };
      const preview = await call('/file/edit', { ...data, dryRun: true }); assert.match(preview.diff, /-before/); assert.equal(fs.readFileSync(file, 'utf8'), 'before\n');
      const edit = await call('/file/edit', data); assert.equal(fs.readFileSync(file, 'utf8'), 'after\n'); assert.equal(fs.readFileSync(edit.backupPath, 'utf8'), 'before\n');
      await call('/file/edit', data, 400); assert.equal(fs.readFileSync(file, 'utf8'), 'after\n');
      await call('/file/edit', { ...data, content: 'before\n', expectedSha256: edit.afterSha256 }); assert.equal(fs.readFileSync(file, 'utf8'), 'before\n');
      fs.writeFileSync(file, ''); const empty = await call(`/file?path=${encodeURIComponent(file)}`);
      await call('/file/edit', { remotePath: file, content: 'from empty', expectedSha256: empty.sha256 }); assert.equal(fs.readFileSync(file, 'utf8'), 'from empty');
    });
    await t.test('uploads are exclusive UTF-8 text and malformed bodies cannot mutate files', async () => {
      const file = path.join(fixture.root, '上传.txt');
      await call('/file/create', { remotePath: file, content: '中文\n' });
      await call('/file/create', { remotePath: file, content: 'overwrite' }, 400); assert.equal(fs.readFileSync(file, 'utf8'), '中文\n');
      await call('/file/create', { remotePath: path.join(fixture.root, 'binary'), content: '\0' }, 400);
      await call('/file/edit', { remotePath: file, content: 'missing hash' }, 400);
      await call('/file/create', { content: 'missing path' }, 400);
      fs.writeFileSync(path.join(fixture.root, 'invalid-utf8'), Buffer.from([255, 254]));
      await call(`/file?path=${encodeURIComponent(path.join(fixture.root, 'invalid-utf8'))}`, undefined, 400);
    });
    await t.test('durable terminal start, GET output, write, resize, method guard and stop', async () => {
      await call('/sessions/start', { sessionName }); assert.equal((await call('/sessions'))[0].connectionName, 'fixture');
      await call(`/sessions/${sessionName}/write`, { input: "printf 'UI_%s\\n' '终端成功'\n" });
      let read;
      for (let n = 0; n < 100; n++) { read = await call(`/sessions/${sessionName}/read?maxChars=65536`); if (read.output.includes('UI_终端成功')) break; await delay(20); }
      assert.match(read.output, /UI_终端成功/);
      assert.equal((await call(`/sessions/${sessionName}/resize`, { cols: 90, rows: 40 })).cols, 90);
      await call(`/sessions/${sessionName}/resize`, { cols: 0, rows: 40 }, 400);
      await call(`/sessions/${sessionName}/stop`, undefined, 405);
      await call(`/sessions/${sessionName}/read?offset=-1`, undefined, 400);
      await call(`/sessions/${sessionName}/stop`, {});
    });
    await t.test('stopping and immediately recreating a named terminal exposes the new worker', async () => {
      const first = await call('/sessions/start', { sessionName });
      await call(`/sessions/${sessionName}/stop`, {});
      const second = await call('/sessions/start', { sessionName });
      assert.notEqual(first.pid, second.pid);
      const listed = (await call('/sessions')).find(session => session.sessionName === sessionName);
      assert.equal(listed.pid, second.pid); assert.equal(listed.closed, false);
      await call(`/sessions/${sessionName}/write`, { input: "printf 'RESTART_%s\\n' 'OK'\n" });
      let read;
      for (let n = 0; n < 100; n++) { read = await call(`/sessions/${sessionName}/read?offset=0`); if (read.output.includes('RESTART_OK')) break; await delay(20); }
      assert.match(read.output, /RESTART_OK/);
      await call(`/sessions/${sessionName}/stop`, {});
    });
    await t.test('jobs and port forwards share state with MCP services and can be stopped', async () => {
      const started = await manager.jobStart('sleep 30', fixture.root, 'fixture'); job = started.jobId;
      assert.match((await call('/jobs')).output, new RegExp(job)); await call('/jobs/kill', { jobId: job });
      const echo = net.createServer(socket => { socket.on('error', () => {}); socket.pipe(socket); }); await new Promise(r => echo.listen(0, '127.0.0.1', r));
      try {
        const forward = await manager.interactive.forward('127.0.0.1', echo.address().port, 0, 'fixture');
        assert.equal((await call('/forwards'))[0].forwardId, forward.forwardId);
        await call('/forwards/stop', { forwardId: forward.forwardId }); assert.equal((await call('/forwards')).length, 0);
      } finally { echo.close(); }
    });
  } finally {
    await sessions.stop(sessionName).catch(() => {}); if (job) await manager.jobKill(job, 'fixture').catch(() => {});
    await server.close(); manager.disconnect();
    if (oldState === undefined) delete process.env.SSH_AGENT_STATE_DIR; else process.env.SSH_AGENT_STATE_DIR = oldState;
  }
});
