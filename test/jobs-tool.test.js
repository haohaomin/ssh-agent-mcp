import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { registerJobTools } from '../build/tools/jobs.js';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';
import { ToolError } from '../build/utils/tool-error.js';

describe('job-* 工具', () => {
  let tools;
  let manager;
  let originals;

  beforeEach(() => {
    manager = SSHConnectionManager.getInstance();
    originals = {
      jobStart: manager.jobStart,
      jobStatusDetailed: manager.jobStatusDetailed,
      jobKill: manager.jobKill,
      jobList: manager.jobList,
    };
    tools = {};
    registerJobTools({
      registerTool(name, _meta, handler) {
        tools[name] = handler;
      },
    });
  });

  afterEach(() => {
    Object.assign(manager, originals);
  });

  it('注册四个工具', () => {
    assert.deepStrictEqual(Object.keys(tools).sort(), ['ssh_job_kill', 'ssh_job_list', 'ssh_job_start', 'ssh_job_status']);
  });

  it('job-start 返回 jobId 与下一步提示', async () => {
    manager.jobStart = async (cmd, dir, name) => {
      assert.deepStrictEqual([cmd, dir, name], ['make', '/srv', 'web']);
      return { jobId: 'job-abcdefgh-0000', message: 'started job-abcdefgh-0000 (pid 7)' };
    };
    const result = await tools['ssh_job_start']({ command: 'make', cwd: '/srv', connectionName: 'web' });
    assert.match(result.content[0].text, /jobId: job-abcdefgh-0000/);
    assert.match(result.content[0].text, /ssh_job_status/);
  });

  it('job-status / job-kill / job-list 把参数传给管理器', async () => {
    manager.jobStatusDetailed = async (id, opts, name) => ({output:`status ${id} ${JSON.stringify(opts)} ${name}`});
    manager.jobKill = async (id, name) => `kill ${id} ${name}`;
    manager.jobList = async (limit, name) => `list ${limit} ${name}`;

    assert.strictEqual(
      (await tools['ssh_job_status']({ jobId: 'j', offsetBytes: 5, tailBytes: 6, maxBytes: 7, connectionName: 'c' })).content[0].text,
      'status j {"offset":5,"tailBytes":6,"maxBytes":7} c',
    );
    assert.strictEqual((await tools['ssh_job_kill']({ jobId: 'j', connectionName: 'c' })).content[0].text, 'kill j c');
    assert.strictEqual((await tools['ssh_job_list']({ connectionName: 'c' })).content[0].text, 'list 20 c');
  });

  it('失败时与其他工具一致，返回 isError 与 code/message/retriable JSON', async () => {
    manager.jobKill = async () => {
      throw new ToolError('COMMAND_TIMEOUT', 'slow', true);
    };
    const result = await tools['ssh_job_kill']({ jobId: 'j' });
    assert.strictEqual(result.isError, true);
    assert.deepStrictEqual(JSON.parse(result.content[0].text), {
      code: 'COMMAND_TIMEOUT',
      message: 'slow',
      retriable: true,
    });
  });
});
