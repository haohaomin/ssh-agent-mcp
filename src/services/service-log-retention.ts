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

// Unknown/corrupt ownership is protected, including EPERM from kill(pid, 0).
function registryProtects(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 65536) return true;
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as {pid?: unknown};
    if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return true;
    try { process.kill(record.pid as number, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}
function present(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
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
    reclaimableBytes: 0,
    freedBytes: 0,
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
        const registry = path.join(directory, `${key}.json`);
        const lock = path.join(directory, `${key}.lock`);
        const protectedLog = protectedPaths.has(path.resolve(file)) || present(lock) || registryProtects(registry);
        return [{file, stat, registry, lock, protectedLog}];
      } catch { return []; }
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  // Reserve protected bytes first, independent of file age/sort order. They
  // may exceed the budget; retention never truncates an active writer's log.
  let retained = files.filter(item => item.protectedLog).reduce((sum, item) => sum + item.stat.size, 0);
  const now = Date.now();
  for (const item of files) {
    if (item.protectedLog) {
      result.skipped.push(item.file);
      continue;
    }
    if (maxAgeDays > 0 && now - item.stat.mtimeMs <= maxAgeDays * 86400000 && retained + item.stat.size <= maxTotalBytes) {
      retained += item.stat.size;
      continue;
    }
    result.candidates.push(item.file);
    result.reclaimableBytes += item.stat.size;
    if (!dryRun) {
      let lock: number;
      try { lock = fs.openSync(item.lock, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') result.skipped.push(item.file);
        else result.errors.push(item.file);
        retained += item.stat.size;
        continue;
      }
      try {
        fs.writeSync(lock, JSON.stringify({pid: process.pid}));
        // Share the startup lock with ensureService. A service cannot start
        // writing this log between the final ownership check and unlink.
        const current = fs.lstatSync(item.file);
        if (!registryProtects(item.registry) && current.isFile() && current.dev === item.stat.dev &&
            current.ino === item.stat.ino && current.mtimeMs === item.stat.mtimeMs && current.size === item.stat.size) {
          fs.unlinkSync(item.file);
          result.deleted.push(item.file);
          result.freedBytes += item.stat.size;
        } else { result.skipped.push(item.file); retained += current.size; }
      } catch { result.errors.push(item.file); retained += item.stat.size; }
      finally { fs.closeSync(lock); fs.unlinkSync(item.lock); }
    }
  }
  result.retainedBytes = retained;
  return result;
}
