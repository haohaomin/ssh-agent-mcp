import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('unified stdio client discovers all tool families from imported config', {timeout:10000}, async t=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssh-agent-stdio-')), file=path.join(dir,'config');
  fs.writeFileSync(file,'Host fixture\n HostName 127.0.0.1\n User test\n');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const transport=new StdioClientTransport({command:process.execPath,args:['build/index.js','--standalone','--import-ssh-config','--ssh-config-file',file],stderr:'pipe'});
  const client=new Client({name:'unified-test',version:'1'});t.after(()=>client.close());await client.connect(transport);
  const {tools}=await client.listTools(); const names=tools.map(t=>t.name);
  for(const name of ['ssh_exec','ssh_upload','ssh_download','ssh_file_edit','ssh_file_grep','ssh_file_glob','ssh_sync','ssh_session_ensure','ssh_job_start','ssh_forward_start','ssh_forward_reverse']) assert.ok(names.includes(name),name);
  const schemas = Object.fromEntries(tools.map(t => [t.name, t.inputSchema.properties || {}]));
  for (const props of Object.values(schemas)) for (const old of ['cmdString','directory','timeout','offset','id','target']) assert.ok(!(old in props), `Legacy parameter ${old}`);
  for (const key of ['command','cwd','env','timeoutMs']) assert.ok(key in schemas.ssh_exec);
  for (const key of ['command','cwd','env']) assert.ok(key in schemas.ssh_job_start);
  assert.ok('offsetChars' in schemas.ssh_session_read);assert.ok('offsetBytes' in schemas.ssh_file_read);assert.ok('forwardId' in schemas.ssh_forward_stop);
  assert.ok(names.includes('ssh_directory_list'));assert.ok(!names.includes('ssh_view'));assert.ok(!names.includes('ssh_create'));
  assert.ok(names.every(n=>n.startsWith('ssh_')));assert.equal(names.length,new Set(names).size);
  const listed=await client.callTool({name:'ssh_server_list',arguments:{}});assert.match(listed.content[0].text,/fixture/);
  const invalid=await client.callTool({name:'ssh_file_read',arguments:{remotePath:'/x',format:'lines',startLine:0}});assert.equal(invalid.isError,true);
});
