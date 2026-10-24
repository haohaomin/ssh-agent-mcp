# MCP 工具参考

由 `npm run docs:tools` 从实际工具定义生成。共 26 个工具。参数统一使用 camelCase，时间单位为毫秒，偏移明确区分字节和字符。

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
      "description": "Configured connection name; defaults to the first configured connection",
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
      "description": "Configured connection name; defaults to the first configured connection",
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

Execute command on connected server and get output result. A non-zero exit code is returned as the command's output followed by '[exit code] N' (not as a tool error).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
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
      "type": "string",
      "minLength": 1,
      "description": "Command to execute"
    },
    "cwd": {
      "description": "Working directory for command execution",
      "type": "string"
    },
    "connectionName": {
      "description": "Configured connection name; defaults to the first configured connection",
      "type": "string",
      "minLength": 1
    },
    "timeoutMs": {
      "description": "Command execution timeout in milliseconds (optional; overrides the connection's commandTimeoutMs or shellCommandTimeoutMs, which defaults to 30000ms)",
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "command"
  ]
}
```

## ssh_file_edit

Replace unique exact text matches. Atomic replacement requires OpenSSH SFTP rename extension. Rejects ambiguous matches.

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
    "connectionName": {
      "description": "Configured connection name; defaults to the first configured connection",
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
      "description": "Configured connection name; defaults to the first configured connection",
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
      "description": "Configured connection name; defaults to the first configured connection",
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
      "description": "Configured connection name; defaults to the first configured connection",
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

## ssh_file_write

Write UTF-8 text using mode=create (exclusive, default), overwrite, or append. Parent directory must exist.

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
      "description": "Configured connection name; defaults to the first configured connection",
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
      "description": "Configured connection name; defaults to the first configured connection",
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
      "description": "Configured connection name; defaults to the first configured connection",
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
      "description": "Configured connection name; defaults to the first configured connection",
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
      "description": "Configured connection name; defaults to the first configured connection",
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
      "type": "string",
      "description": "Command to run in the background"
    },
    "cwd": {
      "description": "Working directory for the command",
      "type": "string"
    },
    "connectionName": {
      "description": "Configured connection name; defaults to the first configured connection",
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "command"
  ]
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
      "description": "Configured connection name; defaults to the first configured connection",
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "jobId"
  ]
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
      "description": "Configured connection name; defaults to the first configured connection",
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
      "description": "Configured connection name; defaults to the first configured connection",
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
      "description": "Configured connection name; defaults to the first configured connection",
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
      "description": "Configured connection name; defaults to the first configured connection",
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
