import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CommandLineParser } from '../cli/command-line-parser.js';
import { stateDirectory } from '../services/durable-sessions.js';
import { Logger } from '../utils/logger.js';

export interface SharedService {
  id: string; key: string; pid: number; endpoint: string; ui: string; token: string;
}
const worker = fileURLToPath(new URL('./shared-worker.js', import.meta.url));
const management = (service: SharedService) => new URL('/.well-known/ssh-agent-mcp', service.endpoint);
const headers = (service: SharedService) => ({ Authorization: `Bearer ${service.token}` });
const directory = () => { const dir = path.join(stateDirectory(), 'services'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
function buildIdentity(): string {
  const hash = createHash('sha256');
  const visit = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const filename = path.join(dir, item.name);
      if (item.isDirectory()) visit(filename);
      else if (/\.(js|html|css)$/.test(item.name)) hash.update(filename).update(fs.readFileSync(filename));
    }
  };
  visit(fileURLToPath(new URL('../', import.meta.url)));
  return hash.digest('hex');
}
export function serviceKey(args: string[]): string {
  const parsed = CommandLineParser.parseArgs(args);
  // cwd is also an allowed local file root. Never combine different permissions.
  const sources: string[] = [];
  for (let i=0;i<args.length;i++) {
    for (const option of ['--config-file', '--ssh-config-file']) {
      if (args[i] === option) sources.push(option, path.resolve(args[i+1]));
      else if (args[i].startsWith(option+'=')) sources.push(option, path.resolve(args[i].slice(option.length+1)));
    }
  }
  return createHash('sha256').update(canonical({ configs: parsed.configs, cwd: fs.realpathSync(process.cwd()), sources,
    defaultConnection: Object.keys(parsed.configs)[0],
    importSsh: args.includes('--import-ssh-config'), agent: process.env.SSH_AUTH_SOCK,
    token: parsed.http.token, httpPath: parsed.http.path, uiPath: parsed.uiPath, build: buildIdentity(),
  })).digest('hex').slice(0,32);
}
export function readService(filename: string): SharedService | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8')) as SharedService;
    const endpoint = new URL(value.endpoint), ui = new URL(value.ui);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password ||
      ui.origin !== endpoint.origin || !value.token || !value.id || !value.key || !Number.isSafeInteger(value.pid)) return;
    return value;
  } catch { return; }
}
export async function serviceAlive(service: SharedService): Promise<boolean> {
  try {
    const response = await fetch(management(service), { headers: headers(service), signal: AbortSignal.timeout(1500), redirect: 'error' });
    return response.ok && (await response.json() as { id?: string }).id === service.id;
  } catch { return false; }
}
function alivePid(pid: number): boolean { try { process.kill(pid,0); return true; } catch { return false; } }

export async function ensureService(args: string[]): Promise<SharedService> {
  const parsed = CommandLineParser.parseArgs(args);
  if (!['127.0.0.1','localhost','::1'].includes(parsed.http.host)) throw new Error('Shared service is local-only. Use --standalone for an explicit network listener.');
  const key = serviceKey(args), dir = directory(), filename = path.join(dir,key+'.json'), lock = path.join(dir,key+'.lock');
  const deadline = Date.now()+20000;
  while (Date.now()<deadline) {
    const existing = readService(filename);
    if (existing && await serviceAlive(existing)) return existing;
    let acquired = false;
    try { fs.writeFileSync(lock, JSON.stringify({pid:process.pid}), {flag:'wx',mode:0o600}); acquired = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lock);
        let owner: {pid?:number} = {}; try { owner=JSON.parse(fs.readFileSync(lock,'utf8')); } catch {}
        // Allow a just-created lock time to be filled before recovering it.
        if (Date.now()-stat.mtimeMs>2000 && (!owner.pid || !alivePid(owner.pid))) fs.rmSync(lock,{force:true});
      } catch {}
      await delay(80); continue;
    }
    if (acquired) {
      try {
        const raced = readService(filename);
        if (raced && await serviceAlive(raced)) return raced;
        const id = randomBytes(24).toString('hex'), token = parsed.http.token || randomBytes(32).toString('hex');
        const logPath = path.join(dir,key+'.log');
        // Keep startup logs bounded between launches.
        const log = fs.openSync(logPath,'w',0o600);
        const child = fork(worker, [], { detached:true, stdio:['ignore','ignore',log,'ipc'], execArgv:[] });
        fs.closeSync(log);
        const result = await new Promise<SharedService>((resolve,reject) => {
          const timer=setTimeout(() => { child.kill(); reject(new Error(`Shared service startup timed out; see ${logPath}`)); },15000);
          child.once('error',error => { clearTimeout(timer); reject(error); });
          child.once('exit',() => { clearTimeout(timer); reject(new Error(`Shared service failed to start; see ${logPath}`)); });
          child.on('message',(message: any) => {
            if (message?.ready) { clearTimeout(timer); resolve(message.ready); }
            else if (message?.error) { clearTimeout(timer); reject(new Error(message.error)); }
          });
          child.send({ args, id, key, token, filename });
        });
        child.disconnect(); child.unref();
        return result;
      } finally { fs.rmSync(lock,{force:true}); }
    }
  }
  throw new Error('Timed out waiting for shared service startup lock');
}

export async function manageServices(action: string): Promise<void> {
  if (!['status','stop'].includes(action)) throw new Error('Usage: ssh-agent-mcp service status|stop');
  const items = fs.readdirSync(directory()).filter(name=>name.endsWith('.json'));
  let count=0;
  for (const item of items) {
    const filename=path.join(directory(),item), service=readService(filename);
    if (!service || !await serviceAlive(service)) continue;
    count++;
    if (action==='stop') {
      const response=await fetch(management(service),{method:'DELETE',headers:headers(service),signal:AbortSignal.timeout(3000),redirect:'error'});
      if (!response.ok) throw new Error('Could not stop shared service');
      console.log(`Stopped shared service ${service.pid}: ${service.ui}`);
    } else console.log(`Running PID ${service.pid}: ${service.ui} (MCP ${service.endpoint})`);
  }
  if (!count) console.log('No running shared services');
}

export async function launchWorkbench(args: string[]): Promise<void> {
  const service=await ensureService(args);
  Logger.log(`SSH Workbench available at ${service.ui}`);
  Logger.log('Shared service runs in background. Stop with: ssh-agent-mcp service stop');
  if (args.includes('--no-open')) return;
  // Fragment stays in the browser and is removed immediately by the page.
  const url=service.ui+'#token='+encodeURIComponent(service.token);
  const command=process.platform==='darwin'?'open':process.platform==='win32'?'rundll32':'xdg-open';
  const child=spawn(command,process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url],{stdio:'ignore',detached:true});
  child.once('error',()=>Logger.log('Could not open browser automatically. Use the workbench URL and token from the private service registry.','error'));
  child.unref();
}

export async function bridgeStdio(args: string[]): Promise<void> {
  let service=await ensureService(args);
  let http=new StreamableHTTPClientTransport(new URL(service.endpoint),{requestInit:{headers:headers(service)}});
  const stdio=new StdioServerTransport();
  const connect=async () => {
    http.onmessage=message => { void stdio.send(message); };
    http.onerror=()=>{};
    await http.start();
  };
  await connect();
  Logger.log(`MCP automatically connected to shared service; SSH Workbench: ${service.ui}`);
  let failed = false;
  let reconnect: Promise<void> | undefined;
  const recover = async () => {
    if (!reconnect) reconnect = (async () => {
      await http.close();
      service = await ensureService(args);
      http = new StreamableHTTPClientTransport(new URL(service.endpoint), {requestInit:{headers:headers(service)}});
      await connect();
      failed = false;
    })().finally(() => { reconnect = undefined; });
    await reconnect;
  };
  // HTTP is stateless; independent stdio clients may reuse request IDs safely.
  stdio.onmessage=message => {
    void (async () => { if (failed) await recover(); await http.send(message); })().catch(async () => {
      failed = true;
      if ('id' in message && 'method' in message) await stdio.send({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:'Shared service request failed. The operation may have run and was not retried. The next request will reconnect automatically.'}});
    });
  };
  const close=() => { void http.close().finally(()=>process.exit(0)); };
  process.once('SIGINT',close); process.once('SIGTERM',close);
  process.stdin.once('end',close); process.stdin.once('close',close);
  stdio.onerror=error => Logger.log(error.message,'error');
  await stdio.start();
}
