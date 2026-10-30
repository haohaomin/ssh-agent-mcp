import { RedactionStream } from '../utils/output-redaction.js';
import { assertUnrestricted } from '../utils/execution-policy.js';
import fs from 'node:fs';
import { withEnvironment, shellQuote } from '../utils/shell.js';
import type { Client, ClientChannel } from 'ssh2';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import type { SSHConfig } from '../models/types.js';

type Connections = { connect(name?: string): Promise<void>; getClient(name?: string): Client; getConfig(name?: string): SSHConfig };
type Session = { id: string; connectionName?: string; channel: ClientChannel; cols:number; rows:number; output: string; base: number; total: number; closed: boolean; error?: string; decoder: StringDecoder; stderrDecoder: StringDecoder };
function dimensions(cols:number,rows:number){if(!Number.isInteger(cols)||!Number.isInteger(rows)||cols<1||cols>1000||rows<1||rows>1000)throw new Error('Terminal cols and rows must be integers between 1 and 1000');}
export class InteractiveService {
  private generation = 0;
  private pendingLocalForwards = 0;
  private pendingRemoteForwards = 0;
  private sessions = new Map<string, Session>();
  private pending = new Map<string, Promise<unknown>>();
  private forwards = new Map<string, { client: Client; onClose: () => void; server: net.Server; sockets: Set<net.Socket>; connectionName?: string; host: string; port: number; remoteHost: string; remotePort: number }>();
  private reverseForwards = new Map<string, { onClose: () => void; client: Client; port: number; bindHost: string; localHost: string; localPort: number; connectionName?: string; sockets: Set<net.Socket>; handler: (...args: any[]) => void }>();
  constructor(private manager: Connections) {}
  async start(id: string, connectionName?: string, ensure = false, options: { cwd?: string; env?: Record<string, string>; shell?: string; logPath?: string;cols?:number;rows?:number } = {}): Promise<unknown> {
    assertUnrestricted(this.manager.getConfig(connectionName), 'Interactive sessions');
    const cols=options.cols??120,rows=options.rows??30;dimensions(cols,rows);
    const existing = this.sessions.get(id);
    if (existing && !existing.closed) {
      if (!ensure || existing.connectionName !== connectionName) throw new Error('Session name already in use');
      return this.info(existing);
    }
    if (this.pending.has(id)) {
      if (!ensure) throw new Error('Session is starting');
      await this.pending.get(id);
      return this.start(id, connectionName, true, options);
    }
    if (this.sessions.size >= 100 && !existing) throw new Error('Session limit reached; stop unused sessions');
    const config = this.manager.getConfig(connectionName);
    if (config.commandWhitelist?.length || config.commandBlacklist?.length) throw new Error('Interactive shells require an unrestricted connection; command filters cannot validate arbitrary terminal input');
    const generation = this.generation;
    const operation = (async () => {
      await this.manager.connect(connectionName);
      if (generation !== this.generation) throw new Error("Server is closing");
      const client = this.manager.getClient(connectionName);
      const channel = await new Promise<ClientChannel>((resolve, reject) => {
        const timer = setTimeout(() => { done = true; reject(new Error('Shell open timed out')); }, 10000);
        let done = false;
        client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
          clearTimeout(timer);
          if (done) { stream?.close(); return; }
          done = true; err ? reject(err) : resolve(stream);
        });
      });
      if (generation !== this.generation) { channel.close(); throw new Error("Server is closing"); }
      const session: Session = { id, connectionName, channel, cols, rows, output: '', base: 0, total: 0, closed: false, decoder: new StringDecoder('utf8'), stderrDecoder: new StringDecoder('utf8') };
      const logFd = options.logPath ? fs.openSync(options.logPath, 'a', 0o600) : undefined;
      const stdoutRedactor = new RedactionStream(), stderrRedactor = new RedactionStream();
      const append = (text: string) => {
        if (logFd !== undefined) fs.writeSync(logFd, text);
        session.output += text; session.total += text.length;
        if (session.output.length > 1024 * 1024) session.output = session.output.slice(-1024 * 1024);
        session.base = session.total - session.output.length;
      };
      channel.on('data', (data: Buffer) => append(stdoutRedactor.write(session.decoder.write(data))));
      channel.stderr.on('data', (data: Buffer) => append(stderrRedactor.write(session.stderrDecoder.write(data))));
      channel.on('error', (err: Error) => { session.error = err.message; session.closed = true; });
      const onClientClose = () => { session.closed = true; };
      channel.on('close', () => { append(stdoutRedactor.write(session.decoder.end()) + stdoutRedactor.finishMasked()); append(stderrRedactor.write(session.stderrDecoder.end()) + stderrRedactor.finishMasked()); if (logFd !== undefined) fs.closeSync(logFd); session.closed = true; client.removeListener('close', onClientClose); });
      client.once('close', onClientClose);
      this.sessions.set(id, session);
      if (options.cwd || Object.keys(options.env || {}).length) {
        channel.write(withEnvironment(options.cwd ? `cd -- ${shellQuote(options.cwd)}` : ':', options.env) + '\n');
      }
      if (options.shell) channel.write(`exec ${shellQuote(options.shell)}\n`);
      return this.info(session);
    })();
    this.pending.set(id, operation);
    try { return await operation; } finally { this.pending.delete(id); }
  }
  private info(s: Session) { return { sessionName: s.id, connectionName: s.connectionName, cols:s.cols,rows:s.rows,closed: s.closed, baseOffsetChars: s.base, nextOffsetChars: s.total, error: s.error }; }
  resize(id:string,cols:number,rows:number){
    dimensions(cols,rows);const s=this.sessions.get(id);if(!s||s.closed)throw new Error('Session is not running');
    s.channel.setWindow(rows,cols,0,0);s.cols=cols;s.rows=rows;return this.info(s);
  }
  list() { return [...this.sessions.values()].map(s => this.info(s)); }
  read(id: string, offset = 0, maxChars = 65536) {
    const s = this.sessions.get(id); if (!s) throw new Error('Session not found');
    if (offset > s.total) throw new Error('Offset exceeds session output');
    const start = Math.max(offset, s.base); const text = s.output.slice(start - s.base, start - s.base + maxChars);
    return { ...this.info(s), output: text, nextOffsetChars: start + text.length, truncated: offset < s.base };
  }
  write(id: string, input: string) {
    const s = this.sessions.get(id); if (!s || s.closed) throw new Error('Session is not running');
    assertUnrestricted(this.manager.getConfig(s.connectionName), 'Interactive session input');
    s.channel.write(input); return this.info(s);
  }
  stop(id: string) { const s = this.sessions.get(id); if (!s) throw new Error('Session not found'); s.channel.close(); this.sessions.delete(id); return { stopped: id }; }
  private assertForwardConnection(generation: number, name?: string, client?: Client) {
    if (generation !== this.generation) throw new Error('Server is closing');
    if (client && this.manager.getClient(name) !== client) throw new Error('SSH connection changed while opening forward');
  }
  async forward(remoteHost: string, remotePort: number, localPort = 0, connectionName?: string, bindHost = '127.0.0.1') {
    assertUnrestricted(this.manager.getConfig(connectionName), 'Port forwarding');
    if (this.forwards.size + this.pendingLocalForwards >= 32) throw new Error('Forward limit reached');
    this.pendingLocalForwards++;
    try { return await this.openLocalForward(remoteHost, remotePort, localPort, connectionName, bindHost, this.generation); }
    finally { this.pendingLocalForwards--; }
  }
  private async openLocalForward(remoteHost: string, remotePort: number, localPort: number, connectionName: string | undefined, bindHost: string, generation: number) {
    await this.manager.connect(connectionName);
    this.assertForwardConnection(generation, connectionName);
    const client = this.manager.getClient(connectionName);
    let closed = false;
    const markClosed = () => { closed = true; };
    client.once('close', markClosed);
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on('error', () => socket.destroy()); socket.on('close', () => sockets.delete(socket));
      client.forwardOut('127.0.0.1', socket.remotePort || 0, remoteHost, remotePort, (err, stream) => {
        if (err || socket.destroyed) { stream?.destroy(); socket.destroy(); return; }
        stream.on('error', () => socket.destroy());
        socket.on('close', () => stream.destroy());
        stream.on('close', () => socket.destroy());
        socket.pipe(stream).pipe(socket);
      });
    });
    const id = randomUUID();
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(localPort, bindHost, () => { server.removeListener('error', reject); resolve(); }); });
      if (closed) throw new Error('SSH connection closed while opening forward');
      this.assertForwardConnection(generation, connectionName, client);
    } catch (error) {
      for (const socket of sockets) socket.destroy();
      server.close();
      throw error;
    } finally { client.removeListener('close', markClosed); }
    server.on('error', () => { if (this.forwards.has(id)) this.stopForward(id); });
    const addr = server.address() as net.AddressInfo;
    const onClose = () => { if (this.forwards.has(id)) this.stopForward(id); };
    this.forwards.set(id, { client, onClose, server, sockets, connectionName, host: addr.address, port: addr.port, remoteHost, remotePort });
    client.once('close', onClose);
    return this.listForwards().find(f => f.forwardId === id)!;
  }
  async reverseForward(localHost: string, localPort: number, remotePort = 0, connectionName?: string, bindHost = '127.0.0.1') {
    assertUnrestricted(this.manager.getConfig(connectionName), 'Reverse port forwarding');
    if (this.reverseForwards.size + this.pendingRemoteForwards >= 32) throw new Error('Forward limit reached');
    this.pendingRemoteForwards++;
    try { return await this.openRemoteForward(localHost, localPort, remotePort, connectionName, bindHost, this.generation); }
    finally { this.pendingRemoteForwards--; }
  }
  private async openRemoteForward(localHost: string, localPort: number, remotePort: number, connectionName: string | undefined, bindHost: string, generation: number) {
    await this.manager.connect(connectionName);
    this.assertForwardConnection(generation, connectionName);
    const client = this.manager.getClient(connectionName);
    const cancel = (port: number) => { try { client.unforwardIn(bindHost, port, () => {}); } catch {} };
    const port = await new Promise<number>((resolve, reject) => {
      let done = false;
      const finish = (error?: Error | null, allocated?: number) => {
        if (done) { if (!error && allocated !== undefined) cancel(allocated); return; }
        done = true; clearTimeout(timer); client.removeListener('close', onClose);
        error ? reject(error) : resolve(allocated!);
      };
      const onClose = () => finish(new Error('SSH connection closed while opening forward'));
      const timer = setTimeout(() => finish(new Error('Remote forward open timed out')), 10000);
      client.once('close', onClose);
      try { client.forwardIn(bindHost, remotePort, finish); }
      catch (error) { finish(error as Error); }
    });
    try { this.assertForwardConnection(generation, connectionName, client); }
    catch (error) { cancel(port); throw error; }
    const id = randomUUID(), sockets = new Set<net.Socket>();
    const handler = (info: { destPort: number }, accept: () => ClientChannel) => {
      if (info.destPort !== port) return;
      const channel = accept();
      const socket = net.connect(localPort, localHost); sockets.add(socket);
      socket.on('error', () => channel.destroy()); channel.on('error', () => socket.destroy());
      socket.on('close', () => { sockets.delete(socket); channel.destroy(); }); channel.on('close', () => socket.destroy());
      socket.pipe(channel).pipe(socket);
    };
    client.on('tcp connection', handler);
    const onClose = () => { if (this.reverseForwards.has(id)) this.stopForward(id); };
    this.reverseForwards.set(id, { onClose, client, port, bindHost, localHost, localPort, connectionName, sockets, handler });
    client.once('close', onClose);
    return { forwardId: id, direction: 'remote', bindHost, remotePort: port, localHost, localPort, connectionName };
  }
  listForwards() { return [...[...this.reverseForwards].map(([id, f]) => ({ forwardId: id, direction: 'remote', connectionName: f.connectionName, remotePort: f.port, bindHost: f.bindHost, localHost: f.localHost, localPort: f.localPort })), ...[...this.forwards].map(([id, f]) => ({ forwardId: id, connectionName: f.connectionName, localHost: f.host, localPort: f.port, remoteHost: f.remoteHost, remotePort: f.remotePort, direction: "local" }))]; }
  stopForward(id: string) {
    const reverse = this.reverseForwards.get(id);
    if (reverse) {
      reverse.client.removeListener('tcp connection', reverse.handler);
      for (const socket of reverse.sockets) socket.destroy();
      reverse.client.removeListener('close', reverse.onClose);
      this.reverseForwards.delete(id);
      // A remote disconnect has already removed the forwarding. ssh2 throws if we cancel it again.
      try { reverse.client.unforwardIn(reverse.bindHost, reverse.port, () => {}); } catch {}
      return { stopped: id };
    }
    const f = this.forwards.get(id); if (!f) throw new Error('Forward not found'); f.client.removeListener('close', f.onClose); for (const s of f.sockets) s.destroy(); f.server.close(); this.forwards.delete(id); return { stopped: id }; }
  close() { this.generation++; for (const id of this.sessions.keys()) this.stop(id); for (const id of this.forwards.keys()) this.stopForward(id); for (const id of this.reverseForwards.keys()) this.stopForward(id); }
}
