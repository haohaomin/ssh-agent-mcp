/** Quote `value` as a single POSIX shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function withEnvironment(command: string, env?: Record<string, string>): string {
  if (!env || !Object.keys(env).length) return command;
  return Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0')) throw new Error('Invalid environment variable');
    return `export ${key}=${shellQuote(value)}`;
  }).join('; ') + '; ' + command;
}
