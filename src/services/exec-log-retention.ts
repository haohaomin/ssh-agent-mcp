import fs from 'node:fs';
import path from 'node:path';
import {stateDirectory} from './durable-sessions.js';
/** Only our UUID-named regular logs are eligible. Never follow directory/file symlinks. */
export function cleanupExecLogs(options:{maxAgeDays?:number;maxTotalBytes?:number;dryRun?:boolean;protectPath?:string}={}) {
  const directory=path.join(stateDirectory(),'exec-output'),dryRun=options.dryRun??true;
  const maxAgeDays=options.maxAgeDays??7,maxTotalBytes=options.maxTotalBytes??512*1024*1024;
  if(!Number.isFinite(maxAgeDays)||maxAgeDays<0||!Number.isSafeInteger(maxTotalBytes)||maxTotalBytes<0)throw new Error('Invalid log retention limits');
  const result={dryRun,candidates:[] as string[],deleted:[] as string[],errors:[] as string[],retainedBytes:0};
  if(!fs.existsSync(directory))return result;
  if(!fs.lstatSync(directory).isDirectory())throw new Error('exec-output must be a real directory');
  const files=fs.readdirSync(directory).filter(n=>/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.log$/.test(n)).flatMap(name=>{
    const file=path.join(directory,name);try{const st=fs.lstatSync(file);return st.isFile()?[{file,st}]:[];}catch{return [];}
  }).sort((a,b)=>b.st.mtimeMs-a.st.mtimeMs);
  const protectedFile=files.find(f=>f.file===options.protectPath);
  let bytes=protectedFile?.st.size??0;
  for(const {file,st} of files){
    if(file===options.protectPath)continue;
    if(Date.now()-st.mtimeMs<=maxAgeDays*86400000 && bytes+st.size<=maxTotalBytes){bytes+=st.size;continue;}
    result.candidates.push(file);
    if(!dryRun)try{const current=fs.lstatSync(file);if(current.isFile()&&current.ino===st.ino&&current.mtimeMs===st.mtimeMs){fs.unlinkSync(file);result.deleted.push(file);}}catch{result.errors.push(file);}
  }
  result.retainedBytes=bytes;return result;
}
