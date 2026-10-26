import { createHash } from 'node:crypto';
import path from 'node:path';
import type { SSHConnectionManager } from './ssh-connection-manager.js';
import { DurableSessions, stateDirectory } from './durable-sessions.js';
import { ActivityLog } from './activity-log.js';

/** Follows remote work independently of whether the MCP client polls for its result. */
export class ActivityMonitor {
  readonly log: ActivityLog;
  private sessions: DurableSessions;
  private timer: NodeJS.Timeout;
  private busy = false;
  private closed = false;
  constructor(private manager: SSHConnectionManager, token?: string) {
    this.sessions = new DurableSessions(manager);
    const identity = manager.getAllServerInfos().map(({ name, host, port, username }) => ({ name, host, port, username })).sort((a, b) => a.name.localeCompare(b.name));
    const scope = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 20);
    this.log = new ActivityLog(path.join(stateDirectory(), `activity-${scope}.json`), () => {
      const secrets = token ? [token] : [];
      const collect = (config: any) => {
        for (const key of ['password', 'passphrase', 'privateKey', 'proxy', 'socksProxy']) if (config[key]) secrets.push(config[key]);
        for (const hop of config.jumpHosts || []) collect(hop);
      };
      for (const info of manager.getAllServerInfos()) collect(manager.getConfig(info.name));
      return secrets;
    });
    this.timer = setInterval(() => void this.poll(), 1000); this.timer.unref();
  }
  observe(id: string, operation: string, args: any, result: any) {
    const raw = result?.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') ?? result;
    if (operation === 'ssh_job_start') {
      const jobId = typeof raw === 'string' ? /jobId: (job-[\w-]+)/.exec(raw)?.[1] : raw?.jobId;
      if (jobId) this.log.update(id, { jobId, jobState: 'running', status: 'running', finishedAt: undefined }, true);
    }
    if (['ssh_session_start', 'ssh_session_ensure', 'ssh_session_write', 'web_sessions_start', 'web_session_write'].includes(operation)) {
      const name = args.sessionName;
      if (typeof name !== 'string') return;
      if (this.log.list().some(r => r.operation === 'session_output' && r.sessionName === name && r.status === 'running')) return;
      const connectionName = this.sessions.connectionName(name);
      this.log.start('session_output', 'monitor', { sessionName: name }, connectionName);
    }
  }
  private async poll() {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const records = this.log.list().filter(r => (r.jobId || r.operation === 'session_output') && r.status === 'running');
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, records.length) }, async () => {
        while (next < records.length && !this.closed) {
          const record = records[next++];
          try {
            if (record.jobId) {
              const key = record.connectionName || this.manager.getDefaultConnectionName();
              if (this.manager.isManuallyDisconnected(key) || !this.manager.getAllServerInfos().some(server => server.name === key && server.connected)) continue;
              const output = await this.manager.jobStatus(record.jobId, { tailBytes: 16384, maxBytes: 16384 }, record.connectionName);
              const jobState = /\[state\]\s+(\w+)/.exec(output)?.[1] || 'unknown';
              const exit = /\[exit code\]\s+(-?\d+)/.exec(output)?.[1];
              const ended = ['exited', 'killed', 'lost'].includes(jobState);
              this.log.update(record.id, { output, jobState, status: ended ? jobState === 'exited' && exit === '0' ? 'succeeded' : 'failed' : 'running', finishedAt: ended ? new Date().toISOString() : undefined });
            } else if (record.sessionName) {
              const result = await this.sessions.read(record.sessionName, 0, 1);
              const transcript = this.sessions.transcript(record.sessionName, 0, 0);
              const log = this.sessions.transcript(record.sessionName, Math.max(0, transcript.totalBytes - 16384), 16384);
              this.log.update(record.id, { output: log.output || '', status: result.closed ? 'succeeded' : 'running', finishedAt: result.closed ? new Date().toISOString() : undefined });
            }
          } catch (error) {
            this.log.update(record.id, { status: 'interrupted', result: `自动跟踪中断：${(error as Error).message}。远端任务可能仍在运行，请检查连接后查询状态。`, finishedAt: new Date().toISOString() }, true);
          }
        }
      }));
    } finally { this.busy = false; }
  }
  close() { this.closed = true; clearInterval(this.timer); this.log.close(); }
}
