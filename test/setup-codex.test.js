import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const script=path.resolve('scripts/setup-codex.js');
test('Codex setup preserves unrelated config and registers shared launcher idempotently',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ssh-codex-setup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const config=path.join(root,'config.toml'),bin=path.join(root,'codex');
  const original='model = "test-model"\n\n[mcp_servers.other]\ncommand = "example"\n';fs.writeFileSync(config,original);
  fs.writeFileSync(bin,`#!${process.execPath}\nconst fs=require('fs');const args=process.argv.slice(2);const start=args.indexOf('--');fs.appendFileSync(process.env.CODEX_HOME+'/config.toml','\\n[mcp_servers.ssh-agent]\\ncommand = '+JSON.stringify(args[start+1])+'\\nargs = '+JSON.stringify(args.slice(start+2))+'\\n');`,{mode:0o700});
  const env={...process.env,CODEX_HOME:root,PATH:root+path.delimiter+process.env.PATH};
  execFileSync(process.execPath,[script],{env});const first=fs.readFileSync(config,'utf8');
  assert.ok(first.startsWith(original));assert.match(first,/cwd = /);assert.match(first,/env_vars = \["SSH_AUTH_SOCK"\]/);
  execFileSync(process.execPath,[script],{env});assert.equal(fs.readFileSync(config,'utf8'),first);
  assert.equal(fs.statSync(config).mode&0o777,0o600);assert.ok(fs.readdirSync(root).some(n=>n.includes('before-ssh-agent')));
});
test('Codex setup does not replace an unrelated same-name MCP server',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ssh-codex-setup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const config=path.join(root,'config.toml'),original='[mcp_servers.ssh-agent]\ncommand = "other-project"\n';fs.writeFileSync(config,original);
  assert.throws(()=>execFileSync(process.execPath,[script],{env:{...process.env,CODEX_HOME:root},stdio:'pipe'}),/unrelated/);
  assert.equal(fs.readFileSync(config,'utf8'),original);
});
