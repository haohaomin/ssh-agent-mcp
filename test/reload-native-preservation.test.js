import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';
import { importOpenSsh } from '../build/utils/openssh-import.js';
import { CommandLineParser } from '../build/cli/command-line-parser.js';

// Native OpenSSH hosts carry references only: ssh resolves User/Port/HostName
// from the config file at connect time. Reload has to keep them when nothing
// moved, and drop them when the file changed.
function sshConfigFile(t, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-reload-native-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, contents);
  return file;
}

test('re-importing an unchanged SSH config preserves every native host', t => {
  const file = sshConfigFile(t, 'Host aliyun\n HostName 39.105.20.124\n User root\n ConnectTimeout 10\nHost oci\n HostName 132.226.69.253\n User opc\n ConnectTimeout 10\n');
  const manager = SSHConnectionManager.getInstance();
  t.after(() => manager.disconnect());
  manager.setConfig(importOpenSsh(file).configs, 'aliyun');

  assert.deepEqual(manager.reloadConfig(importOpenSsh(file).configs), {
    added: [], changed: [], removed: [], preserved: ['aliyun', 'oci'],
  });
  assert.equal(manager.getDefaultConnectionName(), 'aliyun');
});

test('editing the SSH config marks the affected hosts as changed', t => {
  const file = sshConfigFile(t, 'Host aliyun\n User root\n ConnectTimeout 10\n');
  const manager = SSHConnectionManager.getInstance();
  t.after(() => manager.disconnect());
  manager.setConfig(importOpenSsh(file).configs);

  fs.appendFileSync(file, 'Host extra\n User deploy\n ConnectTimeout 10\n');
  const reloaded = manager.reloadConfig(importOpenSsh(file).configs);
  assert.deepEqual(reloaded.added, ['extra']);
  // The fingerprint is scoped to directives that apply to this alias, so an
  // unrelated Host block does not force an unnecessary reconnect.
  assert.deepEqual(reloaded.changed, []);
  assert.deepEqual(reloaded.preserved, ['aliyun']);

  fs.writeFileSync(file, 'Host aliyun\n User admin\n ConnectTimeout 10\n');
  assert.deepEqual(manager.reloadConfig(importOpenSsh(file).configs).changed, ['aliyun']);
});

test('a config file that appears later invalidates the preserved host', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-reload-ghost-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config');
  const manager = SSHConnectionManager.getInstance();
  t.after(() => manager.disconnect());

  // Import while the file is missing: the host is skipped, so seed it by hand
  // with the same "unreadable" fingerprint the importer would have produced.
  const ghost = { name: 'ghost', host: 'ghost', port: 22, username: 'root', backend: 'openssh', nativeTarget: 'ghost', nativeConfigFile: file, nativeConfigHash: 'unreadable' };
  manager.setConfig({ ghost });
  assert.deepEqual(manager.reloadConfig({ ghost }).preserved, ['ghost']);

  fs.writeFileSync(file, 'Host ghost\n User root\n ConnectTimeout 10\n');
  assert.deepEqual(manager.reloadConfig(importOpenSsh(file).configs).changed, ['ghost']);
});

test('hash-less native configs stay conservative and are treated as changed', t => {
  const manager = SSHConnectionManager.getInstance();
  t.after(() => manager.disconnect());
  const bare = { name: 'aliyun', host: 'aliyun', port: 22, username: 'root', backend: 'openssh', nativeTarget: 'aliyun' };
  manager.setConfig({ aliyun: bare });
  assert.deepEqual(manager.reloadConfig({ aliyun: { ...bare } }).changed, ['aliyun']);
});

test('ssh2 hosts keep their existing deep-equality behaviour', t => {
  const manager = SSHConnectionManager.getInstance();
  t.after(() => manager.disconnect());
  const ssh2 = { host: 'example.test', port: 22, username: 'ops', password: 'fake' };
  manager.setConfig({ ssh2 });
  assert.deepEqual(manager.reloadConfig({ ssh2: { ...ssh2 } }), {
    added: [], changed: [], removed: [], preserved: ['ssh2'],
  });
  assert.deepEqual(manager.reloadConfig({ ssh2: { ...ssh2, username: 'other' } }).changed, ['ssh2']);
});

test('the CLI import path keeps the fingerprint, so reloadFromSource preserves live hosts', t => {
  const file = sshConfigFile(t, 'Host aliyun\n HostName 39.105.20.124\n User root\n ConnectTimeout 10\n');
  const manager = SSHConnectionManager.getInstance();
  t.after(() => manager.disconnect());
  const args = ['--import-ssh-config', '--ssh-config-file', file, '--host', 'aliyun'];
  manager.setConfig(CommandLineParser.parseArgs(args).configs);
  manager.setConfigLoader(() => CommandLineParser.parseArgs(args, true).configs);

  assert.equal(manager.getConfig('aliyun').nativeConfigHash?.length, 64);
  assert.deepEqual(manager.reloadFromSource(), { added: [], changed: [], removed: [], preserved: ['aliyun'] });

  // --host aliyun limits the import to that alias, so only its own edit matters.
  fs.writeFileSync(file, 'Host aliyun\n HostName 39.105.20.124\n User admin\n ConnectTimeout 10\n');
  assert.deepEqual(manager.reloadFromSource().changed, ['aliyun']);
  assert.equal(manager.getConfig('aliyun').username, 'admin');
});

test('JSON configuration keeps the native fingerprint and channel limit through normalization', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-json-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'servers.json');
  fs.writeFileSync(file, JSON.stringify({
    aliyun: {
      host: 'aliyun', port: 22, username: 'root', backend: 'openssh', nativeTarget: 'aliyun',
      nativeConfigHash: 'a'.repeat(64), maxConcurrentChannels: 4,
    },
  }));
  const parsed = CommandLineParser.parseArgs(['--config-file', file]).configs.aliyun;
  assert.equal(parsed.nativeConfigHash, 'a'.repeat(64));
  assert.equal(parsed.maxConcurrentChannels, 4);
});
