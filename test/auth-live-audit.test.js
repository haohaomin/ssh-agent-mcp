import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {localSshd} from './helpers/local-sshd.js';
import {SSHConnectionManager} from '../build/services/ssh-connection-manager.js';
import {importOpenSsh} from '../build/utils/openssh-import.js';

for(const backend of ['ssh2','openssh']) {
  test(`encrypted private key authenticates with passphrase (${backend})`,{timeout:20000},async t=>{
    const fixture=await localSshd(t),manager=SSHConnectionManager.getInstance();
    execFileSync('ssh-keygen',['-q','-p','-P','','-N','test-only-passphrase','-f',path.join(fixture.root,'user')],{stdio:'ignore'});
    const config=backend==='ssh2'?fixture.config:importOpenSsh(fixture.clientConfig).configs.fixture;
    manager.setConfig({fixture:{...config,passphrase:'test-only-passphrase',pty:false}});manager.scheduleStatusCollection=()=>{};t.after(()=>manager.disconnect());
    assert.equal(await manager.executeCommand('printf authenticated',undefined,'fixture'),'authenticated');
  });
  test(`changed host key rejects connection before command execution (${backend})`,{timeout:15000},async t=>{
    const fixture=await localSshd(t),manager=SSHConnectionManager.getInstance();
    fs.writeFileSync(path.join(fixture.root,'known_hosts'),`[127.0.0.1]:${fixture.port} ${fs.readFileSync(path.join(fixture.root,'ca.pub'),'utf8')}`);
    const config=backend==='ssh2'?fixture.config:importOpenSsh(fixture.clientConfig).configs.fixture;
    manager.setConfig({fixture:config});manager.scheduleStatusCollection=()=>{};t.after(()=>manager.disconnect());
    await assert.rejects(manager.connect('fixture'),/host|verification|OpenSSH/i);
  });
}
