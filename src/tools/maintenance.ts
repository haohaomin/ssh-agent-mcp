import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { DurableSessions } from "../services/durable-sessions.js";
import type { SSHConfig } from "../models/types.js";
import { connectionName } from "./common.js";
import { toToolError } from "../utils/tool-error.js";

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function failure(error: unknown) {
  const e = toToolError(error, "UNKNOWN_ERROR");
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ code: e.code, message: e.message, retriable: e.retriable }) }] };
}

function localBinary(binary: string) {
  const probe = spawnSync(binary, [binary === 'rsync' ? '--version' : '-V'], { encoding: "utf8", timeout: 3000, maxBuffer: 8192 });
  const output = `${probe.stdout || ""}${probe.stderr || ""}`.split(/\r?\n/).find(Boolean)?.slice(0, 160);
  return { available: probe.status === 0, version: output, error: probe.error?.message };
}

async function sftpProbe(manager: SSHConnectionManager, name?: string) {
  return manager.withSftp(name, async () => 'SFTP channel opened');
}

function safeError(error: unknown, config: SSHConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  const secrets: string[] = [];
  const collect = (item: SSHConfig) => {
    for (const value of [item.password, item.passphrase, item.privateKey, item.proxy, item.socksProxy]) if (value) secrets.push(value);
    for (const hop of item.jumpHosts || []) collect(hop);
  };
  collect(config);
  for (const value of secrets.sort((a,b) => b.length-a.length)) message = message.split(value).join('[redacted]');
  return message.replace(/(\w+:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@').slice(0, 1000);
}

export function registerMaintenanceTools(server: McpServer): void {
  const manager = SSHConnectionManager.getInstance();
  const sessions = new DurableSessions(manager);

  server.registerTool("ssh_server_diagnose", {
    description: "Diagnose one SSH connection without exposing credentials: backend, local dependencies, known_hosts, connection and SFTP probes.",
    inputSchema: { connectionName },
  }, async ({ connectionName }) => {
    const started = Date.now();
    try {
      const config = manager.getConfig(connectionName);
      const resolvedName = connectionName || manager.getDefaultConnectionName();
      const backend = config.backend === "openssh" ? "openssh" : "ssh2";
      const checks: Record<string, unknown> = {
        local: {
          backend,
          hostKeyVerification: backend === 'openssh' ? 'native-ssh-policy' : config.knownHostsFile ? 'known-hosts' : 'not-configured',
          ssh: backend === "openssh" ? localBinary("ssh") : undefined,
          rsync: localBinary("rsync"),
          knownHostsFile: config.knownHostsFile ? { path: config.knownHostsFile, exists: fs.existsSync(config.knownHostsFile) } : undefined,
          nativeConfigFile: config.nativeConfigFile ? { path: config.nativeConfigFile, exists: fs.existsSync(config.nativeConfigFile) } : undefined,
        },
        target: { host: config.host, port: config.port, username: config.username },
      };
      const connectStarted = Date.now();
      try {
        await manager.connect(connectionName);
        checks.connection = { ok: true, elapsedMs: Date.now() - connectStarted };
      } catch (error) {
        checks.connection = { ok: false, elapsedMs: Date.now() - connectStarted, error: safeError(error, config) };
        checks.sftp = { ok: false, skipped: true, reason: "connection failed" };
        return result({ connectionName: resolvedName, ok: false, elapsedMs: Date.now() - started, checks });
      }
      try {
        const probe = await sftpProbe(manager, connectionName);
        checks.sftp = { ok: true, probe };
      } catch (error) {
        checks.sftp = { ok: false, error: safeError(error, config) };
      }
      const ok = (checks.connection as { ok: boolean }).ok && (checks.sftp as { ok: boolean }).ok;
      return result({ connectionName: resolvedName, ok, elapsedMs: Date.now() - started, checks });
    } catch (error) { return failure(error); }
  });

  server.registerTool("ssh_config_reload", {
    description: "Reload the original startup configuration (OpenSSH or JSON), retaining CLI overrides and restrictions. Unchanged ssh2 connections stay open; changed/removed connections and native OpenSSH connections close. Detached terminals retain their original configuration; stop them before changing that configuration. No new connections are opened.",
    inputSchema: {},
  }, async () => {
    try {
      return result({ changes: manager.reloadFromSource() });
    } catch {
      // Parser errors can quote JSON source and therefore authentication data.
      return failure(new Error('Configuration reload failed; current configuration retained. Check the startup source syntax and wait for pending connections to finish.'));
    }
  });

  server.registerTool("ssh_session_log_cleanup", {
    description: "Preview or remove logs and metadata for stopped durable sessions whose workers have exited. Dry-run is enabled by default. maxTotalBytes caps retained eligible logs; active workers and unknown state are skipped.",
    inputSchema: {
      maxAgeDays: z.number().min(0).max(36500).default(30),
      maxTotalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      dryRun: z.boolean().default(true),
    },
  }, async ({ maxAgeDays, maxTotalBytes, dryRun }) => {
    try { return result(await sessions.cleanup({ maxAgeDays, maxTotalBytes, dryRun })); }
    catch (error) { return failure(error); }
  });
}
