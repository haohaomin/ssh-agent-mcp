import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyPatch } from 'diff';
import { PassThrough } from 'node:stream';
import { RemoteFiles, applyEdits, globRegex } from '../build/services/remote-files.js';

test('edits reject missing/ambiguous context and handle literal replacement text', () => {
  assert.equal(applyEdits('hello world', [{oldText:'world',newText:'$&你好'}]), 'hello $&你好');
  assert.throws(() => applyEdits('aa aa', [{oldText:'aa',newText:'x'}]), /ambiguous/);
  assert.throws(() => applyEdits('aa', [{oldText:'bb',newText:'x'}]), /not found/);
  assert.ok(globRegex('**/*.ts').test('a.ts')); assert.ok(globRegex('**/*.ts').test('src/a.ts')); assert.ok(!globRegex('*.ts').test('src/a.ts'));
});
function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ssh-agent-files-'))); t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const sftp = {
    lstat: fs.lstat, realpath: fs.realpath, createReadStream: fs.createReadStream, createWriteStream: fs.createWriteStream,
    ext_openssh_rename: fs.rename, unlink: fs.unlink,
    readdir(p, cb) { fs.readdir(p,{withFileTypes:true},(e,list) => cb(e,list?.map(entry => ({ filename:entry.name, attrs:fs.lstatSync(path.join(p,entry.name)) })))); }
  };
  const manager = { withSftp: async (_name, f) => f(sftp), validateRemotePath(p) { if (!(p === root || p.startsWith(root + path.sep))) throw new Error('outside root'); return p; } };
  return { root, files:new RemoteFiles(manager), sftp };
}
test('create exclusive, view lines, atomic edits and file permissions', async t => {
  const {root,files}=setup(t), p=path.join(root,'text'); await files.create(p,'one\ntwo\n');
  await assert.rejects(files.create(p,'overwrite')); assert.equal(fs.readFileSync(p,'utf8'),'one\ntwo\n');
  assert.equal((await files.view(p,2,1)).content,'2\ttwo'); fs.chmodSync(p,0o640);
  await files.edit(p,[{oldText:'two',newText:'three'}]); assert.equal(fs.readFileSync(p,'utf8'),'one\nthree\n'); assert.equal(fs.statSync(p).mode & 0o777,0o640);
  assert.deepEqual(fs.readdirSync(root),['text']);
});
test('failed atomic rename leaves original and removes temporary file', async t => {
  const {root,files,sftp}=setup(t), p=path.join(root,'text'); fs.writeFileSync(p,'old');
  sftp.ext_openssh_rename=(_a,_b,cb)=>cb(new Error('unsupported'));
  await assert.rejects(files.edit(p,[{oldText:'old',newText:'new'}]), /unsupported/);
  assert.equal(fs.readFileSync(p,'utf8'),'old'); assert.deepEqual(fs.readdirSync(root),['text']);
});
test('edit preview is read-only, yields an applicable diff and rejects a stale preview', async t => {
  const {root,files}=setup(t),p=path.join(root,'text');const original='first\nsecond\nthird\n';fs.writeFileSync(p,original);
  const edits=[{oldText:'second',newText:'第二行'}];
  const preview=await files.edit(p,edits,undefined,{dryRun:true,backup:true});
  assert.equal(preview.dryRun,true);assert.equal(preview.diffTruncated,false);assert.equal(applyPatch(original,preview.diff),'first\n第二行\nthird\n');
  assert.equal(fs.readFileSync(p,'utf8'),original);assert.deepEqual(fs.readdirSync(root),['text']);
  assert.equal(preview.beforeSha256,createHash('sha256').update(original).digest('hex'));
  fs.appendFileSync(p,'other process\n');await assert.rejects(files.edit(p,edits,undefined,{expectedSha256:preview.beforeSha256,backup:true}),/hash differs/);
  assert.deepEqual(fs.readdirSync(root),['text']);assert.match(fs.readFileSync(p,'utf8'),/other process/);
});
test('backup preserves exact UTF-8 BOM and CRLF bytes with private permissions', async t => {
  const {root,files}=setup(t),p=path.join(root,'text'),original='\uFEFFfirst\r\nsecond\r\n';fs.writeFileSync(p,original);fs.chmodSync(p,0o640);
  const edits=[{oldText:'second',newText:'second changed'}];
  const preview=await files.edit(p,edits,undefined,{dryRun:true});
  const result=await files.edit(p,edits,undefined,{backup:true,expectedSha256:preview.beforeSha256});
  assert.equal(fs.readFileSync(result.backupPath,'utf8'),original);assert.equal(fs.statSync(result.backupPath).mode&0o777,0o600);
  assert.equal(fs.readFileSync(p,'utf8'),'\uFEFFfirst\r\nsecond changed\r\n');assert.equal(fs.statSync(p).mode&0o777,0o640);
  assert.equal(result.afterSha256,createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
});
test('backup and original survive a failed rename, and no-op edits create no artifacts', async t => {
  const {root,files,sftp}=setup(t),p=path.join(root,'text');fs.writeFileSync(p,'old');
  const noop=await files.edit(p,[{oldText:'old',newText:'old'}],undefined,{backup:true});assert.equal(noop.changed,false);assert.deepEqual(fs.readdirSync(root),['text']);
  sftp.ext_openssh_rename=(_a,_b,cb)=>cb(new Error('rename unavailable'));
  await assert.rejects(files.edit(p,[{oldText:'old',newText:'new'}],undefined,{backup:true}),/backup may be present/);
  const names=fs.readdirSync(root);assert.equal(names.length,2);const backup=names.find(n=>n.includes('.ssh-agent-backup-'));
  assert.equal(fs.readFileSync(path.join(root,backup),'utf8'),'old');assert.equal(fs.readFileSync(p,'utf8'),'old');
});
test('edit preview bounds diff output and rejects oversized results before writing', async t => {
  const {root,files}=setup(t),p=path.join(root,'text');fs.writeFileSync(p,'a'.repeat(70000));
  const preview=await files.edit(p,[{oldText:'a'.repeat(70000),newText:'b'.repeat(70000)}],undefined,{dryRun:true});assert.equal(preview.diffTruncated,true);assert.ok(preview.diff.length<=65536);
  await assert.rejects(files.edit(p,[{oldText:'a'.repeat(70000),newText:'b'.repeat(4*1024*1024+1)}],undefined,{dryRun:true}),/4 MiB/);
  assert.deepEqual(fs.readdirSync(root),['text']);
});
test('backup write failure aborts replacement and cleans the edit temporary file', async t => {
  const {root,files,sftp}=setup(t),p=path.join(root,'text');fs.writeFileSync(p,'old');
  sftp.createWriteStream=(file,options)=>{if(!file.includes('.ssh-agent-backup-'))return fs.createWriteStream(file,options);const stream=new PassThrough();queueMicrotask(()=>stream.destroy(new Error('backup quota exceeded')));return stream;};
  await assert.rejects(files.edit(p,[{oldText:'old',newText:'new'}],undefined,{backup:true}),/backup quota exceeded/);
  assert.equal(fs.readFileSync(p,'utf8'),'old');assert.deepEqual(fs.readdirSync(root),['text']);
});
test('search supports nested globs, bounded literal results and skips symlinks', async t => {
  const {root,files}=setup(t); fs.mkdirSync(path.join(root,'src')); fs.writeFileSync(path.join(root,'src','a.ts'),'hello\nhello again\n'); fs.symlinkSync('/etc',path.join(root,'link'));
  const glob=await files.search(root,'**/*.ts','glob'); assert.equal(glob.results.length,1);
  const grep=await files.search(root,'hello','grep',1); assert.equal(grep.results.length,1); assert.ok(grep.truncated);
  await assert.rejects(files.view(path.join(root,'link','hosts')), /outside root/);
});
test('SFTP sync previews, uploads changes and is idempotent using size and mtime', async t => {
  const {root,sftp}=setup(t), local=path.join(root,'local'), remote=path.join(root,'remote'); fs.mkdirSync(local); fs.mkdirSync(remote);
  fs.mkdirSync(path.join(local,'nested'));fs.writeFileSync(path.join(local,'nested','file'),'payload'); fs.writeFileSync(path.join(remote,'keep'),'retain');
  sftp.lstat=(p,cb)=>fs.lstat(p,(e,info)=> {
    if(e){if(e.code==='ENOENT')e.code=2;cb(e);return;}
    Object.defineProperty(info,'mtime',{value:Math.floor(info.mtimeMs/1000)});Object.defineProperty(info,'atime',{value:Math.floor(info.atimeMs/1000)});cb(null,info);
  });
  sftp.mkdir=fs.mkdir;sftp.utimes=fs.utimes;
  const manager={withSftp:async(_n,f)=>f(sftp),validateLocalPath:p=>p,validateRemotePath:p=>p,upload:async(l,r)=>fs.promises.copyFile(l,r),download:async(r,l)=>fs.promises.copyFile(r,l)};
  const files=new RemoteFiles(manager);
  const preview=await files.sync(local,remote,'upload');assert.equal(preview.actions.length,2);assert.ok(!fs.existsSync(path.join(remote,'nested')));
  await files.sync(local,remote,'upload',false);assert.equal(fs.readFileSync(path.join(remote,'nested','file'),'utf8'),'payload');assert.ok(fs.existsSync(path.join(remote,'keep')));
  assert.deepEqual((await files.sync(local,remote,'upload')).actions,[]);
  fs.writeFileSync(path.join(remote,'fresh'),'download');await files.sync(local,remote,'download',false);assert.equal(fs.readFileSync(path.join(local,'fresh'),'utf8'),'download');
  fs.symlinkSync('/etc',path.join(local,'link'));await assert.rejects(files.sync(local,remote,'upload'),/symlinks/);
});
test('directory browsing reports types, hidden entries and truncation', async t => {
  const {root,files}=setup(t);fs.writeFileSync(path.join(root,'file'),'hello');fs.mkdirSync(path.join(root,'dir'));fs.writeFileSync(path.join(root,'.hidden'),'secret');fs.symlinkSync('file',path.join(root,'link'));
  const result=await files.list(root);assert.deepEqual(result.entries.map(e=>[e.name,e.type]),[['dir','directory'],['file','file'],['link','symlink']]);
  assert.equal((await files.list(root,true)).entries.length,4);assert.equal((await files.list(root,false,1)).truncated,true);
});
test('search and sync exclusions avoid traversing excluded trees', async t => {
  const {root,files,sftp}=setup(t);fs.mkdirSync(path.join(root,'.git'));fs.writeFileSync(path.join(root,'.git','secret'),'needle');fs.writeFileSync(path.join(root,'main'),'needle');
  assert.equal((await files.search(root,'needle','grep')).results.length,1);
  assert.equal((await files.search(root,'needle','grep',100,undefined,[],{includeHidden:true})).results.length,2);
  const local=path.join(root,'local'),remote=path.join(root,'remote');fs.mkdirSync(local);fs.mkdirSync(remote);fs.symlinkSync('/etc',path.join(local,'excluded'));
  const manager={withSftp:async(_n,f)=>f(sftp),validateLocalPath:p=>p,validateRemotePath:p=>p};
  assert.deepEqual((await new RemoteFiles(manager).sync(local,remote,'upload',true,undefined,['excluded'])).actions,[]);
});
test('regular expressions, count/file modes, context and complete glob alternatives', async t => {
  const {root,files}=setup(t);fs.writeFileSync(path.join(root,'a.ts'),'before\nHello 12\nafter\nHELLO 34\n');fs.writeFileSync(path.join(root,'b.tsx'),'Hello 56');fs.writeFileSync(path.join(root,'.hidden'),'hidden');
  assert.equal((await files.search(root,'*.{ts,tsx}','glob')).results.length,2);
  assert.equal((await files.search(root,'[ab].ts*','glob')).results.length,2);
  assert.equal((await files.search(root,'.hidden','glob')).results.length,1);
  const counts=await files.search(root,'hello \\d+','grep',100,undefined,[],{regex:true,ignoreCase:true,outputMode:'count'});assert.deepEqual(counts.results.map(r=>r.count),[2,1]);
  const paths=await files.search(root,'Hello','grep',100,undefined,[],{outputMode:'files'});assert.equal(paths.results.length,2);
  const context=await files.search(path.join(root,'a.ts'),'Hello','grep',100,undefined,[],{contextBefore:1,contextAfter:1});assert.equal(context.results.length,3);assert.equal(context.results[0].match,false);
  await assert.rejects(files.search(root,'[','grep',100,undefined,[],{regex:true}),/regular expression/i);
});
