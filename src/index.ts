#!/usr/bin/env node

import { SshMcpServer } from "./core/mcp-server.js";
import { SERVER_CONFIG } from "./config/server.js";
import { Logger } from "./utils/logger.js";

const HELP_TEXT = `Usage: ssh-agent-mcp [options] [host port username password]

Import: ssh-agent-mcp import [--file <path>] [--hosts <aliases>] [--output <new-file>]

Options:
  --import-ssh-config              Import ~/.ssh/config hosts (use --host to select aliases)
  --config-file <path>             Load SSH server configs from a JSON file
  --ssh-config-file <path>         Read host aliases from SSH config (default: ~/.ssh/config)
  --ssh <config>                   Add an SSH config as JSON or legacy key=value pairs (repeatable)
  -h, --host <hosts>               SSH host(s), comma-separated; aliases resolve from SSH config
  -p, --port <port>                SSH port for single-host mode
  -u, --username <name>            SSH username for single-host mode
  -w, --password <password>        SSH password for single-host mode
  -k, --privateKey <path>          SSH private key path for single-host mode
  -P, --passphrase <passphrase>    SSH private key passphrase
  -a, --agent <path>               SSH agent socket path or pageant on Windows
  -W, --whitelist <patterns>       Command whitelist regexes, comma-separated
  -B, --blacklist <patterns>       Command blacklist regexes, comma-separated
  --proxy <url>                    Proxy URL (SOCKS5, HTTP, or HTTPS)
  -s, --socksProxy <url>           Legacy SOCKS5 proxy URL
  --allowed-local-paths <paths>    Extra allowed local paths, comma-separated
  --allowed-remote-paths <paths>   Allowed remote paths (POSIX or Windows drive-absolute), comma-separated
  --transport-mode <mode>          SSH transport mode: exec or shell (default: exec)
  --shell-ready-timeout <ms>       Shell readiness probe timeout (default: 10000)
  --command-template <template>    Wrap commands with <command> or <quotedCommand>
  --pty <true|false>              Allocate pseudo-tty for exec mode commands (default: true)
  --try-keyboard                  Enable keyboard-interactive authentication
  --pre-connect                   Pre-connect to all SSH servers on startup
  --mcp-transport <stdio|http>    MCP client transport (default: stdio)
  --http-host <host>              Bind address for HTTP transport (default: 127.0.0.1)
  --http-port <port>              Listen port for HTTP transport (default: 3000)
  --http-path <path>              Endpoint path for HTTP transport (default: /mcp)
  --http-token <token>            Bearer token for HTTP; falls back to SSH_MCP_HTTP_TOKEN
  --version, -v                   Print package version
  --help                          Print this help message`;

function hasArg(...names: string[]): boolean {
  return process.argv.slice(2).some((arg) => names.includes(arg));
}

/**
 * Main program entry
 */
async function main(): Promise<void> {
  if (process.argv[2] === "import") {
    const { parseArgs } = await import("node:util");
    const { importOpenSsh } = await import("./utils/openssh-import.js");
    const { writeFileSync } = await import("node:fs");
    const { values } = parseArgs({ args: process.argv.slice(3), options: {
      file: { type: "string" }, hosts: { type: "string" }, output: { type: "string" }
    }});
    const result = importOpenSsh(values.file, values.hosts?.split(",").map(h => h.trim()).filter(Boolean));
    // Never export passphrases taken from the environment.
    const configs = JSON.stringify(result.configs, (key, value) => key === "passphrase" ? undefined : value, 2) + "\n";
    if (values.output) writeFileSync(values.output, configs, { mode: 0o600, flag: "wx" });
    else process.stdout.write(configs);
    for (const warning of result.warnings) console.error(`[import] ${warning}`);
    for (const [name, reason] of Object.entries(result.skipped)) console.error(`[import] Skipped ${name}: ${reason}`);
    if (Object.keys(result.skipped).length || !Object.keys(result.configs).length) process.exitCode = 1;
    return;
  }
  if (hasArg("--help")) {
    console.log(HELP_TEXT);
    return;
  }

  if (hasArg("--version", "-v")) {
    console.log(SERVER_CONFIG.version);
    return;
  }

  const sshMcpServer = new SshMcpServer();
  await sshMcpServer.run();
}

main().catch((error) => Logger.handleError(error, "【SSH MCP Server Error】", true));
