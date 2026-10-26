import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {localSshd} from './helpers/local-sshd.js';
const entry=path.resolve('build/index.js');
function cli(args,env,cwd) {
  return new Promise((resolve,reject)=> {
    const child=spawn(process.execPath,[entry,...args],{env,cwd,stdio:['ignore','pipe','pipe']});
    let output=''; child.stdout.on('data',b=>output+=b); child.stderr.on('data',b=>output+=b);
    const timer=setTimeout(()=>{child.kill();reject(new Error('CLI timeout: '+output));},20000);
    child.on('error',reject); child.on('exit',code=> {clearTimeout(timer);code===0?resolve(output):reject(new Error(output));});
  });
}
test('automatic shared service with real stdio clients and SSH', {timeout:60000}, async t=> {
  const fixture=await localSshd(t);
  const dir=path.join(fixture.root,'state'), config=path.join(fixture.root,'servers.json');
  fs.writeFileSync(config,JSON.stringify({fixture:fixture.config}));
  const env={...process.env,SSH_AGENT_STATE_DIR:dir}; delete env.SSH_MCP_HTTP_TOKEN;
  const occupied=net.createServer(); await new Promise(r=>occupied.listen(0,'127.0.0.1',r));
  const args=['--config-file',config,'--http-port',String(occupied.address().port)];
  const clients=[];
  t.after(async()=>{for(const client of clients)await client.close().catch(()=>{});await cli(['service','stop'],env,fixture.root).catch(()=>{});await new Promise(r=>occupied.close(r));await delay(300);});
  const makeClient=async()=> {
    const client=new Client({name:'shared-test',version:'1'});clients.push(client);
    await client.connect(new StdioClientTransport({command:process.execPath,args:[entry,...args],env,cwd:fixture.root,stderr:'pipe'}));return client;
  };
  let service;
  const records=()=>fs.readdirSync(path.join(dir,'services')).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(dir,'services',n),'utf8')));
  const [a,b]=await Promise.all([makeClient(),makeClient()]);
  await t.test('concurrent legacy clients start only one service, with occupied-port fallback',async()=> {
    const services=records();assert.equal(services.length,1);service=services[0];
    assert.notEqual(Number(new URL(service.endpoint).port),occupied.address().port);
    assert.equal((await a.listTools()).tools.length,31);assert.equal((await b.listTools()).tools.length,31);
    assert.equal(fs.statSync(path.join(dir,'services',service.key+'.json')).mode&0o777,0o600);
  });
  await t.test('UI launcher reuses the same service without client configuration changes',async()=> {
    const output=await cli([...args,'--ui','--no-open'],env,fixture.root);
    assert.ok(output.includes(service.ui));assert.equal(records().length,1);
    assert.equal((await fetch(service.ui)).status,200);
    assert.equal((await fetch(new URL('api/activity',service.ui))).status,401);
  });
  await t.test('both clients share actual command activity, including simultaneous request IDs',async()=> {
    const result=await Promise.all([a.callTool({name:'ssh_exec',arguments:{command:'printf shared_A',connectionName:'fixture'}}),b.callTool({name:'ssh_exec',arguments:{command:'printf shared_B',connectionName:'fixture'}})]);
    assert.ok(JSON.stringify(result[0]).includes('shared_A'));assert.ok(JSON.stringify(result[1]).includes('shared_B'));
    const response=await fetch(new URL('api/activity',service.ui),{headers:{Authorization:'Bearer '+service.token}});
    const body=await response.text();assert.ok(body.includes('shared_A'));assert.ok(body.includes('shared_B'));
  });
  await t.test('disconnecting all clients keeps workbench and history alive',async()=> {
    await a.close();await b.close();await delay(100);
    const status=await cli(['service','status'],env,fixture.root);assert.ok(status.includes(String(service.pid)));
    assert.equal((await fetch(service.ui)).status,200);
  });
  await t.test('different restrictions do not join the existing service',async()=> {
    const restricted=path.join(fixture.root,'restricted.json');
    fs.writeFileSync(restricted,JSON.stringify({fixture:{...fixture.config,commandWhitelist:['^echo$']}}));
    await cli(['--config-file',restricted,'--ui','--no-open'],env,fixture.root);
    assert.equal(records().length,2);
  });
  await t.test('dead daemon and stale lock are recovered on next client launch',async()=> {
    process.kill(service.pid,'SIGKILL');await delay(200);
    const lock=path.join(dir,'services',service.key+'.lock');fs.writeFileSync(lock,JSON.stringify({pid:2147483647}));
    const old=new Date(Date.now()-5000);fs.utimesSync(lock,old,old);
    const c=await makeClient();assert.equal((await c.listTools()).tools.length,31);
    const recovered=records().find(r=>r.key===service.key);assert.notEqual(recovered.pid,service.pid);
    process.kill(recovered.pid,'SIGKILL');await delay(150);
    await assert.rejects(c.callTool({name:'ssh_exec',arguments:{command:'printf do_not_replay',connectionName:'fixture'}}),/not retried/);
    assert.equal((await c.listTools()).tools.length,31);
    const latest=records().find(r=>r.key===service.key);
    const history=await fetch(new URL('api/activity',latest.ui),{headers:{Authorization:'Bearer '+latest.token}});
    assert.ok(!(await history.text()).includes('do_not_replay'));
  });
  await t.test('authenticated stop manages daemon lifetime and rejects anonymous management',async()=> {
    const current=records().find(r=>r.key===service.key);
    assert.equal((await fetch(new URL('/.well-known/ssh-agent-mcp',current.endpoint),{method:'DELETE'})).status,401);
    await cli(['service','stop'],env,fixture.root);await delay(400);
    assert.match(await cli(['service','status'],env,fixture.root),/No running shared services/);
  });
});
