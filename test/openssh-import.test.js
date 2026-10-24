import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { importOpenSsh } from '../build/utils/openssh-import.js';
import { knownHostVerifier } from '../build/utils/host-verifier.js';

function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-agent-import-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('imports aliases, Include, quotes, first-match defaults, negation and ProxyJump', t => {
  const dir = fixture(t), key = path.join(dir, 'key with spaces'); fs.writeFileSync(key, 'fixture');
  fs.writeFileSync(path.join(dir, 'included'), `Host jump\n HostName bastion.test\n User jumpuser\nHost prod\n HostName app.test\n ProxyJump jump\n IdentityFile "${key}"\n IdentityAgent none\nHost prod\n User ignored\n`);
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, `Host prod\n User alice\nHost *\nInclude "${dir}/included"\nHost * !jump\n Port=2222\nHost *\n User fallback\n`);
  const result = importOpenSsh(file);
  assert.deepEqual(Object.keys(result.configs).sort(), ['jump', 'prod']);
  assert.equal(result.configs.prod.host, 'app.test'); assert.equal(result.configs.prod.username, 'alice');
  assert.equal(result.configs.prod.port, 2222); assert.equal(result.configs.prod.privateKey, key);
  assert.equal(result.configs.prod.jumpHosts[0].host, 'bastion.test'); assert.equal(result.configs.jump.port, 22);
});
test('does not execute Match exec or ProxyCommand; reports skipped aliases', t => {
  const dir = fixture(t), marker = path.join(dir, 'executed'), file = path.join(dir, 'config');
  fs.writeFileSync(file, `Host unsafe\n ProxyCommand touch ${marker}\nHost safe\n HostName safe.test\n`);
  let result = importOpenSsh(file); assert.equal(result.configs.unsafe.backend, 'openssh'); assert.ok(result.configs.safe); assert.ok(!fs.existsSync(marker));
  fs.appendFileSync(file, `Match exec "touch ${marker}"\n User root\n`);
  result = importOpenSsh(file); assert.equal(result.configs.safe.backend, 'openssh'); assert.ok(!fs.existsSync(marker));
});
test('Include and ProxyJump cycles are rejected', t => {
  const dir = fixture(t), file = path.join(dir, 'config');
  fs.writeFileSync(file, `Include ${file}\n`); assert.throws(() => importOpenSsh(file), /cycle/);
  fs.writeFileSync(file, 'Host a\n ProxyJump b\nHost b\n ProxyJump a\n'); assert.match(importOpenSsh(file).skipped.a, /cycle/);
});
test('wildcard hosts require a selected concrete name; prototype names remain data', t => {
  const dir = fixture(t), file = path.join(dir, 'config'); fs.writeFileSync(file, 'Host *.test\n User alice\nHost __proto__\n User bob\n');
  assert.equal(importOpenSsh(file).configs.__proto__.username, 'bob');
  assert.equal(importOpenSsh(file, ['dev.test']).configs['dev.test'].username, 'alice');
});
test('CLI exports references, never passphrase, refuses overwriting files', t => {
  const dir = fixture(t), file = path.join(dir, 'config'), output = path.join(dir, 'hosts.json'); fs.writeFileSync(file, 'Host local\n HostName localhost\n');
  const args = ['build/index.js','import','--file',file,'--output',output];
  let result = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, SSH_MCP_PASSPHRASE: 'do-not-export' } });
  assert.equal(result.status, 0, result.stderr); assert.ok(!fs.readFileSync(output,'utf8').includes('do-not-export'));
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  result = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.notEqual(result.status, 0);
});
test('host verification supports hashed hosts, rejects changed and revoked keys', t => {
  const dir = fixture(t), file = path.join(dir,'known_hosts'), key = Buffer.from('host-key'), salt = Buffer.from('salt');
  const hash = createHmac('sha1',salt).update('[example]:2222').digest('base64');
  fs.writeFileSync(file, `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${key.toString('base64')}\n`);
  assert.ok(knownHostVerifier(file,'[example]:2222')(key)); assert.ok(!knownHostVerifier(file,'[example]:2222')(Buffer.from('changed')));
  fs.appendFileSync(file, `@revoked [example]:2222 ssh-ed25519 ${key.toString('base64')}\n`); assert.ok(!knownHostVerifier(file,'[example]:2222')(key));
});
test('conditional Include does not leak options into unrelated hosts', t => {
  const dir=fixture(t), file=path.join(dir,'config'); fs.writeFileSync(path.join(dir,'private'),'User private-user\n');
  fs.writeFileSync(file,`Host private\n Include ${dir}/private\nHost public\n User public-user\n`);
  const result=importOpenSsh(file); assert.equal(result.configs.public.username,'public-user'); assert.equal(result.configs.private.username,'private-user');
});
test('import CLI applies explicit authentication and policy overrides and permits disabled keepalive', async t => {
  const {CommandLineParser}=await import('../build/cli/command-line-parser.js');
  const dir=fixture(t), file=path.join(dir,'config');fs.writeFileSync(file,'Host fixture\n ServerAliveInterval 0\n');
  const previous=process.argv;
  try {
    process.argv=['node','test','--import-ssh-config','--ssh-config-file',file,'--password','fixture-password','--whitelist','^ls$'];
    const config=CommandLineParser.parseArgs().configs.fixture;
    assert.equal(config.keepaliveIntervalMs,0);assert.equal(config.password,'fixture-password');assert.equal(config.agent,undefined);assert.equal(config.privateKey,undefined);assert.deepEqual(config.commandWhitelist,['^ls$']);
  } finally {process.argv=previous;}
});
