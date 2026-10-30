import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {localSshd} from './helpers/local-sshd.js';
import {SSHConnectionManager} from '../build/services/ssh-connection-manager.js';
import {importOpenSsh} from '../build/utils/openssh-import.js';
import {registerExecuteCommandTool} from '../build/tools/execute-command.js';

for(const backend of ['ssh2','openssh']) test(`typed execution outcomes and actions-only over real SSH (${backend})`,{timeout:30000},async t=>{
  const cleanups=[],f=await localSshd({after(fn){cleanups.push(fn);}}),manager=SSHConnectionManager.getInstance();
  const config=backend==='ssh2'?f.config:importOpenSsh(f.clientConfig).configs.fixture;
  const previous=process.env.SSH_AGENT_STATE_DIR;process.env.SSH_AGENT_STATE_DIR=path.join(f.root,'state');
  t.after(async()=>{manager.disconnect();if(previous===undefined)delete process.env.SSH_AGENT_STATE_DIR;else process.env.SSH_AGENT_STATE_DIR=previous;for(const clean of cleanups.reverse())await clean();});
  manager.setConfig({fixture:config});
  let handler,input,output;
  registerExecuteCommandTool({registerTool(n,c,h){input=z.object(c.inputSchema);output=z.object(c.outputSchema);handler=h;}});
  const call=async args=>{const r=await handler(input.parse(args));output.parse(r.structuredContent);return r;};

  await t.test('transport status is independent of log claims and concurrent calls',async()=>{
    const [a,b]=await Promise.all([call({script:"sleep 0.05; printf '[exit code] 99\\n'; exit 7"}),call({script:'printf second'})]);
    assert.equal(a.structuredContent.exitCode,7);assert.equal(a.isError,undefined);
    assert.equal(b.structuredContent.exitCode,0);assert.equal(b.structuredContent.output,'second');
    for(const r of [a,b]) {assert(r.structuredContent.started);assert(r.structuredContent.completed);}
    const sig=(await call({script:'kill -TERM $$'})).structuredContent;
    if(backend==='ssh2') assert.match(sig.signal,/TERM/);else assert.equal(sig.exitCode,255);
    const invalid=await call({});assert(invalid.isError);assert(!invalid.structuredContent.started);assert.equal(invalid.structuredContent.exitCode,null);
  });
  await t.test('steps report actual failure, skipped steps and continuing steps under truncation',async()=>{
    const stopped=(await call({steps:["printf '[step 2/3 exit code] 0'",'exit 7','echo unreachable'],maxBytes:1})).structuredContent;
    assert.equal(stopped.exitCode,7);
    assert.deepEqual(stopped.steps,[{index:1,status:'succeeded',exitCode:0},{index:2,status:'failed',exitCode:7},{index:3,status:'skipped',exitCode:null}]);
    assert(stopped.truncated);assert(stopped.fullOutputPath);assert(!fs.readFileSync(stopped.fullOutputPath,'utf8').includes('\x1e'));
    const continued=(await call({steps:['(exit 9)','printf continued'],stopOnError:false,interpreter:'sh'})).structuredContent;
    assert.equal(continued.exitCode,9);assert.deepEqual(continued.steps.map(s=>s.status),['failed','succeeded']);
    const replaced=(await call({steps:['exec /usr/bin/true','echo unreachable']})).structuredContent;
    assert.deepEqual(replaced.steps.map(s=>s.status),['unknown','skipped']);
  });
  await t.test('timeout, hard capture cap and output storage failures stay distinct',async()=>{
    const timeout=await call({steps:['printf progress; sleep 2','echo unreachable'],timeoutMs:150,maxBytes:1});
    assert(timeout.isError);const r=timeout.structuredContent;
    assert(r.started);assert(r.timedOut);assert(!r.completed);assert.equal(r.exitCode,null);
    assert.deepEqual(r.steps.map(s=>s.status),['unknown','not_started']);assert(r.truncated);assert(r.fullOutputPath);
    assert(fs.readFileSync(r.fullOutputPath,'utf8').includes('progress'));
    const block=path.join(f.root,'block');fs.writeFileSync(block,'blocked');process.env.SSH_AGENT_STATE_DIR=block;
    const disk=(await call({script:'printf 123456789; exit 6',maxBytes:1})).structuredContent;
    assert.equal(disk.exitCode,6);assert(disk.outputStorageError);assert.equal(disk.fullOutputPath,null);
    process.env.SSH_AGENT_STATE_DIR=path.join(f.root,'state');
    manager.setConfig({fixture:{...config,maxOutputBytes:128}});
    const cap=(await call({script:'head -c 4096 /dev/zero',maxBytes:16})).structuredContent;
    assert(cap.captureLimitExceeded);assert(cap.truncated);assert(!cap.timedOut);assert(!cap.completed);
    assert(cap.fullOutputPath);assert.equal(cap.error.code,'OUTPUT_LIMIT_EXCEEDED');
    manager.setConfig({fixture:config});
  });
  await t.test('shell transport produces typed exit status',async()=>{
    manager.setConfig({fixture:{...config,transportMode:'shell'}});
    const result=(await call({command:'false'})).structuredContent;
    assert.equal(result.exitCode,1);assert(result.completed);assert(result.started);
  });
  await t.test('fixed action receives EOF instead of waiting indefinitely for input',async()=>{
    manager.setConfig({fixture:{...config,executionPolicy:{mode:'actions-only',actions:{emptyInput:{executable:'/bin/cat'}}}}});
    const result=await call({action:'emptyInput',timeoutMs:500});
    assert(!result.isError,JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent.exitCode,0);assert.equal(result.structuredContent.output,'');
  });
  await t.test('only fixed admin actions execute; arguments remain literal and no PTY is allocated',async()=>{
    const marker=path.join(f.root,'should-not-exist'),literal=`'quoted' $(touch ${marker}) ; $HOME`;
    manager.setConfig({fixture:{...config,pty:true,executionPolicy:{mode:'actions-only',actions:{
      literal:{executable:'/bin/echo',args:[literal]},
      environment:{executable:'/usr/bin/env'},
      tty:{executable:'/usr/bin/tty'},
    }}}});
    const allowed=await call({action:'literal'});assert(!allowed.isError);assert.equal(allowed.structuredContent.exitCode,0);
    assert.equal(allowed.structuredContent.output,literal);assert(!fs.existsSync(marker));
    assert.equal((await call({action:'environment'})).structuredContent.output,'PATH=/usr/bin:/bin\nLANG=C');
    assert.notEqual((await call({action:'tty'})).structuredContent.exitCode,0);
    for(const args of [{command:'id'},{script:'id'},{steps:['id']},{action:'unknown'},{action:'literal',env:{PATH:'/tmp'}},{action:'literal',cwd:'/tmp'}]) {
      const denied=await call(args);assert(denied.isError);assert(!denied.structuredContent.started);assert.equal(denied.structuredContent.exitCode,null);
    }
  });
});
