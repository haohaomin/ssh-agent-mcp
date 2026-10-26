import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {McpHttpServer} from '../build/core/http-server.js';
import {SSHConnectionManager} from '../build/services/ssh-connection-manager.js';
import {DurableSessions} from '../build/services/durable-sessions.js';
import {registerAllTools} from '../build/tools/index.js';
import {importOpenSsh} from '../build/utils/openssh-import.js';
import {localSshd} from './helpers/local-sshd.js';

for(const backend of ['ssh2','openssh']) test(`MCP request-boundary regressions (${backend})`,{timeout:45000},async t=>{
  const fixture=await localSshd(t),manager=SSHConnectionManager.getInstance();
  const allowed=path.join(fixture.root,'allowed');fs.mkdirSync(allowed);
  const config=backend==='ssh2'?{...fixture.config,allowedRemotePaths:[allowed]}:{...importOpenSsh(fixture.clientConfig).configs.fixture,allowedLocalPaths:[fixture.root],allowedRemotePaths:[allowed],pty:false};
  manager.setConfig({fixture:config,alternate:{...config}});manager.scheduleStatusCollection=()=>{};
  const previousState=process.env.SSH_AGENT_STATE_DIR;process.env.SSH_AGENT_STATE_DIR=path.join(fixture.root,'state');
  const server=new McpHttpServer({host:'127.0.0.1',port:0,path:'/mcp'},()=>{const mcp=new McpServer({name:'regression',version:'1'});registerAllTools(mcp);return mcp;},manager,'/ui');
  const endpoint=await server.listen(),clients=[];
  const makeClient=async()=>{const client=new Client({name:'request-test',version:'1'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));return client;};
  const [a,b]=await Promise.all([makeClient(),makeClient()]);
  const text=result=>result.content.map(c=>c.text||'').join('\n');
  const invoke=(client,name,args={})=>client.callTool({name,arguments:args});
  try {
    await t.test('independent requests cannot both commit the same preview, including default-name and symlink aliases',async()=>{
      const file=path.join(allowed,'edit.txt'),alias=path.join(allowed,'alias.txt');fs.writeFileSync(file,'old');fs.symlinkSync(file,alias);
      const expectedSha256=createHash('sha256').update('old').digest('hex');
      const original=manager.withSftp.bind(manager);
      manager.withSftp=(name,work)=>original(name,sftp=>{
        const rename=sftp.ext_openssh_rename.bind(sftp);
        sftp.ext_openssh_rename=(from,to,cb)=>{setTimeout(()=>rename(from,to,cb),80);};
        return work(sftp);
      });
      try {
        const results=await Promise.all([
          invoke(a,'ssh_file_edit',{remotePath:file,edits:[{oldText:'old',newText:'first'}],expectedSha256}),
          invoke(b,'ssh_file_edit',{connectionName:'fixture',remotePath:alias,edits:[{oldText:'old',newText:'second'}],expectedSha256}),
        ]);
        assert.equal(results.filter(r=>!r.isError).length,1,results.map(text).join('\n'));
        assert.match(text(results.find(r=>r.isError)),/hash differs/);
        assert.ok(['first','second'].includes(fs.readFileSync(file,'utf8')));
        assert.deepEqual(fs.readdirSync(allowed).sort(),['alias.txt','edit.txt']);
      }finally{manager.withSftp=original;}
    });
    await t.test('session ensure treats omitted and explicit default connection names identically',async()=>{
      const name='mcp-default-'+backend;
      try{
        const started=await invoke(a,'ssh_session_start',{sessionName:name});assert.ok(!started.isError,text(started));
        const ensured=await invoke(b,'ssh_session_ensure',{sessionName:name,connectionName:'fixture'});assert.ok(!ensured.isError,text(ensured));
        assert.equal(JSON.parse(text(started)).pid,JSON.parse(text(ensured)).pid);
        assert.equal(JSON.parse(text(ensured)).connectionName,'fixture');
        const omitted=await invoke(a,'ssh_session_ensure',{sessionName:name});assert.ok(!omitted.isError,text(omitted));
      }finally{await new DurableSessions(manager).stop(name).catch(()=>{});}
    });
    await t.test('byte reads and overwrite/append reject symlinks outside allowed remote roots',async()=>{
      const outside=path.join(fixture.root,'outside.txt'),alias=path.join(allowed,'outside-link');fs.writeFileSync(outside,'protected');fs.symlinkSync(outside,alias);
      for(const [name,args] of [
        ['ssh_file_read',{remotePath:alias}],
        ['ssh_file_write',{remotePath:alias,content:'overwrite',mode:'overwrite'}],
        ['ssh_file_write',{remotePath:alias,content:'append',mode:'append'}],
      ]){
        const result=await invoke(a,name,args);assert.equal(result.isError,true,`${name} followed an out-of-root symlink`);
        assert.equal(JSON.parse(text(result)).code,'REMOTE_PATH_NOT_ALLOWED');
        assert.equal(fs.readFileSync(outside,'utf8'),'protected');
      }
    });
    await t.test('transfers reject escaped and dangling destinations while valid new paths still work',async()=>{
      const outsideDir=path.join(fixture.root,'external'),dirLink=path.join(allowed,'dir-link');fs.mkdirSync(outsideDir);fs.symlinkSync(outsideDir,dirLink);
      const outside=path.join(outsideDir,'data');fs.writeFileSync(outside,'protected');
      const local=path.join(fixture.root,'upload-source');fs.writeFileSync(local,'payload');
      const dangling=path.join(allowed,'dangling');fs.symlinkSync(path.join(outsideDir,'missing'),dangling);
      const rejected=[
        ['ssh_upload',{localPath:local,remotePath:path.join(dirLink,'data')}],
        ['ssh_download',{remotePath:path.join(dirLink,'data'),localPath:path.join(fixture.root,'download')}],
        ['ssh_file_write',{remotePath:dangling,content:'outside',mode:'overwrite'}],
      ];
      for(const [name,args] of rejected){const result=await invoke(a,name,args);assert.equal(result.isError,true,text(result));assert.equal(JSON.parse(text(result)).code,'REMOTE_PATH_NOT_ALLOWED');}
      assert.equal(fs.readFileSync(outside,'utf8'),'protected');assert.ok(!fs.existsSync(path.join(outsideDir,'missing')));
      const destination=path.join(allowed,'new-file');assert.ok(!(await invoke(a,'ssh_file_write',{remotePath:destination,content:'valid',mode:'overwrite'})).isError);
      assert.equal(fs.readFileSync(destination,'utf8'),'valid');
      const tree=path.join(fixture.root,'tree');fs.mkdirSync(path.join(tree,'nested'),{recursive:true});fs.writeFileSync(path.join(tree,'nested','file'),'tree payload');
      assert.ok(!(await invoke(a,'ssh_upload',{localPath:tree,remotePath:path.join(allowed,'new-tree')})).isError);
      assert.equal(fs.readFileSync(path.join(allowed,'new-tree','nested','file'),'utf8'),'tree payload');
      assert.equal((await invoke(a,'ssh_upload',{localPath:tree,remotePath:dirLink})).isError,true);
      assert.ok(!fs.existsSync(path.join(outsideDir,'nested')));
    });
    await t.test('stopping a forward records its owning connection for both MCP and web requests',async()=>{
      for(const source of ['mcp','web']){
        const started=await invoke(a,'ssh_forward_start',{connectionName:'alternate',remoteHost:'127.0.0.1',remotePort:fixture.port});
        assert.ok(!started.isError,text(started));const {forwardId}=JSON.parse(text(started));
        if(source==='mcp')assert.ok(!(await invoke(b,'ssh_forward_stop',{forwardId})).isError);
        else assert.equal((await fetch(new URL('/ui/api/forwards/stop',endpoint),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({forwardId})})).status,200);
        const {records}=await(await fetch(new URL('/ui/api/activity',endpoint))).json();
        const record=records.find(r=>r.operation===(source==='mcp'?'ssh_forward_stop':'web_forward_stop')&&JSON.parse(r.input).forwardId===forwardId);
        assert.equal(record.connectionName,'alternate');
      }
    });
  } finally {
    for(const client of clients)await client.close();await server.close();manager.disconnect();
    if(previousState===undefined)delete process.env.SSH_AGENT_STATE_DIR;else process.env.SSH_AGENT_STATE_DIR=previousState;
    await delay(100);
  }
});
