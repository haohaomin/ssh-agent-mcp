import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localSshd } from './helpers/local-sshd.js';
import { importOpenSsh } from '../build/utils/openssh-import.js';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';

test('native OpenSSH queues exec channels below the mux session limit', { timeout: 30000 }, async t => {
  const fixture = await localSshd(t);
  const imported = importOpenSsh(fixture.clientConfig);
  const manager = SSHConnectionManager.getInstance();
  const config = { ...imported.configs.fixture, pty: false, maxConcurrentChannels: 4 };
  manager.setConfig({ fixture: config });
  manager.scheduleStatusCollection = () => {};
  t.after(() => manager.disconnect());

  const results = await Promise.all(Array.from({ length: 24 }, (_, index) =>
    manager.executeCommand(`printf native-${index}`, undefined, 'fixture')));
  assert.deepEqual(results.sort(), Array.from({ length: 24 }, (_, index) => `native-${index}`).sort());
});

test('a successful explicitly named connection becomes the optional-call default', { timeout: 30000 }, async t => {
  const fixture = await localSshd(t);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-default-state-'));
  const previousState = process.env.SSH_AGENT_STATE_DIR;
  process.env.SSH_AGENT_STATE_DIR = state;
  t.after(() => {
    if (previousState === undefined) delete process.env.SSH_AGENT_STATE_DIR;
    else process.env.SSH_AGENT_STATE_DIR = previousState;
    fs.rmSync(state, { recursive: true, force: true });
  });
  const imported = importOpenSsh(fixture.clientConfig);
  const manager = SSHConnectionManager.getInstance();
  const config = { ...imported.configs.fixture, pty: false };
  manager.setConfig({ first: { ...config, name: 'first' }, second: { ...config, name: 'second' } });
  manager.scheduleStatusCollection = () => {};
  t.after(() => manager.disconnect());
  await manager.connect('second');
  assert.equal(manager.getDefaultConnectionName(), 'second');
  manager.disconnect();
  manager.setConfig({ first: { ...config, name: 'first' }, second: { ...config, name: 'second' } });
  assert.equal(manager.getDefaultConnectionName(), 'second');
});
