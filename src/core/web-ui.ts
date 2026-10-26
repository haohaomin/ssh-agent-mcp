import { ActivityMonitor } from "../services/activity-monitor.js";
import { z } from "zod";
import { diagnoseConnection } from "../tools/maintenance.js";
import { createReadStream, existsSync } from "node:fs";
import { extname, normalize, relative, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { DurableSessions } from "../services/durable-sessions.js";
import { RemoteFiles } from "../services/remote-files.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}

async function body(req: IncomingMessage): Promise<any> {
  if (!req.headers['content-type']?.split(';')[0].trim().toLowerCase().match(/^application\/json$/)) throw new Error('Expected application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 32 * 1024 * 1024) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** Local-only browser companion for the MCP server. It deliberately exposes
 * the same manager/services as MCP instead of opening a second SSH stack. */
export class WebUi {
  private readonly sessions: DurableSessions;
  private readonly files: RemoteFiles;
  private readonly root = new URL("../web/", import.meta.url);

  constructor(private readonly manager: SSHConnectionManager, private readonly urlPath: string, token?: string) {
    manager.activity = new ActivityMonitor(manager, token);
    this.sessions = new DurableSessions(manager);
    this.files = new RemoteFiles(manager);
  }

  private streams = 0;
  close() { this.manager.activity?.close(); this.manager.activity = undefined; }

  private events(req: IncomingMessage, res: ServerResponse) {
    const log = this.manager.activity!.log;
    if (this.streams >= 16) return json(res, 429, { error: 'Too many live activity streams' });
    this.streams++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const send = (event: unknown) => {
      if (res.writableLength > 24 * 1024 * 1024) { res.destroy(); return; }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = log.subscribe(event => { if (event.type === 'closed') res.end(); else send(event); });
    const timer = setInterval(() => { res.write(': keepalive\n\n'); }, 15000); timer.unref();
    res.once('close', () => { clearInterval(timer); unsubscribe(); this.streams--; });
    send({ type: 'snapshot', records: log.list(), storageError: log.storageError });
  }

  matches(pathname: string): boolean {
    return pathname === this.urlPath || pathname.startsWith(`${this.urlPath}/`);
  }

  isApi(pathname: string): boolean {
    return pathname.startsWith(`${this.urlPath}/api/`);
  }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    try {
      const suffix = pathname.slice(this.urlPath.length) || "/";
      if (suffix === "/" && req.method === "GET") {
        if (!new URL(req.url!, "http://localhost").pathname.endsWith('/')) {
          res.writeHead(308, { Location: `${this.urlPath}/` }); res.end(); return;
        }
        return await this.static(res, "index.html");
      }
      if (suffix.startsWith("/api/")) return await this.api(req, res, suffix);
      if (req.method === "GET" && ['app.js', 'activity.js', 'ui-model.js', 'styles.css'].includes(suffix.slice(1))) return await this.static(res, suffix.slice(1));
      if (req.method === "GET" && suffix === "/favicon.svg") return await this.static(res, "favicon.svg");
      json(res, 404, { error: "Not found" });
    } catch (error) {
      json(res, 400, { error: (error as Error).message || "Request failed" });
    }
  }

  private async static(res: ServerResponse, file: string): Promise<void> {
    const candidate = normalize(file).replace(/^\.([/\\]|$)/, "");
    const absolute = new URL(candidate, this.root);
    if (relative(new URL(this.root).pathname, absolute.pathname).split(sep).includes("..")) return json(res, 404, { error: "Not found" });
    if (!existsSync(absolute)) return json(res, 404, { error: "Not found" });
    res.writeHead(200, { "Content-Type": MIME[extname(candidate)] || "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'" });
    createReadStream(absolute).pipe(res);
  }

  private async api(req: IncomingMessage, res: ServerResponse, suffix: string): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (suffix === '/api/activity' && req.method === 'GET') return json(res, 200, { records: this.manager.activity!.log.list(), storageError: this.manager.activity!.log.storageError });
    if (suffix === '/api/activity/events' && req.method === 'GET') return this.events(req, res);
    const perform = <T>(operation: string, args: any, work: () => T | Promise<T>): Promise<T> => {
      let connectionName = args.connectionName || this.manager.getDefaultConnectionName();
      if (args.sessionName && operation !== 'web_sessions_start') {
        try { connectionName = this.sessions.connectionName(args.sessionName); } catch {}
      }
      if (args.forwardId) {
        const forward = this.manager.interactive.listForwards().find(item => item.forwardId === args.forwardId);
        connectionName = forward ? forward.connectionName || this.manager.getDefaultConnectionName() : undefined;
      }
      return this.manager.activity!.log.run(operation, 'web', args, connectionName, work,
        (id, result) => this.manager.activity?.observe(id, operation, args, result));
    };
    const connection = z.object({ connectionName: z.string().min(1).optional() });
    const readBody = async <T extends z.ZodType>(schema: T): Promise<z.infer<T>> => schema.parse(await body(req));
    const name = url.searchParams.get("connectionName") || undefined;
    const string = z.string().min(1);
    const sha = z.string().regex(/^[a-fA-F0-9]{64}$/);
    if (suffix === "/api/servers" && req.method === "GET") return json(res, 200, {
      defaultConnectionName: this.manager.getDefaultConnectionName(),
      servers: this.manager.getAllServerInfos().map(server => {
        const config = this.manager.getConfig(server.name);
        return { ...server, backend: config.backend || 'ssh2', source: config.nativeConfigFile || '启动配置', initialPath: config.allowedRemotePaths?.[0] || '.' };
      }),
    });
    if (suffix === "/api/config/reload" && req.method === "POST") {
      await readBody(z.object({}));
      try { return json(res, 200, { changes: await perform('web_config_reload', {}, () => this.manager.reloadFromSource()) }); }
      catch { throw new Error('Configuration reload failed; current configuration retained'); }
    }
    if (["/api/connect", "/api/disconnect", "/api/reconnect", "/api/diagnose"].includes(suffix) && req.method === "POST") {
      const data = await readBody(connection);
      if (suffix === "/api/disconnect") return json(res, 200, await perform('web_disconnect', data, () => this.manager.disconnectServer(data.connectionName)));
      if (suffix === "/api/diagnose") return json(res, 200, await perform('web_diagnose', data, () => diagnoseConnection(this.manager, data.connectionName)));
      if (suffix === "/api/reconnect") await perform('web_reconnect', data, () => this.manager.reconnect(data.connectionName));
      else await perform('web_connect', data, () => this.manager.connect(data.connectionName));
      return json(res, 200, { connected: data.connectionName || this.manager.getDefaultConnectionName() });
    }
    if (suffix === "/api/command" && req.method === "POST") {
      const data = await readBody(connection.extend({ command: string, cwd: z.string().optional(), timeoutMs: z.number().int().min(1).max(600000).optional() }));
      return json(res, 200, { output: await perform('web_command', data, () => this.manager.executeCommand(data.command, data.cwd, data.connectionName, { timeout: data.timeoutMs })) });
    }
    if (suffix === "/api/sessions" && req.method === "GET") return json(res, 200, await this.sessions.list());
    if (suffix === "/api/jobs" && req.method === "GET") {
      this.manager.getConfig(name);
      const key = name || this.manager.getDefaultConnectionName();
      const connected = this.manager.getAllServerInfos().some(server => server.name === key && server.connected);
      return json(res, 200, !connected || this.manager.isManuallyDisconnected(key)
        ? { paused: true, output: "" } : { output: await this.manager.jobList(100, key) });
    }
    if (suffix === "/api/jobs/kill" && req.method === "POST") {
      const data = await readBody(connection.extend({ jobId: string }));
      return json(res, 200, { output: await perform('web_job_kill', data, () => this.manager.jobKill(data.jobId, data.connectionName)) });
    }
    if (suffix === "/api/forwards" && req.method === "GET") return json(res, 200, this.manager.interactive.listForwards());
    if (suffix === "/api/forwards/stop" && req.method === "POST") {
      const data = await readBody(z.object({ forwardId: string }));
      return json(res, 200, await perform('web_forward_stop', data, () => this.manager.interactive.stopForward(data.forwardId)));
    }
    if (suffix === "/api/sessions/start" && req.method === "POST") {
      const data = await readBody(connection.extend({ sessionName: string.max(200), ensure: z.boolean().optional(), cols: z.number().int().min(1).max(1000).optional(), rows: z.number().int().min(1).max(1000).optional() }));
      const connectionName = data.connectionName || this.manager.getDefaultConnectionName();
      return json(res, 200, await perform('web_sessions_start', data, () => this.sessions.start(data.sessionName, connectionName, data.ensure, data)));
    }
    const session = /^\/api\/sessions\/([^/]+)(?:\/(read|write|resize|stop))?$/.exec(suffix);
    if (session) {
      const name = decodeURIComponent(session[1]);
      const readOptions = z.object({ offset: z.coerce.number().int().min(0).default(0), maxChars: z.coerce.number().int().min(1).max(262144).default(65536) });
      if ((!session[2] || session[2] === 'read') && req.method === 'GET') {
        const data = readOptions.parse(Object.fromEntries(url.searchParams));
        return json(res, 200, await this.sessions.read(name, data.offset, data.maxChars));
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (session[2] === 'read') {
        const data = await readBody(readOptions);
        return json(res, 200, await this.sessions.read(name, data.offset, data.maxChars));
      }
      if (session[2] === 'write') {
        const data = await readBody(z.object({ input: z.string().max(65536) }));
        return json(res, 200, await perform('web_session_write', { ...data, sessionName: name }, () => this.sessions.write(name, data.input)));
      }
      if (session[2] === 'resize') {
        const data = await readBody(z.object({ cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }));
        return json(res, 200, await perform('web_session_resize', { ...data, sessionName: name }, () => this.sessions.resize(name, data.cols, data.rows)));
      }
      if (session[2] === 'stop') { await readBody(z.object({})); return json(res, 200, await perform('web_session_stop', { sessionName: name }, () => this.sessions.stop(name))); }
    }
    if (suffix === "/api/files" && req.method === "GET") {
      const requested = url.searchParams.get("path") || ".";
      const directory = requested === '.' ? await this.files.initialDirectory(name) : requested;
      return json(res, 200, await this.files.list(directory, url.searchParams.get("hidden") === "true", 500, name));
    }
    if (suffix === "/api/file" && req.method === "GET") return json(res, 200, await perform('web_file_read', { remotePath: string.parse(url.searchParams.get('path')), connectionName: name }, () => this.files.readText(string.parse(url.searchParams.get('path')), name)));
    if (suffix === "/api/file/edit" && req.method === "POST") {
      const data = await readBody(connection.extend({ remotePath: string, content: z.string(), expectedSha256: sha, dryRun: z.boolean().optional(), backup: z.boolean().optional() }));
      return json(res, 200, await perform('web_file_edit', data, () => this.files.replace(data.remotePath, data.content, data.expectedSha256, data.connectionName, data)));
    }
    if (suffix === "/api/file/create" && req.method === "POST") {
      const data = await readBody(connection.extend({ remotePath: string, content: z.string() }));
      if (data.content.includes('\0')) throw new Error('Binary files are not supported by text upload');
      return json(res, 200, await perform('web_file_create', data, () => this.files.create(data.remotePath, data.content, data.connectionName)));
    }
    json(res, 404, { error: "Not found" });
  }
}
