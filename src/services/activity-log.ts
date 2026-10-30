import { redactText } from '../utils/output-redaction.js';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type ActivityStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';
export type ActivityRecord = {
  id: string; operation: string; source: 'mcp' | 'web' | 'monitor'; connectionName?: string;
  startedAt: string; updatedAt: string; finishedAt?: string; status: ActivityStatus;
  input: string; output: string; result?: string; diff?: string; truncated?: boolean;
  sessionName?: string; sessionInstance?: string; jobId?: string; jobState?: string;
};
const LIMIT = 24000;
const MAX_RECORDS = 200;
const sensitive = /password|passphrase|privatekey|authorization|secret|token|api[_-]?key/i;
const context = new AsyncLocalStorage<{ log: ActivityLog; id: string; failed?: boolean }>();

/** Bounded local operation history. Only sanitized snapshots ever reach disk or subscribers. */
export class ActivityLog {
  private records: ActivityRecord[] = [];
  private listeners = new Set<(event: { type: string; record?: ActivityRecord; removed?: string[] }) => void>();
  private timer?: NodeJS.Timeout;
  private dirty = false;
  private lastPersist = 0;
  private closed = false;
  private pending = new Set<string>();
  storageError?: string;

  constructor(readonly file: string, private secrets: () => string[] = () => []) {
    try {
      if (fs.existsSync(file)) {
        if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 24 * 1024 * 1024) throw new Error('Invalid activity history');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(data)) throw new Error('Invalid activity history');
        this.records = data.slice(-MAX_RECORDS).filter(r => r && typeof r.id === 'string' && typeof r.operation === 'string').map(r => {
          const record = this.clean(r) as ActivityRecord;
          // Repair historical schema-less list records made before argument normalization.
          if (record.operation === 'ssh_server_list') {
            if (record.input !== '{}' || record.connectionName) this.dirty = true;
            record.input = '{}'; delete record.connectionName;
          }
          // Requests cannot survive a process restart. Remote jobs/sessions are rechecked by the monitor.
          if (record.status === 'running' && !record.jobId && record.operation !== 'session_output') {
            record.status = 'interrupted';
            record.finishedAt = new Date().toISOString();
            this.dirty = true;
          }
          return record;
        });
      }
    } catch { this.storageError = '无法读取操作历史；本次操作仍会记录'; }
  }

  private text(value: string, streaming = false): string {
    let result = redactText(value, streaming);
    for (const secret of this.secrets().filter(Boolean).sort((a, b) => b.length - a.length)) {
      result = result.split(secret).join('[redacted]');
      // Hold back a trailing fragment when a credential is split across SSH chunks.
      for (let n = streaming ? Math.min(secret.length - 1, result.length) : 0; n > 0; n--) {
        if (result.endsWith(secret.slice(0, n))) { result = result.slice(0, -n) + '[redacted]'; break; }
      }
    }
    return result.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted private key]')
      .replace(/\b(Bearer)\s+[^\s"']+/gi, '$1 [redacted]')
      .replace(/((?:["']?)(?:password|passwd|passphrase|secret|token|api[_-]?key)(?:["']?)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[redacted]');
  }
  private clean(value: unknown, depth = 0): any {
    if (depth > 8) return '[depth limit]';
    if (typeof value === 'string') {
      const text = this.text(value);
      return text.length > LIMIT ? text.slice(0, LIMIT) + '\n[记录已截断]' : text;
    }
    if (Array.isArray(value)) return value.slice(0, 100).map(item => this.clean(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, sensitive.test(key) ? '[redacted]' : this.clean(item, depth + 1)]));
    return value;
  }
  private serialize(value: unknown): string {
    if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) { try { value = JSON.parse(value); } catch {} }
    const cleaned = this.clean(value);
    const text = typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned, null, 2) || '';
    return text.length > LIMIT ? text.slice(0, LIMIT) + '\n[记录已截断]' : text;
  }
  list(): ActivityRecord[] { return this.records.map(r => ({ ...r })); }
  get(id: string): ActivityRecord | undefined { return this.records.find(r => r.id === id); }
  subscribe(listener: (event: { type: string; record?: ActivityRecord; removed?: string[] }) => void) {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private emit(event: { type: string; record?: ActivityRecord; removed?: string[] }) {
    for (const listener of this.listeners) { try { listener(event); } catch {} }
  }
  start(operation: string, source: ActivityRecord['source'], args: any, connectionName?: string) {
    const now = new Date().toISOString();
    const record: ActivityRecord = { id: randomUUID(), operation, source, connectionName, startedAt: now, updatedAt: now, status: 'running', input: this.serialize(args), output: '', sessionName: typeof args?.sessionName === 'string' ? args.sessionName : undefined };
    this.records.push(record);
    const removed: string[] = [];
    while (this.records.length > MAX_RECORDS) {
      const index = this.records.findIndex(r => r.status !== 'running');
      removed.push(this.records.splice(index < 0 ? 0 : index, 1)[0].id);
    }
    this.emit({ type: 'upsert', record: { ...record }, removed }); this.schedule();
    return record.id;
  }
  update(id: string, patch: Partial<ActivityRecord>, immediate = false) {
    const record = this.get(id); if (!record || this.closed) return;
    Object.assign(record, this.clean(patch), { updatedAt: new Date().toISOString() });
    if (immediate) { this.pending.delete(id); this.emit({ type: 'upsert', record: { ...record } }); }
    else this.pending.add(id);
    this.schedule();
  }
  outputReporter(): ((output: string) => void) | undefined {
    const active = context.getStore(); if (active?.log !== this) return;
    const record = this.get(active.id);
    if (!record || !['ssh_exec', 'web_command'].includes(record.operation)) return;
    return output => this.update(active.id, { output: this.text(output, true), truncated: output.length > LIMIT });
  }
  detail(patch: Partial<ActivityRecord>) {
    const active = context.getStore(); if (active?.log === this) this.update(active.id, patch);
  }
  /** Preserve a failure that a tool deliberately returns as a normal MCP text result. */
  markFailed() {
    const active = context.getStore();
    if (active?.log === this) active.failed = true;
  }
  async run<T>(operation: string, source: ActivityRecord['source'], args: any, connectionName: string | undefined, work: () => Promise<T> | T, after?: (id: string, result: T) => void): Promise<T> {
    const id = this.start(operation, source, args, connectionName);
    return context.run({ log: this, id }, async () => {
      try {
        const result = await work();
        const value: any = result;
        const output = Array.isArray(value?.content) ? value.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n') : value;
        const serialized = this.serialize(output);
        const failed = value?.isError || value?.ok === false || context.getStore()?.failed;
        this.update(id, { status: failed ? 'failed' : 'succeeded', result: serialized, finishedAt: new Date().toISOString() }, true);
        if (!failed) { try { after?.(id, result); } catch {} }
        return result;
      } catch (error) {
        this.update(id, { status: 'failed', result: this.serialize(error instanceof Error ? error.message : error), finishedAt: new Date().toISOString() }, true);
        throw error;
      }
    });
  }
  private schedule() {
    this.dirty = true;
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(false); }, 200);
    this.timer.unref();
  }
  flush(force = true) {
    for (const id of this.pending) { const record = this.get(id); if (record) this.emit({ type: 'upsert', record: { ...record } }); }
    this.pending.clear();
    if (!this.dirty) return;
    if (!force && Date.now() - this.lastPersist < 1000) { this.schedule(); return; }
    this.lastPersist = Date.now();
    this.dirty = false;
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, JSON.stringify(this.records), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, this.file);
      const recovered = Boolean(this.storageError);
      this.storageError = undefined;
      if (recovered) this.emit({ type: 'storage-recovered' });
    } catch {
      this.dirty = true;
      this.storageError = '历史记录写入失败；当前页面仍可实时查看';
      this.emit({ type: 'storage-error' });
      // Retain unsaved records and retry under the same one-second write limit.
      // A final close flush must not schedule work after shutdown.
      if (!this.closed) this.schedule();
    }
    finally { try { fs.rmSync(temp, { force: true }); } catch {} }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.flush();
    this.emit({ type: 'closed' }); this.listeners.clear();
  }
}
