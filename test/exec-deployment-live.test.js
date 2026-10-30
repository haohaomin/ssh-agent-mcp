import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {localSshd} from './helpers/local-sshd.js';
import {SSHConnectionManager} from '../build/services/ssh-connection-manager.js';
import {importOpenSsh} from '../build/utils/openssh-import.js';
import {registerExecuteCommandTool} from '../build/tools/execute-command.js';
import {shellQuote} from '../build/utils/shell.js';
import {ActivityLog} from '../build/services/activity-log.js';

for (const backend of ['ssh2','openssh']) test(`deployment execution over real SSH (${backend})`, {timeout:30000}, async t => {
  const cleanups=[];
  const f=await localSshd({after(fn){cleanups.push(fn);}}), manager=SSHConnectionManager.getInstance();
  const config={...(backend==='ssh2'?f.config:importOpenSsh(f.clientConfig).configs.fixture),allowedRemotePaths:[f.root],pty:true};
  const previous=process.env.SSH_AGENT_STATE_DIR;
  process.env.SSH_AGENT_STATE_DIR=path.join(f.root,'state');
  const activity=new ActivityLog(path.join(f.root,'activity.json'));
  manager.activity={log:activity};
  manager.scheduleStatusCollection=()=>{};
  t.after(async()=>{
    manager.disconnect(); activity.close(); manager.activity=undefined;
    if(previous===undefined)delete process.env.SSH_AGENT_STATE_DIR;else process.env.SSH_AGENT_STATE_DIR=previous;
    for(const cleanup of cleanups.reverse())await cleanup();
  });
  manager.setConfig({fixture:config});
  let handler, schema;
  registerExecuteCommandTool({registerTool(n,m,h){schema=z.object(m.inputSchema);handler=h;}});
  const invoke=async args=>activity.run('ssh_exec','mcp',args,'fixture',()=>handler(schema.parse({connectionName:'fixture',...args})));
  const text=result=>result.content.map(c=>c.text||'').join('\n');
  const call=async args=>{const result=await invoke(args);assert(!result.isError,text(result));return text(result);};

  await t.test('literal multiline stdin, quoting, loops and both interpreters', async()=>{
    for (const interpreter of ['bash','sh']) {
      const output=await call({interpreter,script:"value=\"中文 'quoted' \\\"double\\\"\"\nprintf '%s\\n' \"$value\"\nfor port in 80 443; do printf '%s\\n' \"$port\"; done\ncat <<'SQL'\nCASE WHEN is_stream THEN 'stream' ELSE 'non-stream' END\nSQL\n"});
      assert.equal(output,"中文 'quoted' \"double\"\n80\n443\nCASE WHEN is_stream THEN 'stream' ELSE 'non-stream' END");
    }
  });
  await t.test('58-line Python script preserves JSON, SQL, quotes and stdin source identity',async()=>{
    const script=fs.readFileSync(new URL('./fixtures/python-stdin.py',import.meta.url),'utf8');
    const result=JSON.parse(await call({script,interpreter:'python3'}));
    assert.equal(result.source,'<stdin>');assert.deepEqual(result.argv,['-']);
    assert.deepEqual(result.records.map(row=>row.mode),['stream','non-stream']);
    const payload=result.records[0].payload;
    assert.equal(payload.message,"中文 'single' \"double\"");
    assert.equal(payload.shell,'~/$HOME/$(printf expanded)/`printf expanded`');
    assert.equal(payload.path,'C:\\scripts\\example.py');
    assert.equal(payload.lines,'first\nsecond\nthird');
    assert.deepEqual(result.records[1].payload,payload);
  });
  await t.test('Python errors stop execution and retain traceback and explicit exit status',async()=>{
    const exception=await call({script:'raise RuntimeError("python probe failed")\nprint("should-not-run")',interpreter:'python3'});
    assert.match(exception,/RuntimeError: python probe failed/);assert.match(exception,/\[exit code\] 1$/);
    assert(!exception.includes('should-not-run'));assert.equal(activity.list().at(-1).status,'failed');
    assert.match(await call({script:'import sys\nsys.exit(7)',interpreter:'python3',maxBytes:1}),/\[exit code\] 7$/);
    const syntax=await call({script:'print("should-not-run")\nif:',interpreter:'python3'});
    assert.match(syntax,/SyntaxError/);assert.match(syntax,/\[exit code\] 1$/);
  });
  await t.test('Python keeps cwd/env/remote-file injection and emits unbuffered output before timeout',async()=>{
    const file=path.join(f.root,'python-secret');fs.writeFileSync(file,'python-test-only-secret\n',{mode:0o600});
    const result=JSON.parse(await call({
      script:'import os, json\nassert os.environ["KEY"] == "python-test-only-secret"\nprint(json.dumps({"cwd":os.getcwd(),"value":os.environ["VALUE"]}))',
      interpreter:'python3',cwd:f.root,env:{VALUE:"a'b \" $literal"},envFromRemoteFiles:{KEY:file},
    }));
    assert.deepEqual(result,{cwd:f.root,value:"a'b \" $literal"});
    const timeout=await invoke({script:'import time\nprint("python-progress")\ntime.sleep(3)',interpreter:'python3',timeoutMs:1000});
    assert(timeout.isError);
    const error=JSON.parse(text(timeout));assert.equal(error.code,'COMMAND_TIMEOUT');assert.match(error.message,/python-progress/);
    assert.equal(await call({script:'print("python-recovered")',interpreter:'python3'}),'python-recovered');
  });
  await t.test('failFast detects failures including bash pipelines, opt-out stays compatible',async()=>{
    assert.match(await call({script:'false\nprintf continued'}),/continued/);
    for(const script of ['false\nprintf should-not-run','false | true\nprintf should-not-run']){
      const output=await call({script,failFast:true});
      assert.match(output,/\[exit code\] 1$/);assert(!output.includes('should-not-run'));
    }
    assert.match(await call({script:'false\nprintf should-not-run',interpreter:'sh',failFast:true}),/\[exit code\] 1$/);
  });
  await t.test('steps share state, stop on inner failure and can continue while retaining failure',async()=>{
    const result=await call({steps:[`cd ${shellQuote(f.root)}`,'export SAVED=value','printf "%s|%s" "$PWD" "$SAVED"']});
    assert(result.includes(`${f.root}|value`));assert.match(result,/\[step 3\/3 exit code\] 0/);
    const stopped=await call({steps:['printf first','false; printf should-not-run','printf also-not-run']});
    assert.match(stopped,/\[step 2\/3 exit code\] 1/);assert.match(stopped,/\[exit code\] 1$/);
    assert(!stopped.includes('should-not-run'));assert(!stopped.includes('also-not-run'));
    const continued=await call({steps:['false','printf continued'],stopOnError:false});
    assert.match(continued,/continued/);assert.match(continued,/\[step 2\/2 exit code\] 0/);assert.match(continued,/\[exit code\] 1$/);
    assert.match(await call({steps:['exit 7','printf should-not-run']}),/\[step 1\/2 exit code\] 7[\s\S]*\[exit code\] 7$/);
    assert.match(await call({steps:['printf sh-step'],interpreter:'sh'}),/sh-step/);
  });
  await t.test('remote-file injection stays remote and respects symlink roots',async()=>{
    const file=path.join(f.root,"key 'quoted'.txt"), marker=path.join(f.root,'must-not-exist');
    const secret=`test-only-秘密'\"$(touch ${marker})\nsecond-line`;
    fs.writeFileSync(file,secret+'\n\n',{mode:0o600});
    const output=await call({script:'printf %s "$KEY" | shasum -a 256',envFromRemoteFiles:{KEY:file}});
    assert(output.includes(createHash('sha256').update(secret).digest('hex')));
    assert(!output.includes(secret));assert(!fs.existsSync(marker));
    assert.equal(await call({command:'test -n "$KEY" && printf present',envFromRemoteFiles:{KEY:file}}),'present');
    const missing=await call({script:'printf should-not-run',envFromRemoteFiles:{KEY:path.join(f.root,'missing')}});
    assert.match(missing,/\[env file error\] Unable to read KEY/);assert.match(missing,/\[exit code\] 1$/);assert(!missing.includes('should-not-run'));
    const link=path.join(f.root,'outside-key');fs.symlinkSync('/etc/passwd',link);
    const denied=await invoke({command:'true',envFromRemoteFiles:{KEY:link}});
    assert(denied.isError);assert.match(text(denied),/REMOTE_PATH_NOT_ALLOWED/);
    assert(!JSON.stringify(activity.list()).includes(secret));
    activity.flush();assert(!fs.readFileSync(activity.file,'utf8').includes(secret));
  });
  await t.test('budgets preserve failure, signal and timeout markers and save complete UTF-8 output',async()=>{
    assert.match(await call({script:'exit 7',maxBytes:1}),/\[exit code\] 7$/);
    assert.equal(activity.list().at(-1).status,'failed');
    const signal=await call({script:'kill -TERM $$',maxBytes:1});
    // Native ssh exposes its process status (255 for remote signal death); ssh2 exposes the SSH signal packet.
    assert.match(signal,backend==='ssh2'?/\[signal\] (?:SIG)?TERM$/:/\[exit code\] 255$/);
    const limited=await call({script:"printf '始abcdefghij终'",maxBytes:8});
    assert(!limited.includes('\ufffd'));
    assert.equal(fs.readFileSync(/full output: (.+)\]/.exec(limited)[1],'utf8'),'始abcdefghij终');
    const defaults=await call({script:"head -c 70000 /dev/zero | tr '\\000' x"});
    assert.match(defaults,/output truncated/);
    assert.equal(fs.readFileSync(/full output: (.+)\]/.exec(defaults)[1],'utf8').length,70000);
    const timeout=await invoke({script:'printf progress; sleep 1',timeoutMs:100,maxBytes:1});
    assert(timeout.isError);assert.match(JSON.parse(text(timeout)).message,/\[timeout\] Command timed out after 100ms$/);
  });
  await t.test('sudo wrapper preserves cwd, env and stdin without needing host sudo privileges',async()=>{
    // Emulate the sudo argv contract; never elevate the test runner account.
    const template=`sudo() { [ "$1" = -n ] && [ "$2" = -- ] || return 99; shift 2; "$@"; }; <command>`;
    manager.setConfig({fixture:{...config,commandTemplate:template}});
    assert.equal(await call({script:'printf "%s|%s" "$PWD" "$VALUE"',sudo:true,cwd:f.root,env:{VALUE:"a'b"}}),`${f.root}|a'b`);
    const file=path.join(f.root,'sudo-key');fs.writeFileSync(file,'test-only-key');
    assert.equal(await call({script:'test -n "$KEY" && printf injected',sudo:true,envFromRemoteFiles:{KEY:file}}),'injected');
    assert.equal(await call({script:'import os\nassert os.environ["KEY"]\nprint(os.getcwd())',interpreter:'python3',sudo:true,cwd:f.root,envFromRemoteFiles:{KEY:file}}),f.root);
    manager.setConfig({fixture:{...config,commandTemplate:"sudo() { printf 'sudo: a password is required\\n' >&2; return 1; }; <command>"}});
    const denied=await call({script:'printf should-not-run',sudo:true});
    assert.match(denied,/sudo: a password is required/);assert.match(denied,/\[exit code\] 1$/);assert(!denied.includes('should-not-run'));
  });
  await t.test('hard capture limit remains distinct from returned budget',async()=>{
    manager.setConfig({fixture:{...config,maxOutputBytes:1024}});
    const result=await invoke({script:"head -c 2048 /dev/zero | tr '\\000' x",maxBytes:1});
    assert(result.isError);
    const error=JSON.parse(text(result));assert.equal(error.code,'OUTPUT_LIMIT_EXCEEDED');assert.match(error.message,/maxOutputBytes=1024; the command was aborted\.$/);
  });
  await t.test('persistent shell also retains the exit marker under a tiny budget',async()=>{
    manager.setConfig({fixture:{...config,transportMode:'shell'}});
    assert.match(await call({command:'false',maxBytes:1}),/\[exit code\] 1$/);
  });
});
