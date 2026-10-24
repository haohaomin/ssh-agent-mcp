import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SSHConfig, SshConnectionConfigMap } from '../models/types.js';

type Directive = { key: string; values: string[]; source: string; children?: Directive[] };
export type ImportResult = { configs: SshConnectionConfigMap; warnings: string[]; skipped: Record<string, string> };

// Parse data only: never execute Match exec, ProxyCommand or local commands.
function tokens(line: string): string[] {
  const out: string[] = []; let value = '', quote = '', escaped = false;
  for (const c of line) {
    if (escaped) { value += c; escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (quote) { if (c === quote) quote = ''; else value += c; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#') break;
    if (/\s/.test(c)) { if (value) { out.push(value); value = ''; } } else value += c;
  }
  if (quote || escaped) throw new Error('Unterminated quote or escape in SSH config');
  if (value) out.push(value);
  return out;
}
function pattern(value: string): RegExp {
  return new RegExp('^' + value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}
function matches(host: string, patterns: string[]): boolean {
  return patterns.some(p => !p.startsWith('!') && pattern(p).test(host)) &&
    !patterns.some(p => p.startsWith('!') && pattern(p.slice(1)).test(host));
}
function expandHome(value: string): string {
  return value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}
function globFiles(value: string): string[] {
  const absolute = path.resolve(expandHome(value));
  let paths = [path.parse(absolute).root];
  for (const part of absolute.slice(path.parse(absolute).root.length).split(path.sep)) {
    paths = paths.flatMap(base => {
      if (!/[?*]/.test(part)) return [path.join(base, part)];
      try { return fs.readdirSync(base).sort().filter(n => pattern(part).test(n)).map(n => path.join(base, n)); }
      catch { return []; }
    });
  }
  return paths.filter(p => fs.existsSync(p));
}
function readConfig(file: string, stack: string[] = []): Directive[] {
  const real = fs.realpathSync(file);
  if (stack.includes(real) || stack.length >= 16) throw new Error(`SSH Include cycle/depth limit: ${file}`);
  const directives: Directive[] = [];
  for (const [index, line] of fs.readFileSync(real, 'utf8').split(/\r?\n/).entries()) {
    const parts = tokens(line.replace(/^\s*([\w]+)\s*=\s*/, '$1 '));
    if (!parts.length) continue;
    const key = parts.shift()!.toLowerCase();
    const source = `${file}:${index + 1}`;
    if (key === 'include') {
      for (const item of parts) {
        // OpenSSH user-config relative Includes are relative to ~/.ssh.
        const resolved = path.isAbsolute(expandHome(item)) ? expandHome(item) : path.join(file.startsWith('/etc/ssh/')?'/etc/ssh':path.join(os.homedir(), '.ssh'), item);
        for (const included of globFiles(resolved)) directives.push({ key: "include", values: [], source, children: readConfig(included, [...stack, real]) });
      }
    } else directives.push({ key, values: parts, source });
  }
  return directives;
}
export function importOpenSsh(file = path.join(os.homedir(), '.ssh', 'config'), selected?: string[], nativeFallback = true): ImportResult {
  const defaultFile = path.join(os.homedir(), '.ssh', 'config');
  const usesSystemConfig = path.resolve(expandHome(file)) === defaultFile;
  const directives = fs.existsSync(expandHome(file)) ? readConfig(expandHome(file)) : usesSystemConfig ? [] : readConfig(expandHome(file));
  if (usesSystemConfig && fs.existsSync('/etc/ssh/ssh_config')) directives.push({key:'host',values:['*'],source:'system defaults'}, ...readConfig('/etc/ssh/ssh_config'));
  const discover = (items: Directive[]): string[] => items.flatMap(d => d.key === 'host' ? d.values : d.children ? discover(d.children) : []);
  const aliases = selected ?? [...new Set(discover(directives).filter(h => !/[!*?]/.test(h)))];
  const warnings = new Set<string>();
  const configs: SshConnectionConfigMap = Object.create(null);
  const skipped: Record<string, string> = Object.create(null);
  const supported = new Set(['hostname','user','port','identityfile','identityagent','identitiesonly','proxyjump','serveraliveinterval','serveralivecountmax','userknownhostsfile','hostkeyalias']);
  function resolve(alias: string, chain: string[] = []): SSHConfig {
    if (chain.includes(alias) || chain.length >= 8) throw new Error(`ProxyJump cycle/depth limit: ${[...chain, alias].join(' -> ')}`);
    const values = new Map<string, string[]>(); let active = true;
    const apply = (items: Directive[]) => { for (const d of items) {
      if (d.key === "include") { if (active) apply(d.children || []); continue; }
      if (d.key === 'host') { active = matches(alias, d.values); continue; }
      // Match semantics may depend on commands, canonicalization and multiple passes.
      // Fail closed instead of silently importing the wrong host/authentication.
      if (d.key === 'match') throw new Error(`Unsupported Match block (${d.source}); use a separate simple config or explicit JSON`);
      if (!active) continue;
      if (['proxycommand','certificatefile','localcommand','remotecommand','localforward','remoteforward','dynamicforward'].includes(d.key) && d.values.join(' ') !== 'none') {
        throw new Error(`Unsupported ${d.key} (${d.source})`);
      }
      if (!supported.has(d.key)) throw new Error(`Unsupported ${d.key} in ssh2 mapping (${d.source})`);
      if (d.key === 'identityfile') values.set(d.key, [...(values.get(d.key) ?? []), ...d.values]);
      else if (!values.has(d.key)) values.set(d.key, d.values);
    }
    }; apply(directives);
    const get = (key: string) => values.get(key)?.[0];
    const username = get('user') || os.userInfo().username;
    const host = (get('hostname') || alias).replace(/%h/g, alias);
    const port = Number(get('port') || 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port for ${alias}`);
    const expand = (s: string) => {
      const expanded = expandHome(s.replace(/%[dhru%]/g, t => ({'%d':os.homedir(),'%h':host,'%r':username,'%u':os.userInfo().username,'%%':'%'}[t]!)));
      if (/%[a-zA-Z]|\$\{/.test(expanded)) throw new Error(`Unsupported path token: ${s}`);
      return expanded;
    };
    const identities = (values.get('identityfile') ?? ['~/.ssh/id_ed25519','~/.ssh/id_rsa','~/.ssh/id_ecdsa']).filter(v => v !== 'none').map(expand);
    const existingKeys = identities.filter(p => fs.existsSync(p));
    if (identities.length > 1 && values.has('identityfile')) throw new Error('Unsupported multiple IdentityFile authentication in ssh2 mapping');
    const agentValue = get('identityagent');
    const agent = get('identitiesonly') === 'yes' || agentValue === 'none' ? undefined :
      agentValue === 'SSH_AUTH_SOCK' || !agentValue ? process.env.SSH_AUTH_SOCK : expand(agentValue);
    if (agent && existingKeys.length) warnings.add(`${alias}: SSH Agent takes priority over the imported key`);
    if (!agent && !existingKeys.length) warnings.add(`${alias}: no available key/agent; add authentication before connecting`);
    const knownHosts = get('userknownhostsfile');
    if (knownHosts === 'none') throw new Error('UserKnownHostsFile none is not supported for imported hosts');
    if ((values.get('userknownhostsfile')?.length ?? 0) > 1) throw new Error('Unsupported multiple known_hosts files in ssh2 mapping');
    const knownPath = expand(knownHosts || '~/.ssh/known_hosts');
    if (fs.existsSync(knownPath) && /^(?:@cert-authority |[^#\n ]*[*?])/m.test(fs.readFileSync(knownPath,'utf8'))) throw new Error('Unsupported CA or wildcard known_hosts entries in ssh2 mapping');
    const config: SSHConfig = { name: alias, host, port, username, privateKey: existingKeys[0], agent,
      knownHostsFile: expand(knownHosts || '~/.ssh/known_hosts'), hostKeyAlias: get('hostkeyalias'),
      passphrase: process.env.SSH_MCP_PASSPHRASE };
    if (get('serveraliveinterval')) config.keepaliveIntervalMs = Number(get('serveraliveinterval')) * 1000;
    if (get('serveralivecountmax')) config.keepaliveCountMax = Number(get('serveralivecountmax'));
    const jump = get('proxyjump');
    if (jump && jump !== 'none') {
      config.jumpHosts = jump.split(',').map(spec => {
        const parsed = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(spec);
        if (!parsed) throw new Error(`Invalid ProxyJump: ${spec}`);
        const hop = resolve(parsed[2].replace(/^\[|\]$/g, ''), [...chain, alias]);
        if (parsed[1]) hop.username = parsed[1];
        if (parsed[3]) { hop.port = Number(parsed[3]); if (hop.port < 1 || hop.port > 65535) throw new Error('Invalid ProxyJump port'); }
        return hop;
      });
    }
    return config;
  }
  for (const alias of aliases) {
    try { configs[alias] = resolve(alias); } catch (error) {
      const reason = (error as Error).message;
      if (nativeFallback && /Unsupported|not supported|multiple/.test(reason)) {
        configs[alias] = {name:alias,host:alias,port:22,username:os.userInfo().username,backend:'openssh',nativeTarget:alias,nativeConfigFile:usesSystemConfig?undefined:path.resolve(expandHome(file))};
        warnings.add(`${alias}: using native OpenSSH compatibility for ${reason}. Config commands run only when connecting.`);
      } else skipped[alias] = reason;
    }
  }
  return { configs, warnings: [...warnings], skipped };
}
