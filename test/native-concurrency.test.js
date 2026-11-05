import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  const imported = importOpenSsh(fixture.clientConfig);
  const manager = SSHConnectionManager.getInstance();
  const config = { ...imported.configs.fixture, pty: false };
  manager.setConfig({ first: { ...config, name: 'first' }, second: { ...config, name: 'second' } });
  manager.scheduleStatusCollection = () => {};
  t.after(() => manager.disconnect());
  await manager.connect('second');
  assert.equal(manager.getDefaultConnectionName(), 'second');
});
