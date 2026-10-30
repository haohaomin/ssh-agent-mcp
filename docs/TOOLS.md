# MCP 工具参考

由 `npm run docs:tools` 从实际工具定义生成。共 33 个工具。参数统一使用 camelCase，时间单位为毫秒，偏移明确区分字节和字符。

## ssh_config_reload

Reload the original startup configuration (OpenSSH or JSON), retaining CLI overrides and restrictions. Unchanged ssh2 connections stay open; changed/removed connections and native OpenSSH connections close. Detached terminals retain their original configuration; stop them before changing that configuration. No new connections are opened.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

## ssh_directory_list

List a remote directory via SFTP without downloading file contents. Does not traverse subdirectories.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "remotePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute remote path"
    },
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    },
    "includeHidden": {
      "default": false,
      "type": "boolean"
    },
    "maxResults": {
      "default": 200,
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 2000
    }
  },
  "required": [
    "remotePath"
  ]
}
```

## ssh_download

Download a file, or a whole remote directory (recursively; symlinks skipped, max 2000 files), from connected server

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "remotePath": {
      "type": "string",
      "description": "Remote path (POSIX absolute like /home/user/file.txt, or Windows drive-absolute like C:/Users/file.txt)"
    },
    "localPath": {
      "type": "string",
      "description": "Local path"
    },
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "remotePath",
    "localPath"
  ]
}
```

## ssh_exec

Execute a command, a multiline script via stdin, or ordered steps on a connected server. Supports noninteractive sudo, remote-file environment injection and bounded head/tail output. Use ssh_upload for existing local files. Returns structuredContent with exitCode, signal, timedOut, steps and output log metadata, plus legacy text. On actions-only connections use action (fixed administrator-defined executable and arguments); other execution/file/session/forwarding channels are disabled. Unrestricted execution has the SSH account's privileges; regex filters and path checks are not a sandbox. A non-zero exit code is returned as the command's output followed by '[exit code] N' (not as a tool error).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "resourceKey": {
      "description": "Cooperative remote account lock; requires flock. Same key serializes participating exec/jobs across MCP processes. Nonblocking conflict exits 75. Unavailable with actions-only or command filters.",
      "type": "string",
      "pattern": "^[A-Za-z0-9_.:-]{1,100}$"
    },
    "action": {
      "description": "Administrator-defined action name on an actions-only connection. Mutually exclusive with command/script/steps and execution overrides. See ssh_server_list for available actions.",
      "type": "string",
      "minLength": 1
    },
    "env": {
      "type": "object",
      "propertyNames": {
        "type": "string",
        "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"
      },
      "additionalProperties": {
        "type": "string"
      }
    },
    "envFromRemoteFiles": {
      "description": "Environment variable to absolute remote text-file path. Values are read only remotely; trailing newlines are removed. Requires exec transport. Do not print secrets or enable shell tracing.",
      "type": "object",
      "propertyNames": {
        "type": "string",
        "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"
      },
      "additionalProperties": {
        "type": "string",
        "format": "starts_with",
        "pattern": "^\\/.*"
      }
    },
    "command": {
      "description": "Command to execute. Provide exactly one of command, script or steps.",
      "type": "string",
      "minLength": 1
    },
    "script": {
      "description": "Script sent verbatim to bash, sh or python3 stdin. Requires exec transport. For shell scripts use failFast; Python exits on uncaught exceptions automatically.",
      "type": "string",
      "minLength": 1
    },
    "steps": {
      "description": "Ordered shell steps sharing cwd and variables. Each step reports its number and exit code. Requires exec transport.",
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "stopOnError": {
      "description": "Stop steps on the first error (default: true). If false, continue and return the first failed step's status. Explicit exit/exec can end the shell.",
      "type": "boolean"
    },
    "failFast": {
      "description": "Shell script only: enable errexit, plus pipefail for bash (default: false). Omit for python3; normal shell errexit exceptions apply.",
      "type": "boolean"
    },
    "interpreter": {
      "description": "Script interpreter (default: bash). python3 runs unbuffered from stdin and must be installed remotely. steps supports only bash/sh.",
      "type": "string",
      "enum": [
        "bash",
        "sh",
        "python3"
      ]
    },
    "sudo": {
      "description": "Run through sudo -n -- sh -c. Requires passwordless permission to run the wrapper shell. env/sudo/remote-file injection are unavailable on connections with command filters.",
      "type": "boolean"
    },
    "maxBytes": {
      "default": 65536,
      "description": "Output payload budget in bytes (default: 65536); status and truncation notices are outside this budget. Keeps a UTF-8-safe head/tail and attempts to save full captured output locally. The connection's maxOutputBytes is a separate hard capture limit.",
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "cwd": {
      "description": "Working directory for command execution",
      "type": "string"
    },
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    },
    "timeoutMs": {
      "description": "Command execution timeout in milliseconds (optional; overrides the connection's commandTimeoutMs or shellCommandTimeoutMs, which defaults to 30000ms)",
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    }
  }
}
```

结构化返回（structuredContent）：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "connectionName": {
      "type": [
        "string",
        "null"
      ]
    },
    "failureStage": {
      "anyOf": [
        {
          "type": "string",
          "enum": [
            "validation",
            "preparation",
            "connection",
            "channel_open",
            "execution"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "transportDiagnostics": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "source": {
            "type": "string",
            "const": "openssh"
          },
          "kind": {
            "type": "string",
            "const": "shared_connection_closed"
          },
          "message": {
            "type": "string"
          }
        },
        "required": [
          "source",
          "kind",
          "message"
        ],
        "additionalProperties": false
      }
    },
    "output": {
      "type": "string"
    },
    "started": {
      "type": "boolean"
    },
    "completed": {
      "type": "boolean"
    },
    "exitCode": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "signal": {
      "type": [
        "string",
        "null"
      ]
    },
    "timedOut": {
      "type": "boolean"
    },
    "truncated": {
      "type": "boolean"
    },
    "captureLimitExceeded": {
      "type": "boolean"
    },
    "fullOutputPath": {
      "type": [
        "string",
        "null"
      ]
    },
    "outputStorageError": {
      "type": [
        "string",
        "null"
      ]
    },
    "steps": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "index": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "status": {
            "type": "string",
            "enum": [
              "not_started",
              "running",
              "succeeded",
              "failed",
              "skipped",
              "unknown"
            ]
          },
          "exitCode": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "index",
          "status",
          "exitCode"
        ],
        "additionalProperties": false
      }
    },
    "error": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "code": {
              "type": "string"
            },
            "message": {
              "type": "string"
            },
            "retriable": {
              "type": "boolean"
            }
          },
          "required": [
            "code",
            "message",
            "retriable"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "connectionName",
    "failureStage",
    "transportDiagnostics",
    "output",
    "started",
    "completed",
    "exitCode",
    "signal",
    "timedOut",
    "truncated",
    "captureLimitExceeded",
    "fullOutputPath",
    "outputStorageError",
    "steps",
    "error"
  ],
  "additionalProperties": false
}
```

## ssh_exec_many

Run the same command/script/steps/action on 1–16 explicitly named connections with bounded concurrency. Returns ordered per-host structured results, separate exit codes and full log paths. No fallback target and no automatic retries or rollback. Use concurrency=1 for serial runs; all targets are attempted. Text is a compact summary; full output is in structuredContent.results.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "resourceKey": {
      "description": "Cooperative remote account lock; requires flock. Same key serializes participating exec/jobs across MCP processes. Nonblocking conflict exits 75. Unavailable with actions-only or command filters.",
      "type": "string",
      "pattern": "^[A-Za-z0-9_.:-]{1,100}$"
    },
    "action": {
      "description": "Administrator-defined action name on an actions-only connection. Mutually exclusive with command/script/steps and execution overrides. See ssh_server_list for available actions.",
      "type": "string",
      "minLength": 1
    },
    "env": {
      "type": "object",
      "propertyNames": {
        "type": "string",
        "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"
      },
      "additionalProperties": {
        "type": "string"
      }
    },
    "envFromRemoteFiles": {
      "description": "Environment variable to absolute remote text-file path. Values are read only remotely; trailing newlines are removed. Requires exec transport. Do not print secrets or enable shell tracing.",
      "type": "object",
      "propertyNames": {
        "type": "string",
        "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"
      },
      "additionalProperties": {
        "type": "string",
        "format": "starts_with",
        "pattern": "^\\/.*"
      }
    },
    "command": {
      "description": "Command to execute. Provide exactly one of command, script or steps.",
      "type": "string",
      "minLength": 1
    },
    "script": {
      "description": "Script sent verbatim to bash, sh or python3 stdin. Requires exec transport. For shell scripts use failFast; Python exits on uncaught exceptions automatically.",
      "type": "string",
      "minLength": 1
    },
    "steps": {
      "description": "Ordered shell steps sharing cwd and variables. Each step reports its number and exit code. Requires exec transport.",
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "stopOnError": {
      "description": "Stop steps on the first error (default: true). If false, continue and return the first failed step's status. Explicit exit/exec can end the shell.",
      "type": "boolean"
    },
    "failFast": {
      "description": "Shell script only: enable errexit, plus pipefail for bash (default: false). Omit for python3; normal shell errexit exceptions apply.",
      "type": "boolean"
    },
    "interpreter": {
      "description": "Script interpreter (default: bash). python3 runs unbuffered from stdin and must be installed remotely. steps supports only bash/sh.",
      "type": "string",
      "enum": [
        "bash",
        "sh",
        "python3"
      ]
    },
    "sudo": {
      "description": "Run through sudo -n -- sh -c. Requires passwordless permission to run the wrapper shell. env/sudo/remote-file injection are unavailable on connections with command filters.",
      "type": "boolean"
    },
    "maxBytes": {
      "default": 65536,
      "description": "Output payload budget in bytes (default: 65536); status and truncation notices are outside this budget. Keeps a UTF-8-safe head/tail and attempts to save full captured output locally. The connection's maxOutputBytes is a separate hard capture limit.",
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "cwd": {
      "description": "Working directory for command execution",
      "type": "string"
    },
    "timeoutMs": {
      "description": "Command execution timeout in milliseconds (optional; overrides the connection's commandTimeoutMs or shellCommandTimeoutMs, which defaults to 30000ms)",
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "targets": {
      "minItems": 1,
      "maxItems": 16,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "concurrency": {
      "default": 4,
      "description": "Maximum active targets; use 1 for serial execution. Every target runs even if another fails.",
      "type": "integer",
      "minimum": 1,
      "maximum": 8
    },
    "maxTotalBytes": {
      "default": 65536,
      "description": "Aggregate output payload budget, divided equally between targets. Per-target maxBytes also applies. Metadata and notices are additional.",
      "type": "integer",
      "minimum": 16,
      "maximum": 1048576
    }
  },
  "required": [
    "targets"
  ]
}
```

结构化返回（structuredContent）：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "connectionName": {
            "type": [
              "string",
              "null"
            ]
          },
          "failureStage": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "validation",
                  "preparation",
                  "connection",
                  "channel_open",
                  "execution"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "transportDiagnostics": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "source": {
                  "type": "string",
                  "const": "openssh"
                },
                "kind": {
                  "type": "string",
                  "const": "shared_connection_closed"
                },
                "message": {
                  "type": "string"
                }
              },
              "required": [
                "source",
                "kind",
                "message"
              ],
              "additionalProperties": false
            }
          },
          "output": {
            "type": "string"
          },
          "started": {
            "type": "boolean"
          },
          "completed": {
            "type": "boolean"
          },
          "exitCode": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "signal": {
            "type": [
              "string",
              "null"
            ]
          },
          "timedOut": {
            "type": "boolean"
          },
          "truncated": {
            "type": "boolean"
          },
          "captureLimitExceeded": {
            "type": "boolean"
          },
          "fullOutputPath": {
            "type": [
              "string",
              "null"
            ]
          },
          "outputStorageError": {
            "type": [
              "string",
              "null"
            ]
          },
          "steps": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "index": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "status": {
                  "type": "string",
                  "enum": [
                    "not_started",
                    "running",
                    "succeeded",
                    "failed",
                    "skipped",
                    "unknown"
                  ]
                },
                "exitCode": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "index",
                "status",
                "exitCode"
              ],
              "additionalProperties": false
            }
          },
          "error": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "code": {
                    "type": "string"
                  },
                  "message": {
                    "type": "string"
                  },
                  "retriable": {
                    "type": "boolean"
                  }
                },
                "required": [
                  "code",
                  "message",
                  "retriable"
                ],
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "connectionName",
          "failureStage",
          "transportDiagnostics",
          "output",
          "started",
          "completed",
          "exitCode",
          "signal",
          "timedOut",
          "truncated",
          "captureLimitExceeded",
          "fullOutputPath",
          "outputStorageError",
          "steps",
          "error"
        ],
        "additionalProperties": false
      }
    },
    "succeeded": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "failed": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "results",
    "succeeded",
    "failed"
  ],
  "additionalProperties": false
}
```

## ssh_file_edit

Preview or apply unique exact text replacements. dryRun returns a bounded unified diff and beforeSha256; expectedSha256 rejects stale previews. backup creates an exclusive private sibling copy before atomic replacement. writeMode=inPlace preserves the existing inode for single-file bind mounts, requires expectedSha256 and always saves a backup; writes are non-atomic and interrupted writes may be partial. Stop competing writers first. Default is atomic.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "remotePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute remote path"
    },
    "edits": {
      "minItems": 1,
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "oldText": {
            "type": "string",
            "minLength": 1
          },
          "newText": {
            "type": "string"
          }
        },
        "required": [
          "oldText",
          "newText"
        ]
      }
    },
    "writeMode": {
      "default": "atomic",
      "type": "string",
      "enum": [
        "atomic",
        "inPlace"
      ]
    },
    "dryRun": {
      "default": false,
      "type": "boolean"
    },
    "backup": {
      "default": false,
      "type": "boolean"
    },
    "expectedSha256": {
      "type": "string",
      "pattern": "^[a-fA-F0-9]{64}$"
    },
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "remotePath",
    "edits"
  ]
}
```

## ssh_file_glob

Find paths with glob stars, globstars, character classes and brace alternatives.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "remotePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute remote path"
    },
    "pattern": {
      "type": "string",
      "minLength": 1,
      "maxLength": 1000
    },
    "maxResults": {
      "default": 100,
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 1000
    },
    "exclude": {
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1000
      }
    },
    "includeHidden": {
      "default": false,
      "type": "boolean"
    },
    "ignoreCase": {
      "default": false,
      "type": "boolean"
    },
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "remotePath",
    "pattern"
  ]
}
```

## ssh_file_grep

Search UTF-8 files using literal text or bounded JavaScript regular expressions, context lines, file lists and counts.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "remotePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute remote path"
    },
    "pattern": {
      "type": "string",
      "minLength": 1,
      "maxLength": 1000
    },
    "maxResults": {
      "default": 100,
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 1000
    },
    "exclude": {
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1000
      }
    },
    "includeHidden": {
      "default": false,
      "type": "boolean"
    },
    "ignoreCase": {
      "default": false,
      "type": "boolean"
    },
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    },
    "regex": {
      "default": false,
      "type": "boolean"
    },
    "outputMode": {
      "default": "content",
      "type": "string",
      "enum": [
        "content",
        "files",
        "count"
      ]
    },
    "contextBefore": {
      "default": 0,
      "type": "integer",
      "minimum": 0,
      "maximum": 100
    },
    "contextAfter": {
      "default": 0,
      "type": "integer",
      "minimum": 0,
      "maximum": 100
    },
    "filePattern": {
      "type": "string",
      "maxLength": 1000
    },
    "maxFileBytes": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 67108864
    }
  },
  "required": [
    "remotePath",
    "pattern"
  ]
}
```

## ssh_file_read

Read UTF-8 text over SFTP. Select bytes for byte pagination, or lines for numbered lines (up to 4 MiB).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "remotePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute remote path"
    },
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    },
    "format": {
      "default": "bytes",
      "type": "string",
      "enum": [
        "bytes",
        "lines"
      ]
    },
    "offsetBytes": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "maxBytes": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 4194304
    },
    "startLine": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "lineCount": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 2000
    }
  },
  "required": [
    "remotePath"
  ]
}
```

## ssh_file_transfer

Copy one regular file between two SSH connections through a bounded, backpressured SFTP relay. No local file or file-content tool output. resumable retains partials; retry with transferId verifies the full prefix before appending. Only one writer may own a transferId. Verify destination SHA-256 before atomic publication. Default refuses overwrite; requires OpenSSH hardlink extension (or posix-rename with overwrite=true). A client timeout does not prove publication failed: inspect the destination before retrying.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sourceConnectionName": {
      "type": "string",
      "minLength": 1
    },
    "sourcePath": {
      "type": "string",
      "minLength": 1
    },
    "destinationConnectionName": {
      "type": "string",
      "minLength": 1
    },
    "destinationPath": {
      "type": "string",
      "minLength": 1
    },
    "resumable": {
      "default": false,
      "description": "Retain partial temporary file on failure for verified retry",
      "type": "boolean"
    },
    "transferId": {
      "description": "Retry an interrupted transfer with the same endpoints/paths; verifies the complete existing prefix before append. Requires exclusive ownership of the partial file.",
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    },
    "overwrite": {
      "default": false,
      "type": "boolean"
    },
    "maxBytes": {
      "default": 268435456,
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 1073741824
    },
    "timeoutMs": {
      "default": 60000,
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 240000
    }
  },
  "required": [
    "sourceConnectionName",
    "sourcePath",
    "destinationConnectionName",
    "destinationPath"
  ]
}
```

## ssh_file_write

Write UTF-8 text using mode=create (exclusive, default), overwrite, or append. Parent directory must exist. For an existing local file, use ssh_upload(localPath, remotePath) without reading its contents into the conversation.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "remotePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute remote path"
    },
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    },
    "content": {
      "type": "string",
      "maxLength": 4194304
    },
    "mode": {
      "default": "create",
      "type": "string",
      "enum": [
        "create",
        "overwrite",
        "append"
      ]
    },
    "permissions": {
      "type": "integer",
      "minimum": 0,
      "maximum": 511
    }
  },
  "required": [
    "remotePath",
    "content"
  ]
}
```

## ssh_forward_list

List active port forwards.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

## ssh_forward_reverse

Forward a TCP port on the SSH server (loopback by default) to a local destination. remotePort=0 chooses a free port.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "bindHost": {
      "default": "127.0.0.1",
      "type": "string",
      "minLength": 1
    },
    "localHost": {
      "default": "127.0.0.1",
      "type": "string"
    },
    "localPort": {
      "type": "integer",
      "minimum": 1,
      "maximum": 65535
    },
    "remotePort": {
      "default": 0,
      "type": "integer",
      "minimum": 0,
      "maximum": 65535
    },
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "localPort"
  ]
}
```

## ssh_forward_start

Forward a local TCP port (loopback by default) to a destination reachable from the SSH server. localPort=0 chooses a free port.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "bindHost": {
      "default": "127.0.0.1",
      "type": "string",
      "minLength": 1
    },
    "remoteHost": {
      "type": "string",
      "minLength": 1
    },
    "remotePort": {
      "type": "integer",
      "minimum": 1,
      "maximum": 65535
    },
    "localPort": {
      "default": 0,
      "type": "integer",
      "minimum": 0,
      "maximum": 65535
    },
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "remoteHost",
    "remotePort"
  ]
}
```

## ssh_forward_stop

Stop a port forward and its active sockets.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "forwardId": {
      "type": "string"
    }
  },
  "required": [
    "forwardId"
  ]
}
```

## ssh_job_kill

Stop a running background job (SIGTERM, then SIGKILL after 5s), including its child processes.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jobId": {
      "type": "string",
      "description": "Job id returned by ssh_job_start"
    },
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "jobId"
  ]
}
```

## ssh_job_list

List recent background jobs on the server with their state. Finished jobs are pruned after 7 days.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "limit": {
      "description": "Max jobs to list (default 20)",
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 100
    },
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    }
  }
}
```

## ssh_job_start

Start a long-running command in the background on the server and return a job id immediately. Use ssh_job_status to read its output and exit code, ssh_job_kill to stop it. Prefer this over ssh_exec for builds, deploys or anything that may exceed the command timeout.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "resourceKey": {
      "description": "Remote flock key shared with ssh_exec; contention produces job exit 75, not a retry. Requires flock.",
      "type": "string",
      "pattern": "^[A-Za-z0-9_.:-]{1,100}$"
    },
    "env": {
      "type": "object",
      "propertyNames": {
        "type": "string",
        "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"
      },
      "additionalProperties": {
        "type": "string"
      }
    },
    "command": {
      "description": "Command to run in the background; choose command or script",
      "type": "string",
      "minLength": 1
    },
    "script": {
      "description": "Multiline source saved verbatim in a private remote job file; never executed through a caller-built quoting layer",
      "type": "string",
      "minLength": 1
    },
    "interpreter": {
      "type": "string",
      "enum": [
        "bash",
        "sh",
        "python3"
      ]
    },
    "failFast": {
      "description": "Shell scripts only; enable errexit and bash pipefail",
      "type": "boolean"
    },
    "cwd": {
      "description": "Working directory for the command",
      "type": "string"
    },
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    }
  }
}
```

结构化返回（structuredContent）：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "connectionName": {
      "type": "string"
    },
    "jobId": {
      "type": "string"
    },
    "state": {
      "type": "string"
    },
    "exitCode": {
      "type": [
        "number",
        "null"
      ]
    },
    "pid": {
      "type": [
        "number",
        "null"
      ]
    },
    "elapsedSeconds": {
      "type": [
        "number",
        "null"
      ]
    },
    "offsetBytes": {
      "type": [
        "number",
        "null"
      ]
    },
    "nextOffsetBytes": {
      "type": [
        "number",
        "null"
      ]
    },
    "totalBytes": {
      "type": [
        "number",
        "null"
      ]
    },
    "output": {
      "type": "string"
    },
    "message": {
      "type": "string"
    },
    "remoteLogPath": {
      "type": "string"
    },
    "remoteLogPathBase": {
      "type": "string"
    },
    "nextAction": {
      "type": "string"
    },
    "error": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retriable": {
          "type": "boolean"
        }
      },
      "required": [
        "code",
        "message",
        "retriable"
      ],
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

## ssh_job_status

Show state (running/exited/killed/lost), exit code, elapsed time and output of a background job. Without offset it returns the last part of the output; with offset it returns output from that byte, and the reply names the next offset so repeated polling only reads what is new.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jobId": {
      "type": "string",
      "description": "Job id returned by ssh_job_start"
    },
    "offsetBytes": {
      "description": "Byte offset to read output from (optional)",
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "tailBytes": {
      "description": "Without offset: how many trailing bytes of output to show (default 8192)",
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "maxBytes": {
      "description": "Max bytes of output to return in one call (default 65536)",
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "jobId"
  ]
}
```

结构化返回（structuredContent）：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "connectionName": {
      "type": "string"
    },
    "jobId": {
      "type": "string"
    },
    "state": {
      "type": "string"
    },
    "exitCode": {
      "type": [
        "number",
        "null"
      ]
    },
    "pid": {
      "type": [
        "number",
        "null"
      ]
    },
    "elapsedSeconds": {
      "type": [
        "number",
        "null"
      ]
    },
    "offsetBytes": {
      "type": [
        "number",
        "null"
      ]
    },
    "nextOffsetBytes": {
      "type": [
        "number",
        "null"
      ]
    },
    "totalBytes": {
      "type": [
        "number",
        "null"
      ]
    },
    "output": {
      "type": "string"
    },
    "message": {
      "type": "string"
    },
    "remoteLogPath": {
      "type": "string"
    },
    "remoteLogPathBase": {
      "type": "string"
    },
    "nextAction": {
      "type": "string"
    },
    "error": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retriable": {
          "type": "boolean"
        }
      },
      "required": [
        "code",
        "message",
        "retriable"
      ],
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

## ssh_server_diagnose

Diagnose one SSH connection without exposing credentials: backend, local dependencies, known_hosts, connection and SFTP probes.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    }
  }
}
```

## ssh_server_disconnect

Disconnect one server (default if omitted), closing its SSH connection, durable terminals and port forwards. Remote background jobs continue. Automatic job polling pauses until an explicit SSH operation reconnects. Other servers are unaffected.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    }
  }
}
```

## ssh_server_list

List all available SSH server configurations

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

## ssh_session_ensure

Open a persistent interactive SSH terminal, retained by a detached worker across MCP restarts; stop explicitly to end it. Requires unrestricted command access.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sessionName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    },
    "shell": {
      "type": "string",
      "minLength": 1
    },
    "observerMode": {
      "default": "transcript",
      "type": "string",
      "enum": [
        "transcript",
        "tmux"
      ]
    },
    "autoClose": {
      "default": false,
      "type": "boolean"
    },
    "cols": {
      "default": 120,
      "type": "integer",
      "minimum": 1,
      "maximum": 1000
    },
    "rows": {
      "default": 30,
      "type": "integer",
      "minimum": 1,
      "maximum": 1000
    },
    "cwd": {
      "type": "string",
      "minLength": 1
    },
    "env": {
      "type": "object",
      "propertyNames": {
        "type": "string",
        "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"
      },
      "additionalProperties": {
        "type": "string"
      }
    }
  },
  "required": [
    "sessionName"
  ]
}
```

## ssh_session_list

List persistent terminals and output cursors.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

## ssh_session_log

Read the complete persisted terminal transcript using byte offsets, including after stop.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sessionName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "offsetBytes": {
      "default": 0,
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "maxBytes": {
      "default": 65536,
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 1048576
    }
  },
  "required": [
    "sessionName"
  ]
}
```

## ssh_session_log_cleanup

Preview/remove logs: scope=sessions handles stopped durable sessions whose workers exited; scope=exec handles UUID exec-output logs. Automatic exec retention runs after log writes (7 days/512 MiB, protecting the newest output). Dry-run is enabled by default. maxTotalBytes caps retained eligible logs; active workers and unknown state are skipped.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "scope": {
      "default": "sessions",
      "description": "sessions preserves existing cleanup; exec previews/deletes UUID exec-output logs",
      "type": "string",
      "enum": [
        "sessions",
        "exec"
      ]
    },
    "maxAgeDays": {
      "default": 30,
      "type": "number",
      "minimum": 0,
      "maximum": 36500
    },
    "maxTotalBytes": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "dryRun": {
      "default": true,
      "type": "boolean"
    }
  }
}
```

## ssh_session_read

Read terminal output since a character offset. Reports truncation when the bounded transcript has rolled over.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sessionName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "offsetChars": {
      "default": 0,
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "maxChars": {
      "default": 65536,
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 65536
    }
  },
  "required": [
    "sessionName"
  ]
}
```

## ssh_session_resize

Resize a running remote terminal on either backend. The worker must have been started with a version supporting resize. Dimensions on ensure only apply when creating a new terminal.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sessionName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "cols": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000
    },
    "rows": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000
    }
  },
  "required": [
    "sessionName",
    "cols",
    "rows"
  ]
}
```

## ssh_session_start

Open a persistent interactive SSH terminal, retained by a detached worker across MCP restarts; stop explicitly to end it. Requires unrestricted command access.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sessionName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    },
    "shell": {
      "type": "string",
      "minLength": 1
    },
    "observerMode": {
      "default": "transcript",
      "type": "string",
      "enum": [
        "transcript",
        "tmux"
      ]
    },
    "autoClose": {
      "default": false,
      "type": "boolean"
    },
    "cols": {
      "default": 120,
      "type": "integer",
      "minimum": 1,
      "maximum": 1000
    },
    "rows": {
      "default": 30,
      "type": "integer",
      "minimum": 1,
      "maximum": 1000
    },
    "cwd": {
      "type": "string",
      "minLength": 1
    },
    "env": {
      "type": "object",
      "propertyNames": {
        "type": "string",
        "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"
      },
      "additionalProperties": {
        "type": "string"
      }
    }
  },
  "required": [
    "sessionName"
  ]
}
```

## ssh_session_stop

Stop a persistent terminal worker; retain its transcript for later reading.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sessionName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    }
  },
  "required": [
    "sessionName"
  ]
}
```

## ssh_session_write

Write input to a persistent terminal. Include a newline to submit a command; use \u0003 for Ctrl-C.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sessionName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "input": {
      "type": "string",
      "maxLength": 65536
    }
  },
  "required": [
    "sessionName",
    "input"
  ]
}
```

## ssh_sync

Synchronize using SFTP or rsync. Rsync supports block-level delta transfer, deletion, compression and metadata. Preview by default; rsync is required locally and remotely for the rsync engine.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "engine": {
      "default": "rsync",
      "type": "string",
      "enum": [
        "sftp",
        "rsync"
      ]
    },
    "deleteExtra": {
      "default": false,
      "type": "boolean"
    },
    "compress": {
      "default": true,
      "type": "boolean"
    },
    "preservePermissions": {
      "default": true,
      "type": "boolean"
    },
    "timeoutMs": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "extraArgs": {
      "description": "Allowed rsync options: --checksum, --size-only, --ignore-existing, --existing, --update, --prune-empty-dirs, --numeric-ids, --times, --perms, --links, --hard-links, --verbose, --progress, --bwlimit=N",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "localPath": {
      "type": "string",
      "minLength": 1
    },
    "remotePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute remote path"
    },
    "direction": {
      "type": "string",
      "enum": [
        "upload",
        "download"
      ]
    },
    "dryRun": {
      "default": true,
      "type": "boolean"
    },
    "exclude": {
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1000
      }
    },
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "localPath",
    "remotePath",
    "direction"
  ]
}
```

## ssh_upload

Upload a file, or a whole directory (recursively; symlinks skipped, max 2000 files), to connected server

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "localPath": {
      "type": "string",
      "description": "Local path"
    },
    "remotePath": {
      "type": "string",
      "description": "Remote path (POSIX absolute like /home/user/file.txt, or Windows drive-absolute like C:/Users/file.txt)"
    },
    "connectionName": {
      "description": "Configured connection name. Required when multiple connections exist; may be omitted only for a single connection",
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "localPath",
    "remotePath"
  ]
}
```
