import { redactByteSlice, redactText } from '../utils/output-redaction.js';
import { assertUnrestricted } from '../utils/execution-policy.js';
import { rsyncTransfer, type SyncOptions } from './rsync.js';
import picomatch from 'picomatch';
import { SearchMatcher, type SearchOptions } from '../utils/search-matcher.js';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import type { SFTPWrapper, Stats } from 'ssh2';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { SSHConnectionManager } from './ssh-connection-manager.js';

const MAX_TEXT = 4 * 1024 * 1024;
function stat(sftp: SFTPWrapper, p: string): Promise<Stats> { return new Promise((resolve, reject) => sftp.lstat(p, (e, s) => e ? reject(e) : resolve(s))); }
function realpath(sftp: SFTPWrapper, p: string): Promise<string> { return new Promise((resolve, reject) => sftp.realpath(p, (e, s) => e ? reject(e) : resolve(s))); }
async function text(sftp: SFTPWrapper, p: string, maxBytes = MAX_TEXT): Promise<string> {
  const info = await stat(sftp, p);
  if (!info.isFile() || info.size > maxBytes) throw new Error('Expected a regular text file within the configured size limit');
  const chunks: Buffer[] = []; let length = 0;
  // Wait for stream cleanup as well as EOF before the caller closes SFTP.
  await pipeline(sftp.createReadStream(p), async source => {
    for await (const chunk of source) {
      const buffer = Buffer.from(chunk); length += buffer.length;
      if (length > maxBytes) throw new Error('Text file exceeds configured size limit');
      chunks.push(buffer);
    }
  });
  const buffer = Buffer.concat(chunks);
  if (buffer.includes(0)) throw new Error('Binary file; use download');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
}
function write(sftp: SFTPWrapper, p: string, content: string, flags: 'wx' | 'w', mode?: number): Promise<void> {
  if (Buffer.byteLength(content) > MAX_TEXT) throw new Error('Text exceeds 4 MiB');
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(p, { flags, mode });
    stream.on('error', reject); stream.on('close', resolve); stream.end(content);
  });
}
/** Non-atomic, opt-in edit of an existing inode. Caller holds a cooperative lock and saves a backup. */
async function rewriteInPlace(sftp: SFTPWrapper, file: string, original: string, changed: string): Promise<void> {
  const handle = await new Promise<Buffer>((resolve, reject) => sftp.open(file, 'r+', (e, h) => e ? reject(e) : resolve(h)));
  try {
    const info = await new Promise<Stats>((resolve, reject) => sftp.fstat(handle, (e, st) => e ? reject(e) : resolve(st)));
    const before = Buffer.from(original), after = Buffer.from(changed);
    if (!info.isFile() || info.size !== before.length) throw new Error('File changed before inPlace write');
    const actual = Buffer.alloc(before.length);
    for (let offset = 0; offset < actual.length;) {
      const count = await new Promise<number>((resolve, reject) => sftp.read(handle, actual, offset, Math.min(32768, actual.length-offset), offset, (e, n) => e ? reject(e) : resolve(n)));
      if (!count) throw new Error('File changed before inPlace write');
      offset += count;
    }
    if (!actual.equals(before)) throw new Error('File changed before inPlace write');
    for (let offset = 0; offset < after.length; offset += 32768) {
      await new Promise<void>((resolve, reject) => sftp.write(handle, after, offset, Math.min(32768, after.length-offset), offset, e => e ? reject(e) : resolve()));
    }
    await new Promise<void>((resolve, reject) => sftp.fsetstat(handle, {size: after.length}, e => e ? reject(e) : resolve()));
  } finally {
    await new Promise<void>((resolve, reject) => sftp.close(handle, e => e ? reject(e) : resolve()));
  }
  if (await text(sftp, file) !== changed) throw new Error('File changed during inPlace write or verification failed');
}
export function applyEdits(original: string, edits: { oldText: string; newText: string }[]): string {
  let content = original;
  for (const edit of edits) {
    if (!edit.oldText) throw new Error('oldText cannot be empty');
    const at = content.indexOf(edit.oldText);
    if (at < 0) throw new Error('Edit text not found; read the file again');
    if (content.indexOf(edit.oldText, at + 1) >= 0) throw new Error('Edit is ambiguous; include more context');
    content = content.slice(0, at) + edit.newText + content.slice(at + edit.oldText.length);
  }
  return content;
}
export type EditOptions = { dryRun?: boolean; backup?: boolean; expectedSha256?: string; writeMode?: 'atomic' | 'inPlace' };
function editPreview(original: string, changed: string) {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  // Bound tokenization and diff work separately from the file size budget.
  const lines = (original.match(/\n/g)?.length || 0) + (changed.match(/\n/g)?.length || 0);
  const patch = lines > 50000 ? undefined : createTwoFilesPatch('before', 'after', redactText(original), redactText(changed), undefined, undefined, {context:3,timeout:100,maxEditLength:2000});
  return { beforeSha256:hash(original), afterSha256:hash(changed), diff:patch?.slice(0,65536) ?? '', diffTruncated:patch === undefined || patch.length > 65536 };
}
export class RemoteFiles {
  private static readonly editLocks = new WeakMap<SSHConnectionManager, Map<string, Promise<unknown>>>();
  private readonly locks: Map<string, Promise<unknown>>;
  constructor(private manager: SSHConnectionManager) {
    let locks = RemoteFiles.editLocks.get(manager);
    if (!locks) { locks = new Map(); RemoteFiles.editLocks.set(manager, locks); }
    this.locks = locks;
  }
  /** Resolve the Workbench landing directory without accepting arbitrary relative paths. */
  async initialDirectory(name?: string): Promise<string> {
    const allowed = this.manager.getConfig(name).allowedRemotePaths?.[0];
    if (allowed) return this.manager.validateRemotePath(allowed, name);
    return this.manager.withSftp(name, async sftp => this.manager.validateRemotePath(await realpath(sftp, '.'), name));
  }
  private async checked(sftp: SFTPWrapper, p: string, name?: string, creating = false): Promise<string> {
    const requested = this.manager.validateRemotePath(p, name);
    const resolved = await realpath(sftp, creating ? path.posix.dirname(requested) : requested);
    this.manager.validateRemotePath(resolved, name);
    return creating ? path.posix.join(resolved, path.posix.basename(requested)) : resolved;
  }
  async list(p: string, includeHidden = false, maxResults = 200, name?: string) {
    return this.manager.withSftp(name, async sftp => {
      const resolved = await this.checked(sftp, p, name);
      const all = await new Promise<Array<{filename: string; attrs: Stats}>>((resolve, reject) => sftp.readdir(resolved, (e, entries) => e ? reject(e) : resolve(entries)));
      const entries = all.filter(e => e.filename !== '.' && e.filename !== '..' && (includeHidden || !e.filename.startsWith('.'))).sort((a,b) => a.filename.localeCompare(b.filename));
      return { remotePath: p, resolvedPath: resolved, entries: entries.slice(0, maxResults).map(e => ({ name: e.filename, type: e.attrs.isSymbolicLink() ? 'symlink' : e.attrs.isDirectory() ? 'directory' : 'file', sizeBytes: e.attrs.size, modifiedAtSeconds: e.attrs.mtime })), truncated: entries.length > maxResults };
    });
  }

  async view(p: string, start = 1, count = 200, name?: string) {
    return this.manager.withSftp(name, async sftp => {
      const content = await text(sftp, await this.checked(sftp, p, name));
      const buffer = Buffer.from(content);
      const lines = redactByteSlice(buffer, 0, buffer.length).split('\n');
      const selected = lines.slice(start - 1, start - 1 + count);
      return { path: p, totalLines: lines.length, startLine: start, content: selected.map((line, i) => `${start + i}\t${line}`).join('\n'), nextLine: start - 1 + selected.length < lines.length ? start + selected.length : null };
    });
  }
  /** Read complete, validated UTF-8 content for editors; never expose a truncated slice as a file. */
  async readText(p: string, name?: string) {
    return this.manager.withSftp(name, async sftp => {
      const content = await text(sftp, await this.checked(sftp, p, name));
      const visible = redactText(content);
      return { path: p, content:visible, ...(visible === content ? {} : {redacted:true}), sha256: createHash('sha256').update(content).digest('hex') };
    });
  }
  async replace(p: string, content: string, expectedSha256: string, name?: string, options: EditOptions = {}) {
    return this.edit(p, [], name, { ...options, expectedSha256 }, content);
  }
  async create(p: string, content: string, name?: string, permissions = 0o644) {
    return this.manager.withSftp(name, async sftp => {
      const resolved = await this.checked(sftp, p, name, true);
      await write(sftp, resolved, content, 'wx', permissions);
      return { created: p, bytes: Buffer.byteLength(content) };
    });
  }
  async edit(p: string, edits: { oldText: string; newText: string }[], name?: string, options: EditOptions = {}, replacement?: string) {
    return this.manager.withSftp(name, async sftp => {
      const resolved = await this.checked(sftp, p, name);
      const key = JSON.stringify([name || this.manager.getDefaultConnectionName(), resolved]);
      const before = this.locks.get(key) || Promise.resolve();
      const work = before.catch(() => {}).then(async () => {
        const original = await text(sftp, resolved);
        if (options.expectedSha256 && createHash('sha256').update(original).digest('hex') !== options.expectedSha256.toLowerCase()) throw new Error('File hash differs from preview; read and preview the file again');
        if (replacement !== undefined && redactText(original) !== original) throw new Error('File contains configured secrets; whole-file replacement is disabled to prevent saving redacted text. Use exact edits outside secret values or upload the original file.');
        const changed = replacement ?? applyEdits(original, edits);
        if(Buffer.byteLength(changed)>MAX_TEXT)throw new Error('Text exceeds 4 MiB');
        const writeMode = options.writeMode ?? 'atomic';
        if (!['atomic', 'inPlace'].includes(writeMode)) throw new Error('Invalid writeMode');
        const preview = {writeMode, atomic:writeMode === 'atomic', inodePreserved:writeMode === 'inPlace', remotePath:p,dryRun:options.dryRun ?? false,changed:changed!==original,replacements:edits.length,bytes:Buffer.byteLength(changed),...editPreview(original,changed)};
        this.manager.activity?.log.detail({ diff: preview.diff, truncated: preview.diffTruncated });
        if(options.dryRun || changed===original)return preview;
        if (writeMode === 'inPlace' && !options.expectedSha256) throw new Error('inPlace requires expectedSha256 from a fresh preview');
        const info = await stat(sftp, resolved);
        const temp = `${resolved}.ssh-agent-${randomUUID()}`;
        let backupPath: string | undefined;
        try {
          if (writeMode === 'atomic') await write(sftp, temp, changed, 'wx', info.mode & 0o777);
          if (await text(sftp, resolved) !== original) throw new Error('File changed during edit; retry after reading it');
          if(options.backup || writeMode === 'inPlace'){
            backupPath = await this.checked(sftp, `${resolved}.ssh-agent-backup-${randomUUID()}`, name, true);
            // Backup creation is exclusive and private; failure leaves the original untouched.
            await write(sftp, backupPath, original, 'wx', 0o600);
            if (await text(sftp, resolved) !== original) throw new Error('File changed while backing up; preview again');
          }
          if (writeMode === 'inPlace') {
            await rewriteInPlace(sftp, resolved, original, changed);
          } else {
            // Require atomic replacement; do not delete the original as a fallback.
            await new Promise<void>((resolve, reject) => sftp.ext_openssh_rename(temp, resolved, e => e ? reject(e) : resolve()));
          }
          return { ...preview, edited:p, backupPath };
        } catch(error) {
          if(backupPath)throw new Error(`${(error as Error).message}; ${writeMode === 'inPlace' ? 'inPlace write may be partial; ' : ''}backup may be present at ${backupPath}`);
          throw error;
        } finally {
          if (writeMode === 'atomic') await new Promise<void>(resolve => sftp.unlink(temp, () => resolve()));
        }
      });
      this.locks.set(key, work);
      try { return await work; } finally { if (this.locks.get(key) === work) this.locks.delete(key); }
    });
  }
  async search(root: string, query: string, kind: 'grep' | 'glob', maxResults = 100, name?: string, exclude: string[] = ['.git', '.hg', '.svn'], options: SearchOptions = {}) {
    const engine = new SearchMatcher();
    try { return await this.manager.withSftp(name, async sftp => {
      if (options.regex) await engine.match('', query, options, 1);
      const base = await this.checked(sftp, root, name);
      const results: unknown[] = []; let visited = 0, scannedBytes = 0, truncated = false;
      const skipped: string[] = [];
      const matcher = kind === 'glob' ? picomatch.makeRe(query,{dot:!!options.includeHidden,nocase:!!options.ignoreCase}) : undefined;
      const fileFilter = options.filePattern ? picomatch(options.filePattern, {dot: !!options.includeHidden, basename: true}) : undefined;
      const excluded = exclude.map(globRegex);
      const isExcluded = (relative: string) => excluded.some(pattern => pattern.test(relative) || pattern.test(path.posix.basename(relative)));
      const inspect = async (full: string, relative: string) => {
        let content: string;
        try { content = await text(sftp, full, options.maxFileBytes); scannedBytes += Buffer.byteLength(content); }
        catch { skipped.push(relative); return; }
        const buffer = Buffer.from(content);
        const found = await engine.match(redactByteSlice(buffer, 0, buffer.length), query, options, Math.max(1,maxResults-results.length));
        if (!found.count) return;
        if (options.outputMode === 'files') results.push({path:full});
        else if (options.outputMode === 'count') results.push({path:full,count:found.count});
        else {
          for (const line of found.lines) { if (results.length >= maxResults) {truncated=true;break;} results.push({path:full,...line}); }
          truncated ||= found.truncated;
        }
      };
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 32) { truncated = true; return; }
        const entries = await new Promise<any[]>((resolve, reject) => sftp.readdir(dir, (e, list) => e ? reject(e) : resolve(list)));
        for (const entry of entries) {
          if (++visited > 10000 || results.length >= maxResults || scannedBytes > 32 * 1024 * 1024) { truncated = true; return; }
          if (entry.filename === '.' || entry.filename === '..' || /[\/\\\0]/.test(entry.filename)) continue;
          const full = path.posix.join(dir, entry.filename); const relative = path.posix.relative(base, full);
          if (isExcluded(relative) || (kind === 'grep' && !options.includeHidden && entry.filename.startsWith('.'))) continue;
          if (entry.attrs.isSymbolicLink()) { skipped.push(relative); continue; }
          if (matcher?.test(relative)) results.push({ path: full, directory: entry.attrs.isDirectory() });
          if (entry.attrs.isDirectory()) await walk(full, depth + 1);
          else if (kind === 'grep' && entry.attrs.isFile()) {
            if (fileFilter && !fileFilter(relative)) continue;
            await inspect(full, relative);

          }
        }
      };
      const info = await stat(sftp,base);
      if (info.isFile() && kind === 'grep') await inspect(base,path.posix.basename(base));
      else await walk(base, 0);
      return { results, truncated, skipped: skipped.slice(0, 100), visited };
    }); } finally { engine.close(); }
  }
  async sync(localRoot: string, remoteRoot: string, direction: 'upload' | 'download', dryRun = true, name?: string, exclude: string[] = [], options: SyncOptions & { engine?: 'sftp'|'rsync' } = {}) {
    assertUnrestricted(this.manager.getConfig(name), 'File sync');
    if (options.engine === 'rsync' || options.deleteExtra) return rsyncTransfer(this.manager,localRoot,remoteRoot,direction,dryRun,name,exclude,options);
    const local = this.manager.validateLocalPath(localRoot, name, direction === 'upload' ? 'read' : 'write');
    return this.manager.withSftp(name, async sftp => {
      // Both roots must already exist, preventing accidental creation at the wrong location.
      const remote = await this.checked(sftp, remoteRoot, name);
      if (!(await fs.stat(local)).isDirectory() || !(await stat(sftp, remote)).isDirectory()) throw new Error('Both sync roots must be directories');
      const actions: { relative: string; kind: 'directory' | 'file'; bytes?: number }[] = [];
      let visited = 0;
      const excluded = exclude.map(globRegex);
      const walk = async (relative: string, depth: number): Promise<void> => {
        if (relative && excluded.some(pattern => pattern.test(relative.split(path.sep).join('/')) || pattern.test(path.basename(relative)))) return;
        if (depth > 32 || ++visited > 10000) throw new Error('Sync traversal limit exceeded');
        const lp = path.join(local, relative); const rp = path.posix.join(remote, relative.split(path.sep).join('/'));
        this.manager.validateLocalPath(lp, name, direction === 'upload' ? 'read' : 'write');
        if (direction === 'upload') {
          const source = await fs.lstat(lp);
          if (source.isSymbolicLink()) throw new Error(`Sync does not follow symlinks: ${relative}`);
          let dest: Stats | undefined;
          try { dest = await stat(sftp, rp); } catch (e) { if ((e as {code?: number}).code !== 2) throw e; }
          if (dest?.isSymbolicLink()) throw new Error(`Destination symlink: ${relative}`);
          if (source.isDirectory()) {
            if (dest && !dest.isDirectory()) throw new Error(`Type conflict: ${relative}`);
            if (!dest) actions.push({ relative, kind: 'directory' });
            for (const entry of (await fs.readdir(lp)).sort()) await walk(path.join(relative, entry), depth + 1);
          } else if (source.isFile()) {
            if (dest && !dest.isFile()) throw new Error(`Type conflict: ${relative}`);
            if (!dest || dest.size !== source.size || Math.floor(source.mtimeMs / 1000) !== dest.mtime) actions.push({ relative, kind: 'file', bytes: source.size });
          } else throw new Error(`Unsupported file type: ${relative}`);
        } else {
          const source = await stat(sftp, rp);
          if (source.isSymbolicLink()) throw new Error(`Sync does not follow symlinks: ${relative}`);
          let dest;
          try { dest = await fs.lstat(lp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
          if (dest?.isSymbolicLink()) throw new Error(`Destination symlink: ${relative}`);
          if (source.isDirectory()) {
            if (dest && !dest.isDirectory()) throw new Error(`Type conflict: ${relative}`);
            if (!dest) actions.push({ relative, kind: 'directory' });
            const entries = await new Promise<any[]>((resolve, reject) => sftp.readdir(rp, (e, list) => e ? reject(e) : resolve(list)));
            for (const entry of entries) {
              if (entry.filename === '.' || entry.filename === '..' || /[\/\\\0]/.test(entry.filename)) continue;
              await walk(path.join(relative, entry.filename), depth + 1);
            }
          } else if (source.isFile()) {
            if (dest && !dest.isFile()) throw new Error(`Type conflict: ${relative}`);
            if (!dest || dest.size !== source.size || Math.floor(dest.mtimeMs / 1000) !== source.mtime) actions.push({ relative, kind: 'file', bytes: source.size });
          } else throw new Error(`Unsupported file type: ${relative}`);
        }
      };
      await walk('', 0);
      if (!dryRun) for (const action of actions) {
        const lp = path.join(local, action.relative), rp = path.posix.join(remote, action.relative.split(path.sep).join('/'));
        if (action.kind === 'directory') {
          if (direction === 'upload') await new Promise<void>((resolve, reject) => sftp.mkdir(rp, e => e ? reject(e) : resolve()));
          else await fs.mkdir(lp, { recursive: true });
        } else if (direction === 'upload') {
          this.manager.validateLocalPath(lp, name, 'read');
          await this.checked(sftp, rp, name, true);
          await pipeline(createReadStream(lp), sftp.createWriteStream(rp));
          const info = await fs.stat(lp);
          await new Promise<void>((resolve, reject) => sftp.utimes(rp, Math.floor(info.atimeMs/1000), Math.floor(info.mtimeMs/1000), e => e ? reject(e) : resolve()));
        } else {
          this.manager.validateLocalPath(lp, name, 'write');
          await this.checked(sftp, rp, name);
          await pipeline(sftp.createReadStream(rp), createWriteStream(lp));
          const info = await stat(sftp, rp); await fs.utimes(lp, info.atime, info.mtime);
        }
      }
      return { direction, dryRun, actions, deletesFiles: false, comparison: 'size and modification time' };
    });
  }
}
export function globRegex(glob: string): RegExp {
  return picomatch.makeRe(glob, {dot: true, nonegate: true});
}
