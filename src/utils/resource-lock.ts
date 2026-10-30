import {createHash} from 'node:crypto';
import {shellQuote} from './shell.js';
import {ToolError} from './tool-error.js';
/** Cooperative, account-scoped remote lock, shared across connections and MCP processes. */
export function withResourceLock(command:string,key?:string):string {
  if(key===undefined)return command;
  if(!/^[A-Za-z0-9_.:-]{1,100}$/.test(key))throw new ToolError('COMMAND_VALIDATION_FAILED','resourceKey must be 1–100 ASCII letters, digits, _, ., :, or -');
  const hash=createHash('sha256').update(key).digest('hex');
  return `(command -v flock >/dev/null 2>&1 || { printf '%s\\n' 'resourceKey requires remote flock' >&2; exit 127; }; (umask 077; mkdir -p "$HOME/.ssh-mcp-locks") || exit 1; flock -n -E 75 "$HOME/.ssh-mcp-locks/${hash}" sh -c ${shellQuote(command)} ssh-mcp-lock "$@")`;
}
