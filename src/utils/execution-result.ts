import { z } from 'zod';

export const executionResultShape = {
  connectionName: z.string().nullable(),
  failureStage: z.enum(['validation', 'preparation', 'connection', 'channel_open', 'execution']).nullable(),
  transportDiagnostics: z.array(z.object({source:z.literal('openssh'),kind:z.literal('shared_connection_closed'),message:z.string()})),
  output: z.string(),
  started: z.boolean(),
  completed: z.boolean(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  captureLimitExceeded: z.boolean(),
  fullOutputPath: z.string().nullable(),
  outputStorageError: z.string().nullable(),
  steps: z.array(z.object({
    index: z.number().int(),
    status: z.enum(['not_started', 'running', 'succeeded', 'failed', 'skipped', 'unknown']),
    exitCode: z.number().int().nullable(),
  })),
  error: z.object({ code: z.string(), message: z.string(), retriable: z.boolean() }).nullable(),
};
export type ExecutionResult = z.infer<z.ZodObject<typeof executionResultShape>>;
export function newExecutionResult(stepCount = 0): ExecutionResult {
  return { transportDiagnostics: [], connectionName: null, failureStage: null, output: '', started: false, completed: false, exitCode: null, signal: null,
    timedOut: false, truncated: false, captureLimitExceeded: false,
    fullOutputPath: null, outputStorageError: null, error: null,
    steps: Array.from({ length: stepCount }, (_, i) => ({ index: i + 1, status: 'not_started', exitCode: null })),
  };
}

/** Parse only invocation-specific wrapper events, never human-readable output.
 * Buffer at most one short frame, including when a peer sends an unterminated frame. */
export class StepEventDecoder {
  private pending = Buffer.alloc(0);
  private readonly prefix: Buffer;
  constructor(token: string, private readonly result: ExecutionResult) {
    this.prefix = Buffer.from(`\x1e${token}:`);
  }
  write(chunk: Buffer): Buffer {
    let data = Buffer.concat([this.pending, chunk]);
    const visible: Buffer[] = [];
    this.pending = Buffer.alloc(0);
    while (data.length) {
      const start = data.indexOf(this.prefix);
      if (start < 0) {
        let keep = Math.min(data.length, this.prefix.length - 1);
        while (keep && !data.subarray(data.length - keep).equals(this.prefix.subarray(0, keep))) keep--;
        visible.push(data.subarray(0, data.length - keep));
        this.pending = data.subarray(data.length - keep);
        break;
      }
      visible.push(data.subarray(0, start));
      data = data.subarray(start);
      const end = data.indexOf(0x1f, this.prefix.length);
      if (end < 0 && data.length <= this.prefix.length + 64) { this.pending = data; break; }
      const match = end >= 0 && end <= this.prefix.length + 64
        ? /^(\d+):(start|exit)(?::(\d+))?$/.exec(data.subarray(this.prefix.length, end).toString()) : null;
      const step = match ? this.result.steps[Number(match[1]) - 1] : undefined;
      if (!match || !step) { visible.push(data.subarray(0, 1)); data = data.subarray(1); continue; }
      if (match[2] === 'start' && step.status === 'not_started') step.status = 'running';
      if (match[2] === 'exit' && match[3] !== undefined && step.status === 'running') {
        step.exitCode = Number(match[3]); step.status = step.exitCode === 0 ? 'succeeded' : 'failed';
      }
      data = data.subarray(end + 1);
    }
    return Buffer.concat(visible);
  }
  end(): Buffer { const tail = this.pending; this.pending = Buffer.alloc(0); return tail; }
}
