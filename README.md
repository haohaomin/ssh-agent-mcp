# ssh-agent-mcp

**让 AI 复用你的 SSH 配置，完成远程开发与运维。**

一个 TypeScript MCP 服务，提供 **29 个工具**：命令执行、文件传输与编辑、搜索、目录同步、持久终端、后台任务、双向端口转发、连接诊断、配置热加载和日志清理。常规连接使用 ssh2；OpenSSH 特有配置自动交给本机 `ssh`，使用同一套工具和参数。

[文档网站](https://haohaomin.github.io/ssh-agent-mcp/) · [工具参考](docs/TOOLS.md) · [配置说明](docs/CONFIGURATION.md) · [使用示例](docs/USAGE.md) · [测试报告](docs/TEST_REPORT.md)

## 能做什么

| 场景 | 能力 |
|---|---|
| 复用本机连接 | 导入 `~/.ssh/config`，支持别名、Include、跳板机；兼容证书、ProxyCommand 和 Match |
| 操作远程文件 | 上传/下载文件与目录，按行/字节读取，创建/覆盖/追加，精确编辑与目录浏览 |
| 定位代码和日志 | 正则、上下文、计数、文件列表、glob 和排除规则 |
| 同步项目 | rsync 块级差分、压缩、预览和删除；可选 SFTP 同步 |
| 保留工作现场 | 终端跨 MCP 重启复用、完整落盘日志、可选 tmux 观察窗口 |
| 管理长任务 | 后台运行、查看状态与输出、停止任务 |
| 访问远端服务 | 本地与反向 TCP 转发，可指定绑定地址 |

## 快速开始

### 1. 准备环境

推荐 macOS / Linux，Node.js **22 或更新版本**。

| 组件 | 何时需要 |
|---|---|
| 远端 SSH / SFTP | 建立连接 / 使用文件工具 |
| 本机 `ssh` | 使用 OpenSSH 兼容后端 |
| 本机和远端 `rsync` | 默认 rsync 同步；`engine: "sftp"` 无需 rsync |
| 本机 `tmux` | 可选，仅用于观察终端输出 |
| 远端 POSIX shell | 环境变量、交互终端和后台任务 |

macOS 可选安装：

```bash
brew install tmux rsync
```

持久终端和 rsync 桥接使用 Unix socket。Windows 尚未实测。

### 2. 安装项目

```bash
git clone https://github.com/haohaomin/ssh-agent-mcp.git
cd ssh-agent-mcp
npm ci
npm run build
```

本项目当前按源码安装；不要假设同名 npm 包就是此仓库的版本。

### 3. 接入 MCP 客户端

在支持 MCP stdio 的客户端中加入配置，将路径替换为项目的**绝对路径**：

```json
{
  "mcpServers": {
    "ssh-agent": {
      "command": "node",
      "args": [
        "/absolute/path/ssh-agent-mcp/build/index.js",
        "--import-ssh-config",
        "--host", "dev,production"
      ]
    }
  }
}
```

`--host` 可省略，以导入所有明确命名的主机。只有 `Host *.example.com` 这样的通配规则时，需用 `--host` 指定实际主机名。桌面客户端找不到 Node 时，把 `command` 改成 `node` 可执行文件的绝对路径。

使用 SSH Agent 时，MCP 进程需要继承 `SSH_AUTH_SOCK`。导入时只读配置，收到工具调用后才连接服务器。直接在终端启动 stdio 服务后，它会等待 MCP 请求，这是正常状态。

### 4. 开始使用

客户端加载工具后，可以这样提问：

> 列出已配置的服务器，在 dev 上查看磁盘使用情况。
>
> 先预览把本地项目同步到 dev 的 /home/user/app 会改哪些文件。
>
> 在 dev 上创建一个叫 work 的持久终端，并打开 tmux 观察窗口。

这些是给 MCP 客户端的自然语言示例。实际调用仍使用下方的工具名称和 JSON 参数。

## 一键导入与配置导出

```bash
# 每次启动读取本机配置
node build/index.js --import-ssh-config

# 使用自定义 SSH 配置文件
node build/index.js --import-ssh-config --ssh-config-file /path/to/ssh-config

# 导出连接引用，再用统一 JSON 配置启动
node build/index.js import --hosts dev,production --output servers.json
node build/index.js --config-file servers.json
```

导出文件以 `0600` 权限新建，不覆盖已有文件，不复制私钥内容或导出口令。原生兼容连接仍依赖原 SSH 配置文件。`servers.json` 等本地配置已加入 Git 忽略规则。

**后端按配置选择，与调用哪一种工具无关。** `HostName`、`User`、`Port`、单个密钥、`ProxyJump` 等可映射到 ssh2；证书、`Match`、`ProxyCommand` 和其他未映射选项转交 OpenSSH。保守切换可能由普通选项触发，不一定是复杂配置。完整规则见 [配置说明](docs/CONFIGURATION.md)。

## 统一的 29 个工具

| 类别 | 工具 |
|---|---|
| 连接与命令 | `ssh_server_list`、`ssh_server_diagnose`、`ssh_config_reload`、`ssh_exec` |
| 传输 | `ssh_upload`、`ssh_download` |
| 文件操作 | `ssh_file_read`、`ssh_file_write`、`ssh_file_edit`、`ssh_directory_list` |
| 搜索 | `ssh_file_grep`、`ssh_file_glob` |
| 同步 | `ssh_sync` |
| 持久终端 | `ssh_session_start`、`ssh_session_ensure`、`ssh_session_list`、`ssh_session_read`、`ssh_session_write`、`ssh_session_log`、`ssh_session_stop` |
| 日志维护 | `ssh_session_log_cleanup` |
| 后台任务 | `ssh_job_start`、`ssh_job_status`、`ssh_job_kill`、`ssh_job_list` |
| 端口转发 | `ssh_forward_start`、`ssh_forward_reverse`、`ssh_forward_list`、`ssh_forward_stop` |

连接统一用 `connectionName`，默认第一个配置；命令使用 `command/cwd/env/timeoutMs`；路径使用 `localPath/remotePath`。终端输出按 `offsetChars` 读取，文件和落盘日志使用 `offsetBytes`。旧项目的工具名称与参数不保证直接兼容。

参数参考由实际工具 schema 自动生成：[TOOLS.md](docs/TOOLS.md)。工作流示例见 [使用示例](docs/USAGE.md)。

## 需要了解的默认行为

- **同步先预览**：`ssh_sync` 默认 `dryRun: true`；真正同步需要 `dryRun: false`。删除额外目标文件需显式设置 `deleteExtra: true`，同步没有事务回滚。
- **终端独立存活**：MCP 重启不会结束终端；使用 `ssh_session_stop` 关闭。`autoClose: true` 会在远端 shell 退出后回收 worker 和 tmux 观察窗口。机器重启或 SSH 断线不能恢复原 shell。
- **日志本地保存**：默认 `~/.local/state/ssh-agent-mcp`，文件权限 `0600`；完整终端输出可能包含敏感内容，需按需清理。可用 `SSH_AGENT_STATE_DIR` 修改位置。
- **日志清理先预览**：`ssh_session_log_cleanup` 默认 `dryRun: true`，只处理已结束的会话。检查候选项后再传 `dryRun: false` 删除日志与元数据；可用 `maxAgeDays` 和 `maxTotalBytes` 设定清理阈值。
- **配置热加载**：`ssh_config_reload` 无需参数，重读启动时的 JSON/OpenSSH 配置并保留命令行覆盖。未变化的 ssh2 连接保持开启，变化/移除的连接和原生 OpenSSH 连接断开后按需重连。修改配置前先停止对应持久终端。
- **连接诊断**：`ssh_server_diagnose` 检查 SSH 连接与 SFTP，并报告本机 ssh/rsync、known_hosts 和原生配置文件状态；不返回密码或密钥内容。
- **配置命令在连接时运行**：导入不执行 `Match exec` / `ProxyCommand`，原生连接时由 OpenSSH 执行。
- **权限遵循你的连接**：可配置命令过滤及本地/远端路径范围；交互 shell 和 rsync 要求未配置命令过滤的连接。命令过滤不等同远端系统沙箱。
- **文件编辑与搜索有边界**：原子编辑需要 SFTP POSIX rename 扩展；搜索有资源预算并报告截断。详细行为见 [使用示例](docs/USAGE.md) 和 [功能检查](docs/FEATURE_AUDIT.md)。

## HTTP 接入

默认使用 stdio；也可启用 HTTP：

```bash
SSH_MCP_HTTP_TOKEN='replace-with-your-token' \
  node build/index.js --import-ssh-config --mcp-transport http
```

默认端点 `http://127.0.0.1:3000/mcp`。客户端发送 `Authorization: Bearer <token>`。HTTP 客户端共享连接、终端与转发，面向同一可信用户，不提供多租户隔离。

## 开发与验证

```bash
npm test                 # 构建 + 全部测试
npm run docs:tools       # 更新工具参数参考
npm run docs:build       # 构建静态文档网站
npm run docs:check       # 检查网站本地链接与锚点
npm run docs:serve       # 在本机预览网站
npm pack --dry-run      # 检查分发包
```

截至 **2026-10-24**，完整功能回归 **296 项通过**。两种后端分别经真实 MCP 客户端实测全部 29 个工具；另有证书、加密密钥、主机公钥拒绝、终端恢复与 tmux 窗口测试。这是测试快照，完整范围见 [测试报告](docs/TEST_REPORT.md)。

真实网络测试需要本机 `sshd`、`ssh-keygen`、`ssh`、`rsync` 和 `tmux`，使用临时密钥与 loopback SSH 服务。测试方法见 [测试文档](test/README.md)。文档网站的 GitHub Pages 构建与发布见 [网站维护](docs/PAGES.md)。

## 项目来源

统一项目以 TypeScript `ssh-mcp-server` 为服务基础，整合 Python `ssh-mcp` 的远程开发能力。运行无需 Python，也不依赖两个原仓库的副本。

来源、修订与许可记录见 [THIRD_PARTY.md](THIRD_PARTY.md)。原始 ISC / MIT 声明保留在 `LICENSES/`。OpenSSH SFTP 适配器使用 ssh2 内部协议模块，当前固定 ssh2 `1.17.0`，升级前需要真实 SFTP 回归。
