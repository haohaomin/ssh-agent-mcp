# 连接与配置

同一个 MCP 项目中，ssh2 和本机 OpenSSH 提供两种连接方式，使用同一套工具。后端由导入结果选择，不需要在每次工具调用中指定。

## 本机 SSH 配置

```sshconfig
Host dev
    HostName server.example.com
    User developer
    Port 22
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 30
```

```bash
node build/index.js --import-ssh-config --host dev
```

默认读取 `~/.ssh/config` 与 `/etc/ssh/ssh_config`。使用 `--ssh-config-file` 指定文件时，遵循 `ssh -F` 语义。导入器支持 `Host` 别名、通配/排除规则、首次匹配优先，以及嵌套 `Include`。用户配置的相对 Include 基于 `~/.ssh`，系统配置基于 `/etc/ssh`。

通配模式不会直接枚举成服务器，需要通过 `--host` 提供具体主机名。

## 哪些配置走 ssh2

| 配置项 | 用途 |
|---|---|
| `HostName` / `User` / `Port` | 地址、用户名和端口 |
| `IdentityFile` | 单个显式私钥路径 |
| `IdentityAgent` / `IdentitiesOnly` | Agent 与身份选择 |
| `ProxyJump` | 单级或多级跳板，支持 `user@host:port` |
| `ServerAliveInterval` / `ServerAliveCountMax` | 保活间隔与次数 |
| `UserKnownHostsFile` / `HostKeyAlias` | 主机公钥校验 |

支持常用路径变量 `%d`、`%h`、`%r`、`%u` 和 `~`。ssh2 导入连接使用普通或散列 known_hosts 条目，并拒绝匹配的已撤销密钥。

## 哪些配置走本机 OpenSSH

以下情况自动使用本机 `ssh`：

- `CertificateFile`、`ProxyCommand`、`Match`。
- 多个显式 `IdentityFile` 或多个 known_hosts 文件。
- known_hosts 中出现 CA 或通配条目。
- `LocalCommand`、`RemoteCommand` 或配置中的预设端口转发。
- 其他尚未映射的配置项；例如普通的 `Compression yes` 也会触发兼容后端。

当前实现保守处理：遇到 `Match` 会将受本次解析影响的主机交给 OpenSSH，不尝试自己执行条件判断。兼容后端保存主机别名与原配置路径，因此导出的 JSON 并不包含全部原生配置，移动机器时需迁移原文件。

导入过程不执行命令。实际连接时，OpenSSH 才会根据配置执行 `Match exec`、`ProxyCommand` 等本地命令。未知主机的确认与校验遵循原生 SSH 配置；ssh2 导入连接不会自动接受未知主机密钥。

## 显式 JSON 配置

在本机创建 `servers.json`：

```json
{
  "dev": {
    "host": "server.example.com",
    "port": 22,
    "username": "developer",
    "privateKey": "/home/developer/.ssh/id_ed25519",
    "knownHostsFile": "/home/developer/.ssh/known_hosts",
    "allowedLocalPaths": ["/home/developer/work"],
    "allowedRemotePaths": ["/home/developer/app"]
  }
}
```

```bash
node build/index.js --config-file servers.json
```

也可将 `--config-file` 与 `--import-ssh-config` 一起使用，同名 JSON 连接覆盖导入结果。建议显式配置提供 `knownHostsFile`；不配置时，显式 ssh2 连接沿用原 TypeScript 项目未强制校验主机密钥的行为。

`allowedLocalPaths` 与 `allowedRemotePaths` 控制文件访问范围。配置远端限制时，SFTP 文件读写和传输会检查符号链接解析后的实际路径；新目标校验其父目录，无法安全解析的悬空链接会被拒绝。命令规则使用 `commandWhitelist` / `commandBlacklist`。任意交互 shell 与 rsync 不能在配置了命令过滤的连接上使用；文件操作可使用 SFTP。SSH 账户本身的系统权限仍由远端控制。

`ssh_exec` 在配置任意命令过滤规则时禁止非空 `env`、非空 `envFromRemoteFiles` 和 `sudo: true`，避免环境变量或提权改变允许命令的执行含义；白名单连接还禁止 `script` / `steps`。`envFromRemoteFiles` 只支持绝对 POSIX 路径，配置远端路径范围时用 SFTP 元数据检查实际路径，文件值仍仅在远端读取。脚本、步骤和远端文件注入需要 `transportMode: "exec"`。

## 认证与环境变量

| 变量 | 作用 |
|---|---|
| `SSH_AUTH_SOCK` | SSH Agent socket，桌面客户端需继承 |
| `SSH_MCP_PASSPHRASE` | 加密私钥口令 |
| `SSH_MCP_HTTP_TOKEN` | HTTP Bearer token |
| `SSH_AGENT_STATE_DIR` | 持久终端的本地状态与日志目录 |
| `SSH_MCP_SSH_BIN` | 指定 OpenSSH 可执行文件 |
| `SSH_MCP_RSYNC_BIN` | 指定 rsync 可执行文件 |

密码可放在本地 JSON 的 `password` 字段；私钥口令也可使用 `passphrase`。导出命令不导出口令或私钥内容。OpenSSH 使用 askpass 子进程环境传递口令，不写入脚本。

CLI 认证覆盖作用于目标连接；ssh2 跳板机认证需在 `jumpHosts` 中配置。不要把真实连接配置、口令、私钥或终端日志提交到公开仓库。

## 查看全部启动参数

```bash
node build/index.js --help
```

连接、认证和平台问题见 [排错指南](TROUBLESHOOTING.md)。

## 固定动作模式

默认连接仍允许账户权限范围内的任意执行。需要限制 AI 可调用的操作时，在管理员维护的 JSON 连接配置中加入 `executionPolicy`：

```json
{
  "production-checks": {
    "host": "example.com",
    "port": 22,
    "username": "monitor",
    "privateKey": "/Users/user/.ssh/monitor_ed25519",
    "knownHostsFile": "/Users/user/.ssh/known_hosts",
    "executionPolicy": {
      "mode": "actions-only",
      "actions": {
        "identity": {
          "description": "查看服务账户身份",
          "executable": "/usr/bin/id",
          "args": ["-u"],
          "cwd": "/"
        }
      }
    }
  }
}
```

`executable` 和可选 `cwd` 必须为绝对 POSIX 路径；`args` 为固定字面量数组，没有模板展开和调用方参数。`cwd` 默认 `/`。策略及动作的未知字段、非法模式、NUL 等配置错误会拒绝加载；重载失败保留原配置。不可与 shell 传输、`commandTemplate` 或正则命令过滤混用。空动作表表示禁止所有执行。

该连接仅允许 `ssh_exec(action=...)` 执行管理员指定的程序。任意命令、脚本、steps、后台任务、SFTP 文件读写/传输、SFTP/rsync 同步、交互及持久终端、正反向端口转发均被服务层拒绝，因此 MCP 和网页入口适用相同限制。自动系统状态采集也停用；连接列表返回可调用动作的名称和说明，不公开动作源码。SSH 握手诊断和断开连接仍可用，诊断中的 SFTP 检查会报告策略拒绝。

这是 **此 MCP 实例对该连接开放能力的限制**，不是操作系统沙箱，也不撤销 SSH 凭据本身的能力。专用低权限账户、远端文件权限、必要时服务端强制命令/隔离环境才是系统权限边界。不要把通用 shell、解释器、可执行子命令的工具，或调用方可修改的脚本/配置列为安全动作；固定参数仍可能触发程序自身的危险功能。动作输出仅在配置了下述已知敏感值规则时按规则脱敏，未知值不会自动隐藏。使用同一账户的其他无限制连接、其他 MCP 实例或直接 SSH 不受该策略约束。

策略重载会关闭变更连接及其普通转发。执行请求在异步准备完成和共享 shell 队列出队时重新核对连接配置；配置已变化则拒绝下发，返回 `EXECUTION_POLICY_DENIED`，相同配置的重载可继续。此检查不会追溯撤销已运行的命令或后台进程。切换到受限模式前，应先结束旧持久终端和后台任务；旧 detached worker 不因 MCP 重载而自动消失。配置文件、SSH 配置和凭据应由管理员控制，不能暴露给调用方可写的路径。

## 多连接的目标选择

MCP 中带 `connectionName` 的工具，仅在恰好一个连接时自动选择。多个连接省略名称会返回 `CONNECTION_REQUIRED`，拼错名称返回 `CONNECTION_NOT_FOUND`，并列出可选连接；不尝试下一个可达主机。网页的单连接操作 POST 接口遵循同样规则。以 sessionName/forwardId 标识已有资源的操作仍使用资源所属连接，列表和配置重载等全局操作不要求主机名。网页初始选择和内部连接管理保留默认连接概念，不等于外部命令可以省略目标。

## 已知敏感值的输出脱敏

在管理员维护的服务器 JSON 配置中声明本机秘密来源。默认不启用，不要求把秘密值放入 MCP 参数：

```json
{
  "production": {
    "host": "server.example.com",
    "username": "ops",
    "redactLocalFiles": ["/absolute/private/api-token.txt"],
    "redactEnv": ["ADMIN_API_TOKEN"]
  }
}
```

- `redactLocalFiles`：绝对本机路径，每个文件一个完整 UTF-8 值，去掉末尾 CR/LF；只接受不超过 64 KiB 的普通文件。建议文件权限为 `0600`。
- `redactEnv`：MCP 服务进程的环境变量名称。每种来源最多 64 项；文件不存在、环境变量为空、非法类型或总值预算超过 1 MiB，配置加载失败，热加载保留原配置。
- 已声明值及其 JSON 转义表示替换为 `[REDACTED]`，同一服务汇总各连接的规则。作用于工具/网页响应、活动记录、exec 返回预算及完整日志、终端缓冲及新写入的终端日志。终端跨数据块的未完成匹配会暂缓输出，关闭时隐藏剩余前缀。
- 文件字节分页和后台任务日志分页会额外读取秘密长度范围内的上下文，先识别跨页值，再返回请求区间；游标仍是原始字节偏移。启用后任务状态读取使用无 PTY 的 exec 通道及远端 `base64`，只在服务内解码；读取失败时抑制不完整输出。任务列表/状态中的截短命令预览整体隐藏。
- 热加载会保留本进程之前的已知值，避免正在执行的操作因轮换泄露旧值；重启服务才能移除这些匹配规则。持久终端 worker 在创建时获得规则快照，规则或值变化后需停止并重新创建相关终端。已有历史文件不会自动批量改写。

这不是通用秘密识别或沙箱：未知值、调用者刻意编码/拆分/变换的值不保证匹配；`envFromRemoteFiles` 仍只在远端读取，并不会自动注册本机脱敏值。远端业务文件、后台任务原始日志、SFTP/rsync 传输内容及远端备份保持原始内容。使用短小或普通文本作为脱敏值可能遮住正常内容，建议声明完整、独特的 Token。

文件编辑器会将含已声明值的文件标记为只读，整文件替换入口拒绝写回，防止把脱敏占位符保存为真实配置。需要保留这些值并修改其他字段时，可以使用 `ssh_file_edit` 精确替换非敏感片段；文件差异也会在截断前脱敏。
