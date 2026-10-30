import fs from 'node:fs';
import path from 'node:path';
import type { SSHConfig } from '../models/types.js';

let values: string[] = [];
const prefixes = new Map<string, number[]>();

/** Load secrets locally; tool callers reference configuration, never transmit the values. */
export function loadRedactionValues(configs: Record<string, SSHConfig>): string[] {
  const found: string[] = [];
  for (const config of Object.values(configs)) {
    for (const [field, list] of [['redactLocalFiles', config.redactLocalFiles], ['redactEnv', config.redactEnv]] as const) {
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.length > 64 || list.some(v => typeof v !== 'string' || !v)) throw new Error(`Invalid ${field}`);
      for (const ref of list) {
        let value: string;
        if (field === 'redactLocalFiles') {
          if (!path.isAbsolute(ref)) throw new Error('Redaction file must be an absolute local path');
          try {
            const fd = fs.openSync(ref, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
            try {
              const info = fs.fstatSync(fd);
              if (!info.isFile() || info.size > 65536) throw new Error();
              const bytes = Buffer.alloc(65537);
              let length = 0;
              while (length < bytes.length) {
                const n = fs.readSync(fd, bytes, length, bytes.length - length, length);
                if (!n) break;
                length += n;
              }
              if (length > 65536) throw new Error();
              value = new TextDecoder('utf-8', {fatal:true}).decode(bytes.subarray(0, length)).replace(/[\r\n]+$/, '');
            } finally { fs.closeSync(fd); }
          } catch { throw new Error('Cannot read configured redaction file (must be a regular file <= 64 KiB)'); }
        } else {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error('Invalid redaction environment name');
          value = process.env[ref] || '';
        }
        if (!value || value.length > 65536) throw new Error('Configured redaction value is empty or too large');
        found.push(value, JSON.stringify(value).slice(1, -1));
      }
    }
  }
  if (found.reduce((n, s) => n + s.length, 0) > 1024 * 1024) throw new Error('Redaction values exceed total budget');
  return [...new Set(found)].sort((a, b) => b.length - a.length);
}
export function installRedactionValues(next: string[], retain = false) {
  values = [...new Set(retain ? [...values, ...next] : next)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!retain) prefixes.clear();
}
/** KMP prefix table keeps long/repeated secrets from making suffix matching quadratic. */
function suffixPrefixLength(text: string, secret: string): number {
  let table = prefixes.get(secret);
  if (!table) {
    table = [0];
    for (let i = 1, j = 0; i < secret.length; i++) {
      while (j && secret[i] !== secret[j]) j = table[j - 1];
      if (secret[i] === secret[j]) j++;
      table.push(j);
    }
    prefixes.set(secret, table);
  }
  let matched = 0;
  for (let i = Math.max(0, text.length - secret.length + 1); i < text.length; i++) {
    while (matched && text[i] !== secret[matched]) matched = table[matched - 1];
    if (text[i] === secret[matched]) matched++;
  }
  return matched;
}
export function redactText(text: string, streaming = false): string {
  // A stream also handles overlapping values without leaking the longer value's suffix.
  const stream = new RedactionStream();
  return stream.write(text, !streaming) + (streaming ? stream.finishMasked() : '');
}
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map(redactValue) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v)])) as T;
  return value;
}
/** Withhold incomplete secret prefixes across chunks, including prefixes of a longer matching value. */
export class RedactionStream {
  private pending = '';
  private readonly secrets = [...values];
  write(chunk: string, final = false): string {
    this.pending += chunk;
    if (!this.secrets.length) { const out = this.pending; this.pending = ''; return out; }
    let out = '';
    while (this.pending) {
      let at = this.pending.length, match = '';
      let partial = this.pending.length;
      for (const secret of this.secrets) {
        const index = this.pending.indexOf(secret);
        if (index >= 0 && (index < at || (index === at && secret.length > match.length))) { at = index; match = secret; }
        partial = Math.min(partial, this.pending.length - suffixPrefixLength(this.pending, secret));
      }
      if (!final && partial <= at && partial < this.pending.length) {
        out += this.pending.slice(0, partial); this.pending = this.pending.slice(partial); break;
      }
      if (match) {
        out += this.pending.slice(0, at) + '[REDACTED]'; this.pending = this.pending.slice(at + match.length);
      } else {
        out += this.pending; this.pending = '';
      }
    }
    return out;
  }
  /** Used on cumulative live previews, which must not reveal an unfinished secret prefix. */
  finishMasked(): string { const out = this.pending ? '[REDACTED]' : ''; this.pending = ''; return out; }
}

/** Extra raw context needed to recognize a secret crossing a byte-page boundary. */
export function redactionContextBytes(): number {
  return values.reduce((max, value) => Math.max(max, Buffer.byteLength(value)), 0);
}
/** Match in raw surrounding bytes, then redact the requested slice without changing raw offsets. */
export function redactByteSlice(buffer: Buffer, start: number, end: number): string {
  const mask = new Uint8Array(Math.max(0, end - start));
  for (const value of values) {
    const needle = Buffer.from(value);
    for (let at = buffer.indexOf(needle); at >= 0 && at < end; at = buffer.indexOf(needle, at + 1)) {
      if (at + needle.length > start) mask.fill(1, Math.max(0, at - start), Math.min(end, at + needle.length) - start);
    }
  }
  const output: Buffer[] = [];
  for (let at = 0; at < mask.length;) {
    let stop = at + 1;
    while (stop < mask.length && mask[stop] === mask[at]) stop++;
    if (mask[at]) {
      // Preserve line positions for numbered file views and grep results.
      const newlines = buffer.subarray(start + at, start + stop).toString('utf8').match(/\n/g)?.length || 0;
      output.push(Buffer.from('[REDACTED]' + '\n'.repeat(newlines)));
    } else output.push(buffer.subarray(start + at, start + stop));
    at = stop;
  }
  return Buffer.concat(output).toString('utf8');
}

/** Private worker IPC snapshot; never serialize this into tool metadata or state files. */
export function redactionSnapshot(): string[] { return [...values]; }
