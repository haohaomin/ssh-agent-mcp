import { randomUUID } from 'node:crypto';
import { shellQuote } from './shell.js';

/** Each step runs in the same shell; never put eval in an if/|| condition,
 * which would disable errexit inside compound commands and functions. */
export function buildStepsScript(steps: string[], stopOnError: boolean, eventToken?: string): string {
  const status = `__mcp_step_${randomUUID().replaceAll('-', '')}`;
  const lines = [`${status}=0`, stopOnError ? 'set -e' : 'set +e'];
  steps.forEach((step, index) => {
    const label = `${index + 1}/${steps.length}`;
    const event = (kind: string, value?: string) => eventToken
      ? `printf '\\036${eventToken}:${index + 1}:${kind}${value ? ':%s' : ''}\\037'${value ? ` "${value}"` : ''} >&2`
      : ':';
    const report = `${status}_current=$?; ${event('exit', `$${status}_current`)}; printf '\\n[step ${label} exit code] %s\\n' "$${status}_current"`;
    lines.push(
      event('start'),
      `printf '\\n[step ${label}]\\n'`,
      // Also report a step that calls exit, or fails under set -e.
      `trap ${shellQuote(report)} EXIT`,
      `eval ${shellQuote(step)}`,
      `${status}_current=$?`,
      `trap - EXIT`,
      event('exit', `$${status}_current`),
      `printf '\\n[step ${label} exit code] %s\\n' "$${status}_current"`,
      `if [ "$${status}" -eq 0 ]; then ${status}=$${status}_current; fi`,
    );
  });
  lines.push(`exit "$${status}"`);
  return lines.join('\n') + '\n';
}

/** Read values only on the remote host. Command substitution strips trailing
 * newlines, like KEY=$(cat file). Never interpolate a value into shell code. */
export function withRemoteEnvironment(command: string, files?: Record<string, string>): string {
  if (!files || !Object.keys(files).length) return command;
  const lines = ['set +x'];
  for (const [key, file] of Object.entries(files)) {
    lines.push(
      `${key}=$(cat -- ${shellQuote(file)} 2>/dev/null) || { printf '%s\\n' ${shellQuote(`[env file error] Unable to read ${key}`)} >&2; exit 1; }`,
      `export ${key}`,
    );
  }
  return lines.join('\n') + '\n' + command;
}
