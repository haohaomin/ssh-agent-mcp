import { z } from 'zod';
import type { SSHConfig } from '../models/types.js';
import { ToolError } from './tool-error.js';
import { shellQuote } from './shell.js';

const literal = z.string().refine(value => !value.includes('\0'), 'NUL is not allowed');
const absolute = literal.refine(value => value.startsWith('/'), 'Absolute POSIX path required');
export const executionPolicySchema = z.object({
  mode: z.literal('actions-only'),
  actions: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), z.object({
    description: literal.optional(),
    executable: absolute,
    args: z.array(literal).optional(),
    cwd: absolute.optional(),
  }).strict()),
}).strict();
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;

export function validateExecutionPolicy(config: SSHConfig): void {
  if (config.executionPolicy === undefined) return;
  executionPolicySchema.parse(config.executionPolicy);
  if (config.transportMode === 'shell' || config.commandTemplate || config.commandWhitelist?.length || config.commandBlacklist?.length) {
    throw new Error('actions-only requires exec transport without commandTemplate or regex command filters');
  }
}
export function assertUnrestricted(config: SSHConfig, operation: string): void {
  if (config.executionPolicy !== undefined) {
    throw new ToolError('EXECUTION_POLICY_DENIED', `${operation} is disabled by actions-only policy. Use ssh_exec with an administrator-defined action.`);
  }
}
export function actionCommand(config: SSHConfig, action: string): string {
  validateExecutionPolicy(config);
  const actions = config.executionPolicy?.actions;
  if (!actions || !Object.hasOwn(actions, action)) {
    throw new ToolError('EXECUTION_POLICY_DENIED', `Unknown or unavailable action: ${action}`);
  }
  const entry = actions[action];
  // All executable arguments are administrator-owned literals. Caller-controlled
  // shell, environment, cwd and stdin are deliberately unavailable in this mode.
  return `cd -- ${shellQuote(entry.cwd || '/')} && exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C ${[entry.executable, ...(entry.args || [])].map(shellQuote).join(' ')}`;
}
