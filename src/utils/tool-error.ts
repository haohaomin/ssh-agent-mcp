export type ToolErrorCode =
  | "RESOURCE_BUSY"
  | "CONNECTION_REQUIRED"
  | "CONNECTION_NOT_FOUND"
  | "EXECUTION_POLICY_DENIED"
  | "COMMAND_VALIDATION_FAILED"
  | "COMMAND_EXECUTION_ERROR"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "COMMAND_TIMEOUT"
  | "SSH_CONNECTION_FAILED"
  | "SSH_CONNECTION_TIMEOUT"
  | "SSH_AUTHENTICATION_MISSING"
  | "LOCAL_PATH_NOT_ALLOWED"
  | "REMOTE_PATH_NOT_ALLOWED"
  | "LOCAL_FILE_READ_FAILED"
  | "LOCAL_FILE_WRITE_FAILED"
  | "OPERATION_TIMEOUT"
  | "SFTP_ERROR"
  | "UNSUPPORTED_IN_SHELL_MODE"
  | "UNKNOWN_ERROR";

export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    public readonly retriable: boolean = false,
    /**
     * True when the remote command really ran and ended with a non-zero exit
     * status or a signal. The message is then the command's own output, not a
     * failure of this tool.
     */
    public readonly commandRan: boolean = false,
    /** Trusted transport status kept outside any output truncation budget. */
    public readonly resultSuffix: string = "",
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export function toToolError(
  error: unknown,
  fallbackCode: ToolErrorCode,
): ToolError {
  if (error instanceof ToolError) {
    return error;
  }

  if (error instanceof Error) {
    return new ToolError(fallbackCode, error.message, false);
  }

  if (error && typeof error === "object") {
    // Error-like objects from transports are often not instances of Error.
    // Select diagnostic fields rather than serializing requests or credentials.
    const value = error as Record<string, unknown>;
    const parts = [value.message, value.code, value.level, value.syscall]
      .filter((item): item is string => typeof item === 'string' && item.length > 0);
    return new ToolError(fallbackCode, parts.join(' | ') || 'Unknown error object (no diagnostic fields)', false);
  }
  return new ToolError(fallbackCode, String(error), false);
}
