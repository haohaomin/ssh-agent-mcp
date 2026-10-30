import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { registerExecuteCommandTool } from '../build/tools/execute-command.js';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';
import { ToolError } from '../build/utils/tool-error.js';

describe('execute-command 工具返回格式', () => {
  let handler;
  let manager;
  let originalExecute;

  beforeEach(() => {
    manager = SSHConnectionManager.getInstance();
    originalExecute = manager.executeCommand;
    registerExecuteCommandTool({
      registerTool(_name, _meta, fn) {
        handler = fn;
      },
    });
  });

  afterEach(() => {
    manager.executeCommand = originalExecute;
  });

  it('成功时原样返回输出', async () => {
    manager.executeCommand = async () => 'hello';
    const result = await handler({ command: 'echo hello' });
    assert.deepStrictEqual(result.content, [{ type: 'text', text: 'hello' }]);
    assert.equal(result.structuredContent.output, 'hello');
    assert.equal(result.structuredContent.exitCode, null); // Stub supplied no transport metadata.
  });

  it('非零退出码返回原始输出加 [exit code]，不是工具错误也不包 JSON', async () => {
    manager.executeCommand = async () => {
      throw new ToolError('COMMAND_EXECUTION_ERROR', 'partial\n[exit code] 1', false, true);
    };
    const result = await handler({ command: 'grep nomatch f' });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0].text, 'partial\n[exit code] 1');
  });

  it('超时、校验失败等真正的错误仍然是 isError 加 JSON', async () => {
    manager.executeCommand = async () => {
      throw new ToolError('COMMAND_TIMEOUT', '[timeout] Command timed out after 10ms', true);
    };
    const result = await handler({ command: 'sleep 100' });
    assert.strictEqual(result.isError, true);
    assert.deepStrictEqual(JSON.parse(result.content[0].text), {
      code: 'COMMAND_TIMEOUT',
      message: '[timeout] Command timed out after 10ms',
      retriable: true,
    });
  });
});

describe('统一命令参数', () => {
  it('command/cwd/env/timeoutMs reaches execution without evaluating environment values', async () => {
    const {withEnvironment}=await import('../build/utils/shell.js');
    const {execFileSync}=await import('node:child_process');
    const value="a'\n$(printf BAD)`printf BAD`; $HOME";
    assert.strictEqual(execFileSync('/bin/sh',['-c',withEnvironment('printf %s "$VALUE"',{VALUE:value})],{encoding:'utf8'}),value);
    assert.throws(()=>withEnvironment('true',{'BAD;key':'x'}),/Invalid/);
    const manager=SSHConnectionManager.getInstance(),original=manager.executeCommand;
    let handler,received;
    registerExecuteCommandTool({registerTool(_n,_m,h){handler=h;}});
    try {
      manager.executeCommand=async(...args)=>{received=args;return 'ok';};
      await handler({command:'pwd',cwd:'/srv',env:{LANG:'C'},timeoutMs:1234,connectionName:'dev'});
      assert.deepStrictEqual(received,['pwd','/srv','dev',{
        timeout:1234,
        env:{LANG:'C'},
        script:undefined,
        steps:undefined,
        stopOnError:undefined,
        failFast:undefined,
        envFromRemoteFiles:undefined,
        interpreter:undefined,
        sudo:false,
        maxBytes:65536,
      }]);
    } finally {manager.executeCommand=original;}
  });

  it('script/interpreter/sudo/maxBytes reaches execution unchanged', async () => {
    const manager=SSHConnectionManager.getInstance(),original=manager.executeCommand;
    let handler,received;
    registerExecuteCommandTool({registerTool(_n,_m,h){handler=h;}});
    const script='key="a b"\nprintf \'%s\n\' "$key"\n';
    try {
      manager.executeCommand=async(...args)=>{received=args;return 'ok';};
      await handler({
        script,
        cwd:'/srv',
        env:{LANG:'C'},
        interpreter:'sh',
        sudo:true,
        maxBytes:2048,
        timeoutMs:4321,
        connectionName:'dev',
      });
      assert.deepStrictEqual(received,[undefined,'/srv','dev',{
        timeout:4321,
        env:{LANG:'C'},
        script,
        steps:undefined,
        stopOnError:undefined,
        failFast:undefined,
        envFromRemoteFiles:undefined,
        interpreter:'sh',
        sudo:true,
        maxBytes:2048,
      }]);
    } finally {manager.executeCommand=original;}
  });

  it('command 与 script 必须且只能提供一个', async () => {
    const manager=SSHConnectionManager.getInstance(),original=manager.executeCommand;
    let handler,calls=0;
    registerExecuteCommandTool({registerTool(_n,_m,h){handler=h;}});
    manager.executeCommand=async()=>{calls+=1;return 'unexpected';};
    try {
      for (const args of [{}, {command:'pwd',script:'pwd'}]) {
        const result=await handler(args);
        assert.strictEqual(result.isError,true);
        const error=JSON.parse(result.content[0].text);
        assert.strictEqual(error.code,'COMMAND_VALIDATION_FAILED');
        assert.match(error.message,/Exactly one of command, script or steps/);
      }
      assert.strictEqual(calls,0);
    } finally {manager.executeCommand=original;}
  });
});
