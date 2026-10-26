#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('..',import.meta.url));
const entry=path.join(root,'build','index.js');
if(!fs.existsSync(entry))throw new Error('Run npm run build first');
const configPath=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'config.toml');
const before=fs.existsSync(configPath)?fs.readFileSync(configPath,'utf8'):'';
const section=/^\[mcp_servers\.ssh-agent\][\s\S]*?(?=^\[|$(?![\s\S]))/m;
const current=before.match(section)?.[0];
if(current && !current.includes(JSON.stringify(entry)))throw new Error('An unrelated ssh-agent MCP entry already exists. It was not overwritten.');
if(before){const backup=configPath+'.before-ssh-agent-'+Date.now();fs.copyFileSync(configPath,backup);fs.chmodSync(backup,0o600);console.log('Configuration backup: '+backup);}
if(!current)execFileSync('codex',['mcp','add','ssh-agent','--',process.execPath,entry,'--import-ssh-config'],{stdio:'inherit'});
let text=fs.readFileSync(configPath,'utf8');
let block=text.match(section)?.[0];
if(!block)throw new Error('Codex MCP registration did not create the expected section');
// Pin cwd because it is an allowed local-file root and part of service identity.
for(const [key,value] of Object.entries({cwd:root,env_vars:['SSH_AUTH_SOCK'],startup_timeout_sec:30})){
  const line=key+' = '+JSON.stringify(value)+'\n';
  const pattern=new RegExp('^'+key+'\\s*=.*\\n?','m');
  if(!pattern.test(block))block=block.trimEnd()+'\n'+line+'\n';
}
text=text.replace(section,()=>block);
const temp=configPath+'.ssh-agent-'+process.pid;
fs.writeFileSync(temp,text,{mode:0o600,flag:'wx'});fs.renameSync(temp,configPath);
console.log('Registered ssh-agent. Existing MCP entries preserved. Reload MCP connections or reopen Codex to load it.');
