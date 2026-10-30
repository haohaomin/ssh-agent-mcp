# ssh-agent-mcp

**让 AI 复用你的 SSH 配置，完成远程开发与运维。**

一个 TypeScript MCP 服务，提供 **33 个工具**：命令与多机聚合执行、文件传输与编辑、搜索、目录同步、持久终端、后台任务、双向端口转发、连接诊断、配置热加载和日志清理。常规连接使用 ssh2；OpenSSH 特有配置自动交给本机 `ssh`，使用同一套工具和参数。

[文档网站](https://haohaomin.github.io/ssh-agent-mcp/) · [工具参考](docs/TOOLS.md) · [配置说明](docs/CONFIGURATION.md) · [使用示例](docs/USAGE.md) · [测试报告](docs/TEST_REPORT.md)

## 能做什么

| 场景 | 能力 |
|---|---|
| 复用本机连接 | 导入 `~/.ssh/config`，支持别名、Include、跳板机；兼容证书、ProxyCommand 和 Match |
| 操作远程文件 | 上传/下载文件与目录，按行/字节读取，创建/覆盖/追加，精确编辑与目录浏览 |
| 审核文件修改 | 编辑差异预览、内容哈希校验、可选私有备份 |
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

原生 OpenSSH 的交互终端使用 `node-pty`。`npm ci` 会安装本机模块并修复 macOS 辅助程序权限；没有适配的预编译模块时需要 Python 3 和 C++ 编译工具。请保留安装脚本；若曾使用 `--ignore-scripts`，先运行 `npm rebuild node-pty` 和 `npm run postinstall`。

### 2. 安装项目

```bash
git clone https://github.com/haohaomin/ssh-agent-mcp.git
cd ssh-agent-mcp
npm ci
npm run build
```

本项目当前按源码安装；不要假设同名 npm 包就是此仓库的版本。

### 3. 接入 MCP 客户端

Codex 可一键注册（保留其他 MCP 配置，并先备份配置文件）：

```bash
npm run setup:codex
npm run ui
```

重新加载客户端的 MCP 连接后即可使用。网页会自动打开并完成本机鉴权，无需复制 HTTP 地址或 Token。

其他支持 MCP stdio 的客户端可加入以下配置，将路径替换为项目的**绝对路径**，并将客户端的工作目录设为项目目录：

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

## 统一的 33 个工具

| 类别 | 工具 |
|---|---|
| 连接与命令 | `ssh_server_list`、`ssh_server_disconnect`、`ssh_server_diagnose`、`ssh_config_reload`、`ssh_exec`、`ssh_exec_many` |
| 传输 | `ssh_upload`、`ssh_download`、`ssh_file_transfer` |
| 文件操作 | `ssh_file_read`、`ssh_file_write`、`ssh_file_edit`、`ssh_directory_list` |
| 搜索 | `ssh_file_grep`、`ssh_file_glob` |
| 同步 | `ssh_sync` |
| 持久终端 | `ssh_session_start`、`ssh_session_ensure`、`ssh_session_list`、`ssh_session_read`、`ssh_session_write`、`ssh_session_log`、`ssh_session_resize`、`ssh_session_stop` |
| 日志维护 | `ssh_session_log_cleanup` |
| 后台任务 | `ssh_job_start`、`ssh_job_status`、`ssh_job_kill`、`ssh_job_list` |
| 端口转发 | `ssh_forward_start`、`ssh_forward_reverse`、`ssh_forward_list`、`ssh_forward_stop` |

连接统一用 `connectionName`，仅单连接可省略，多连接必须明确选择；`ssh_exec` 支持单条 `command`、通过 stdin 发送的多行 `script`（bash/sh/python3），或共享目录与变量的 `steps`。可选 `sudo`、`failFast`、`envFromRemoteFiles`，默认返回最多 64 KiB 正文并保留退出状态，超限输出尝试完整落盘。`ssh_exec` 与 `ssh_job_start` 可选 `resourceKey` 使用远端协作锁；`ssh_file_transfer` 支持校验前缀后的断点续传，完整 exec 日志自动按保留策略清理。返回同时包含结构化 `exitCode`、`steps`、`fullOutputPath` 等字段；管理员可启用 `actions-only` 固定动作策略。具体语义和受限连接规则见 [执行工作流](docs/USAGE.md#执行命令)。

已有本地文件直接使用 `ssh_upload(localPath, remotePath)`，无需把文件内容放进对话。终端输出按 `offsetChars` 读取，文件和落盘日志使用 `offsetBytes`。旧项目的工具名称与参数不保证直接兼容。

参数参考由实际工具 schema 自动生成：[TOOLS.md](docs/TOOLS.md)。工作流示例见 [使用示例](docs/USAGE.md)。

网页在服务器顶部点击 **断开连接**。MCP 可调用：

```json
{"name":"ssh_server_disconnect","arguments":{"connectionName":"aliyun-server"}}
```

这会关闭所选服务器的共享 SSH 连接、持久终端和端口转发，保留终端日志；其他服务器不受影响。远端后台任务继续运行，自动状态刷新暂停。再次点击服务器或执行命令、文件操作、任务查询等显式 SSH 操作会自动重连。若只想结束一个终端，使用 `ssh_session_stop`。

## 需要了解的默认行为

- **同步先预览**：`ssh_sync` 默认 `dryRun: true`；真正同步需要 `dryRun: false`。删除额外目标文件需显式设置 `deleteExtra: true`，同步没有事务回滚。
- **终端独立存活**：MCP 重启不会结束终端；使用 `ssh_session_stop` 关闭。`autoClose: true` 会在远端 shell 退出后回收 worker 和 tmux 观察窗口。机器重启或 SSH 断线不能恢复原 shell。
- **日志本地保存**：默认 `~/.local/state/ssh-agent-mcp`，文件权限 `0600`；完整终端输出可能包含敏感内容，需按需清理。可用 `SSH_AGENT_STATE_DIR` 修改位置。
- **日志清理先预览**：`ssh_session_log_cleanup` 默认 `dryRun: true`，只处理已结束的会话。检查候选项后再传 `dryRun: false` 删除日志与元数据；可用 `maxAgeDays` 和 `maxTotalBytes` 设定清理阈值。
- **配置热加载**：`ssh_config_reload` 无需参数，重读启动时的 JSON/OpenSSH 配置并保留命令行覆盖。未变化的 ssh2 连接保持开启，变化/移除的连接和原生 OpenSSH 连接断开后按需重连。修改配置前先停止对应持久终端。
- **连接诊断**：`ssh_server_diagnose` 检查 SSH 连接与 SFTP，并报告本机 ssh/rsync、known_hosts 和原生配置文件状态；不返回密码或密钥内容。
- **配置命令在连接时运行**：导入不执行 `Match exec` / `ProxyCommand`，原生连接时由 OpenSSH 执行。
- **权限遵循你的连接**：可配置命令过滤及本地/远端路径范围；交互 shell 和 rsync 要求未配置命令过滤的连接。命令过滤不等同远端系统沙箱。可选 [固定动作模式](docs/CONFIGURATION.md#固定动作模式) 只开放管理员配置的程序和固定参数，同时关闭文件、终端、任务和转发旁路；系统权限仍需由远端低权限账户控制。
- **文件编辑与搜索有边界**：原子编辑需要 SFTP POSIX rename 扩展；搜索有资源预算并报告截断。详细行为见 [使用示例](docs/USAGE.md) 和 [功能检查](docs/FEATURE_AUDIT.md)。

## HTTP 接入

默认 stdio 入口会自动发现或启动本机共享后台服务。已有 stdio 配置无需改成 HTTP；多个客户端使用相同配置、工作目录和构建版本时，共享 SSH 连接与操作记录。也可显式启用独立 HTTP 进程：

```bash
SSH_MCP_HTTP_TOKEN='replace-with-your-token' \
  node build/index.js --import-ssh-config --mcp-transport http
```

默认端点 `http://127.0.0.1:3000/mcp`。客户端发送 `Authorization: Bearer <token>`。HTTP 客户端共享连接、终端与转发，面向同一可信用户，不提供多租户隔离。

### 本机 SSH Workbench

需要人工查看终端、文件差异或连接状态时，可以同时启动本机网页工作台：

```bash
node build/index.js --ui --import-ssh-config --http-port 3000
```

命令会自动启动或复用共享后台服务，并打开已完成鉴权的网页。优先使用 3000 端口；被占用时自动选择空闲端口，以启动提示为准。工作台和 MCP 使用同一个连接管理器，支持服务器切换、持久终端观察与输入、文件浏览/编辑预览/备份恢复/文本上传，以及连接诊断。共享服务只监听 `127.0.0.1`，自动生成本机访问 Token；退出启动终端或关闭 AI 客户端不会停止后台服务。网页终端是共享会话的输出与命令输入面板，不会独占输入或暂停其他 MCP 客户端。文件编辑和上传支持最大 4 MiB 的 UTF-8 文本；后台任务和转发可查看、停止，创建仍通过 MCP 工具。服务器配置接口不直接返回私钥或密码，网页请求仍受 `--http-token` / `SSH_MCP_HTTP_TOKEN` 保护。

网页会记住当前标签页选择的服务器、目录和终端会话。终端连续追加输出并保留最近约 13 万字符；后台任务与转发列表约每 5 秒刷新，也会在操作结束后主动更新。文件管理默认进入远端 SFTP 主目录（配置了路径限制时进入首个允许目录），修改冲突时拒绝覆盖并保留草稿。后台服务更新后重新运行 `npm run ui`，即可自动带入新凭据；旧页面不会反复弹出阻塞式登录框。

#### 实时操作记录

左侧的 **操作记录** 汇总此服务收到的全部 MCP 工具调用，以及网页端手动执行的操作。可查看命令参数、实时输出、最终结果、文件编辑差异、失败原因和持续跟踪的任务状态，并按服务器、来源、状态或关键词筛选。

保持原来的 stdio MCP 配置，运行 `npm run ui` 即可。客户端和网页会自动接入同一共享服务，不需要手动更换传输方式、端口或 Token。尚未注册过此项目的 Codex 用户先运行一次 `npm run setup:codex`。显式 `--mcp-transport http` 或 `--standalone` 使用独立进程，不参与自动共享。

```bash
npm run service:status  # 查看共享服务及网页地址
npm run service:stop    # 停止此状态目录中所有共享服务
```

为保留本地文件权限边界，不同工作目录、SSH 配置来源、凭据或权限范围不会合并。更新构建后会使用新的服务实例；旧实例可通过停止命令清理。`--no-open` 可禁止自动打开浏览器。

- 普通命令执行中推送输出，结束后显示成功或失败；文件精确编辑附带统一差异。
- 后台任务与持久终端约每秒自动跟踪，不需要 AI 主动查询。终端输出属于共享会话，不代表某条输入的独占结果。
- 暂停显示不停止记录；网络断开后自动重连，刷新或重启服务后可恢复历史。
- 最近 200 条记录保存在本机状态目录的 `activity-<配置标识>.json`，文件权限为 `0600`。单个文本字段约保留 24,000 字符，长输出标记截断；这是操作观察记录，不是不可篡改的合规审计日志。
- 已配置凭据和常见敏感字段会尽力脱敏，记录仍可能含命令输出和文件内容，应按敏感本机数据管理。


## 开发与验证

```bash
npm test                 # 构建 + 全部测试
npm run docs:tools       # 更新工具参数参考
npm run docs:build       # 构建静态文档网站
npm run docs:check       # 检查网站本地链接与锚点
npm run docs:serve       # 在本机预览网站
npm pack --dry-run      # 检查分发包
```

截至 **2026-10-30**，完整功能回归 **486 项通过**。两种后端分别经真实 MCP 客户端实测全部 33 个工具；另有证书、加密密钥、主机公钥拒绝、终端恢复与 tmux 窗口测试。这是测试快照，完整范围见 [测试报告](docs/TEST_REPORT.md)。

真实网络测试需要本机 `sshd`、`ssh-keygen`、`ssh`、`rsync` 和 `tmux`，使用临时密钥与 loopback SSH 服务。测试方法见 [测试文档](test/README.md)。文档网站的 GitHub Pages 构建与发布见 [网站维护](docs/PAGES.md)。

## 项目来源

统一项目以 TypeScript `ssh-mcp-server` 为服务基础，整合 Python `ssh-mcp` 的远程开发能力。运行无需 Python，也不依赖两个原仓库的副本。

来源、修订与许可记录见 [THIRD_PARTY.md](THIRD_PARTY.md)。原始 ISC / MIT 声明保留在 `LICENSES/`。OpenSSH SFTP 适配器使用 ssh2 内部协议模块，当前固定 ssh2 `1.17.0`，升级前需要真实 SFTP 回归。
