import fs from 'node:fs';
import path from 'node:path';
import { stateDirectory } from './durable-sessions.js';

const SERVICE_KEY = /^[0-9a-f]{32}$/;
export const SERVICE_LOG_RETENTION_DAYS = 30;
export const SERVICE_LOG_MAX_BYTES = 64 * 1024 * 1024;

type Options = {
  maxAgeDays?: number;
  maxTotalBytes?: number;
  dryRun?: boolean;
  protectPaths?: string[];
};

function livePid(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
  try { process.kill(pid as number, 0); return true; } catch { return false; }
}

/**
 * Retain shared-service startup logs without touching an active service. The
 * registry JSON is deliberately left alone; service lifecycle code owns it.
 */
export function cleanupServiceLogs(options: Options = {}) {
  const directory = path.join(stateDirectory(), 'services');
  const dryRun = options.dryRun ?? true;
  const maxAgeDays = options.maxAgeDays ?? SERVICE_LOG_RETENTION_DAYS;
  const maxTotalBytes = options.maxTotalBytes ?? SERVICE_LOG_MAX_BYTES;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0 ||
      !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0) {
    throw new Error('Invalid service log retention limits');
  }
  const result = {
    dryRun,
    candidates: [] as string[],
    deleted: [] as string[],
    skipped: [] as string[],
    errors: [] as string[],
    retainedBytes: 0,
  };
  if (!fs.existsSync(directory)) return result;
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('services must be a real directory');
  const protectedPaths = new Set((options.protectPaths ?? []).map(file => path.resolve(file)));
  const files = fs.readdirSync(directory)
    .filter(name => SERVICE_KEY.test(name.slice(0, -4)) && name.endsWith('.log'))
    .flatMap(name => {
      const file = path.join(directory, name);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile()) return [];
        const key = name.slice(0, -4);
        let active = false;
        const registry = path.join(directory, `${key}.json`);
        try {
          const record = JSON.parse(fs.readFileSync(registry, 'utf8')) as {pid?: unknown};
          active = livePid(record.pid);
        } catch {}
        return [{file, stat, active}];
      } catch { return []; }
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  let retained = 0;
  for (const item of files) {
    if (item.active || protectedPaths.has(path.resolve(item.file))) {
      result.skipped.push(item.file);
      retained += item.stat.size;
      continue;
    }
    if (Date.now() - item.stat.mtimeMs <= maxAgeDays * 86400000 && retained + item.stat.size <= maxTotalBytes) {
      retained += item.stat.size;
      continue;
    }
    result.candidates.push(item.file);
    if (!dryRun) {
      try {
        const current = fs.lstatSync(item.file);
        if (current.isFile() && current.ino === item.stat.ino && current.mtimeMs === item.stat.mtimeMs) {
          fs.unlinkSync(item.file);
          result.deleted.push(item.file);
        } else result.skipped.push(item.file);
      } catch { result.errors.push(item.file); }
    }
  }
  result.retainedBytes = retained;
  return result;
}
