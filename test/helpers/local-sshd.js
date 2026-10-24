import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
export async function localSshd(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ssh-agent-integration-')));
  const sshd=process.env.SSH_AGENT_TEST_SSHD||'/usr/sbin/sshd';
  for(const name of ['host','user','ca'])execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',path.join(root,name)]);
  const username=os.userInfo().username;
  execFileSync('ssh-keygen',['-q','-s',path.join(root,'ca'),'-I','ssh-agent-test','-n',username,'-V','-1m:+1h',path.join(root,'user.pub')]);
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  // Keep the test login shell independent of personal zsh plugins and startup hooks.
  const conf=path.join(root,'sshd_config');
  fs.writeFileSync(conf,`Port ${port}\nListenAddress 127.0.0.1\nHostKey ${root}/host\nPidFile ${root}/pid\nUsePAM no\nSetEnv ZDOTDIR=${root}\nPrintLastLog no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nStrictModes no\nAuthorizedKeysFile ${root}/user.pub\nTrustedUserCAKeys ${root}/ca.pub\nAllowUsers ${username}\nPermitTTY yes\nAllowTcpForwarding yes\nSubsystem sftp internal-sftp\nLogLevel ERROR\n`);
  const server=spawn(sshd,['-D','-e','-f',conf],{stdio:['ignore','ignore','pipe']});let errors='';server.stderr.on('data',b=>errors+=b.toString());
  t.after(()=>{server.kill();fs.rmSync(root,{recursive:true,force:true});});
  for(let n=0;n<100;n++){if(server.exitCode!==null)throw new Error('sshd exited: '+errors);try{await new Promise((r,j)=>{const s=net.connect(port,'127.0.0.1',()=>{s.destroy();r();});s.on('error',j);});break;}catch{await delay(20);}}
  const known=path.join(root,'known_hosts');fs.writeFileSync(known,`[127.0.0.1]:${port} ${fs.readFileSync(path.join(root,'host.pub'),'utf8')}`);
  const clientConfig=path.join(root,'client_config');fs.writeFileSync(clientConfig,`Host fixture\n HostName 127.0.0.1\n Port ${port}\n User ${username}\n IdentityFile ${root}/user\n CertificateFile ${root}/user-cert.pub\n IdentitiesOnly yes\n UserKnownHostsFile ${known}\n StrictHostKeyChecking yes\nMatch host 127.0.0.1\n ServerAliveInterval 10\n`);
  return {root,port,username,clientConfig,conf,server,errors:()=>errors,config:{host:'127.0.0.1',port,username,privateKey:path.join(root,'user'),knownHostsFile:known,pty:false,allowedLocalPaths:[root],allowedRemotePaths:[root]}};
}
