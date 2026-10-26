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
