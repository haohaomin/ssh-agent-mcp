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
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function body(req: IncomingMessage): Promise<any> {
  let text = "";
  for await (const chunk of req) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("Request body is too large");
  }
  return text ? JSON.parse(text) : {};
}

/** Local-only browser companion for the MCP server. It deliberately exposes
 * the same manager/services as MCP instead of opening a second SSH stack. */
export class WebUi {
  private readonly sessions: DurableSessions;
  private readonly files: RemoteFiles;
  private readonly root = new URL("../web/", import.meta.url);

  constructor(private readonly manager: SSHConnectionManager, private readonly urlPath: string) {
    this.sessions = new DurableSessions(manager);
    this.files = new RemoteFiles(manager);
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
      if (suffix === "/" && req.method === "GET") return await this.static(res, "index.html");
      if (suffix.startsWith("/api/")) return await this.api(req, res, suffix);
      if (req.method === "GET" && /^\/(app|styles)\.\w+$/.test(suffix)) return await this.static(res, suffix.slice(1));
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
    res.writeHead(200, { "Content-Type": MIME[extname(candidate)] || "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(absolute).pipe(res);
  }

  private async api(req: IncomingMessage, res: ServerResponse, suffix: string): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (suffix === "/api/servers" && req.method === "GET") return json(res, 200, { defaultConnectionName: this.manager.getDefaultConnectionName(), servers: this.manager.getAllServerInfos() });
    if (suffix === "/api/connect" && req.method === "POST") { const data = await body(req); await this.manager.connect(data.connectionName); return json(res, 200, { connected: data.connectionName || this.manager.getDefaultConnectionName() }); }
    if (suffix === "/api/command" && req.method === "POST") { const data = await body(req); return json(res, 200, { output: await this.manager.executeCommand(String(data.command || ""), data.cwd, data.connectionName, { timeout: data.timeoutMs }) }); }
    if (suffix === "/api/sessions" && req.method === "GET") return json(res, 200, await this.sessions.list());
    if (suffix === "/api/jobs" && req.method === "GET") return json(res, 200, { output: await this.manager.jobList(100, url.searchParams.get("connectionName") || undefined) });
    if (suffix === "/api/jobs/kill" && req.method === "POST") { const data = await body(req); return json(res, 200, { output: await this.manager.jobKill(String(data.jobId), data.connectionName) }); }
    if (suffix === "/api/forwards" && req.method === "GET") return json(res, 200, this.manager.interactive.listForwards());
    if (suffix === "/api/forwards/stop" && req.method === "POST") { const data = await body(req); return json(res, 200, this.manager.interactive.stopForward(String(data.forwardId))); }
    if (suffix === "/api/sessions/start" && req.method === "POST") { const data = await body(req); return json(res, 200, await this.sessions.start(String(data.sessionName), data.connectionName, Boolean(data.ensure), data)); }
    const session = /^\/api\/sessions\/([^/]+)(?:\/(read|write|resize|stop))?$/.exec(suffix);
    if (session) {
      const name = decodeURIComponent(session[1]);
      if (!session[2] && req.method === "GET") return json(res, 200, await this.sessions.read(name, Number(url.searchParams.get("offset") || 0), Number(url.searchParams.get("maxChars") || 65536)));
      const data = await body(req);
      if (session[2] === "read") return json(res, 200, await this.sessions.read(name, Number(data.offset || 0), Number(data.maxChars || 65536)));
      if (session[2] === "write") return json(res, 200, await this.sessions.write(name, String(data.input || "")));
      if (session[2] === "resize") return json(res, 200, await this.sessions.resize(name, Number(data.cols), Number(data.rows)));
      if (session[2] === "stop") return json(res, 200, await this.sessions.stop(name));
    }
    if (suffix === "/api/files" && req.method === "GET") return json(res, 200, await this.files.list(url.searchParams.get("path") || ".", url.searchParams.get("hidden") === "true", 500, url.searchParams.get("connectionName") || undefined));
    if (suffix === "/api/file" && req.method === "GET") {
      const raw = await this.manager.readFile(url.searchParams.get("path") || "", {}, url.searchParams.get("connectionName") || undefined);
      const marker = raw.indexOf("\n---\n");
      const content = (marker >= 0 ? raw.slice(marker + 5) : raw).split("\n").map(line => line.replace(/^\d+\t/, "")).join("\n");
      return json(res, 200, { path: url.searchParams.get("path"), content });
    }
    if (suffix === "/api/file/edit" && req.method === "POST") { const data = await body(req); return json(res, 200, await this.files.edit(String(data.remotePath), data.edits, data.connectionName, data)); }
    if (suffix === "/api/file/create" && req.method === "POST") { const data = await body(req); return json(res, 200, await this.files.create(String(data.remotePath), String(data.content || ""), data.connectionName)); }
    json(res, 404, { error: "Not found" });
  }
}
