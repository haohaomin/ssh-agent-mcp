import { z } from 'zod';
export { withEnvironment } from '../utils/shell.js';
export const connectionName = z.string().min(1).optional().describe('Configured connection name. Required when multiple connections exist; may be omitted only for a single connection');
export const remotePath = z.string().min(1).describe('Absolute remote path');
export const environment = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().refine(value => !value.includes('\0'), 'NUL is not allowed')).optional();
