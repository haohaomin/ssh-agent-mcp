import { test } from 'node:test';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';

const keys = utils.generateKeyPairSync('ed25519');
async function sshServer(t) {
  const clients = new Set(), sockets = new Set(), listeners = new Set();
  const server = new Server({hostKeys:[keys.private]}, client => {
    clients.add(client); client.on('error',()=>{}); client.on('close',()=>clients.delete(client));
    client.on('authentication',ctx => ctx.method === 'password' && ctx.password === 'fixture' ? ctx.accept() : ctx.reject());
    client.on('ready',()=> {
      client.on('session',accept=> {
        const session=accept(); session.on('pty', accept=>accept());
        session.on('shell',accept=> { const stream=accept(); stream.on('error',()=>{}); stream.write('ready\n'); stream.on('data',data=>stream.write(Buffer.concat([Buffer.from('echo:'),data]))); });
        session.on('exec',(accept, _reject, info)=> { const stream=accept(); stream.write(info.command); stream.exit(0); stream.end(); });
      });
      client.on('tcpip',(accept,reject,info)=> {
        const socket=net.connect(info.destPort,info.destIP); sockets.add(socket); socket.on('close',()=>sockets.delete(socket));
        socket.once('error',()=>reject()); socket.once('connect',()=> { const stream=accept(); stream.on('error',()=>socket.destroy()); socket.on('close',()=>stream.destroy()); stream.on('close',()=>socket.destroy()); stream.pipe(socket).pipe(stream); });
      });
      client.on('request',(accept,reject,name,info)=> {
        if (name==='tcpip-forward') {
          const listener=net.createServer(socket=> {
            sockets.add(socket); socket.on('error',()=>{}); socket.on('close',()=>sockets.delete(socket));
            client.forwardOut(info.bindAddr,listener.address().port,'127.0.0.1',socket.remotePort,(err,stream)=> { if(err){socket.destroy();return;} stream.on('error',()=>socket.destroy()); stream.on('close',()=>socket.destroy()); socket.on('close',()=>stream.destroy()); socket.pipe(stream).pipe(socket); });
          });
          listeners.add(listener); listener.on('error',()=>reject()); listener.listen(info.bindPort,info.bindAddr,()=>accept(listener.address().port));
        } else if (name==='cancel-tcpip-forward') {
          for(const listener of listeners) if(listener.address()?.port===info.bindPort){listener.close();listeners.delete(listener);} accept();
        } else reject();
      });
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=> { for(const s of sockets)s.destroy(); for(const c of clients)c.end(); for(const l of listeners)l.close(); await new Promise(resolve=>server.close(resolve)); });
  return {host:'127.0.0.1',port:server.address().port,username:'fixture',password:'fixture',pty:false};
}
async function receive(port,value) {
  return new Promise((resolve,reject)=> { const socket=net.connect(port,'127.0.0.1',()=>socket.write(value)); let result=''; socket.setTimeout(3000,()=>socket.destroy(new Error('timeout'))); socket.on('error',reject); socket.on('data',data=> {result+=data; if(result.length>=value.length){socket.destroy();resolve(result);}}); });
}
test('real ssh2 transport: exec, persistent shell, local/reverse forwards and cleanup', {timeout:15000}, async t=> {
  const config=await sshServer(t), manager=SSHConnectionManager.getInstance(); manager.setConfig({fixture:config});
  manager.scheduleStatusCollection=()=>{}; t.after(()=>manager.disconnect());
  assert.match(await manager.executeCommand('hello',undefined,'fixture'),/hello/);
  await manager.interactive.start('terminal','fixture');
  await manager.interactive.start('terminal','fixture',true);
  await assert.rejects(manager.interactive.start('terminal','fixture'),/already/);
  manager.interactive.write('terminal','你好\n');
  let output=''; for(let n=0;n<30;n++){output=manager.interactive.read('terminal').output;if(output.includes('你好'))break;await delay(20);}
  assert.match(output,/echo:你好/);
  const echo=net.createServer(s=>{s.on('error',()=>{});s.pipe(s);}); await new Promise(resolve=>echo.listen(0,'127.0.0.1',resolve)); t.after(()=>echo.close());
  const local=await manager.interactive.forward('127.0.0.1',echo.address().port,0,'fixture'); assert.equal(await receive(local.localPort,'forward'),'forward');
  const reverse=await manager.interactive.reverseForward('127.0.0.1',echo.address().port,0,'fixture'); assert.equal(await receive(reverse.remotePort,'reverse'),'reverse');
  manager.interactive.stopForward(local.forwardId); manager.interactive.stopForward(reverse.forwardId); manager.interactive.stop('terminal');
  assert.deepEqual(manager.interactive.list(),[]); assert.deepEqual(manager.interactive.listForwards(),[]);
});
test('real ssh2 transport connects through a jump host', {timeout:15000}, async t=> {
  const jump=await sshServer(t), target=await sshServer(t), manager=SSHConnectionManager.getInstance();
  manager.setConfig({target:{...target,jumpHosts:[jump]}}); manager.scheduleStatusCollection=()=>{}; t.after(()=>manager.disconnect());
  assert.match(await manager.executeCommand('through-jump',undefined,'target'),/through-jump/);
});
test('interactive terminals cannot bypass configured command filters', async()=> {
  const manager=SSHConnectionManager.getInstance();manager.setConfig({limited:{host:'localhost',port:22,username:'x',password:'x',commandWhitelist:['^ls$']}});
  await assert.rejects(manager.interactive.start('blocked','limited'),/unrestricted/); manager.disconnect();
});
