import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importOpenSsh } from '../build/utils/openssh-import.js';

// Hosts that fall back to native OpenSSH still get User/Port from the config
// file, so the imported identity has to match what ssh will actually use.
function config(t, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-native-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, contents);
  return { dir, file, result: importOpenSsh(file) };
}

test('native fallback keeps the configured User instead of the local account', t => {
  const { file, result } = config(t, 'Host aliyun\n HostName 39.105.20.124\n User root\n ConnectTimeout 10\n');
  const host = result.configs.aliyun;
  assert.equal(host.backend, 'openssh');
  assert.equal(host.username, 'root');
  assert.equal(host.nativeTarget, 'aliyun');
  assert.equal(host.nativeConfigFile, path.resolve(file));
});

test('native fallback keeps the configured Port', t => {
  const { result } = config(t, 'Host bastion\n HostName bastion.test\n User deploy\n Port 2222\n ProxyCommand ssh -W %h:%p jump\n');
  const host = result.configs.bastion;
  assert.equal(host.backend, 'openssh');
  assert.equal(host.username, 'deploy');
  assert.equal(host.port, 2222);
});

test('native fallback without a User still reports the local account', t => {
  const { result } = config(t, 'Host plain\n HostName plain.test\n ProxyCommand ssh -W %h:%p jump\n');
  assert.equal(result.configs.plain.username, os.userInfo().username);
  assert.equal(result.configs.plain.port, 22);
});

test('a Match block keeps native identity conservative instead of guessing a conditional User', t => {
  const { result } = config(t, 'Host gated\n HostName gated.test\n User root\nMatch host gated.test\n User admin\n');
  const host = result.configs.gated;
  assert.equal(host.backend, 'openssh');
  assert.equal(host.username, os.userInfo().username);
});

test('ssh2-mapped hosts keep the file identity and are not affected by the fallback', t => {
  const { result } = config(t, 'Host simple\n HostName simple.test\n User alice\n Port 2200\n');
  const host = result.configs.simple;
  assert.notEqual(host.backend, 'openssh');
  assert.equal(host.username, 'alice');
  assert.equal(host.port, 2200);
});
