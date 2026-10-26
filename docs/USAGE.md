# 工具与工作流

以下代码块是 MCP 工具调用参数，不是终端命令。`connectionName` 对应导入或 JSON 中的连接名，省略时选择默认连接。全部字段及默认值见 [工具参考](TOOLS.md)。

## 执行命令

调用 `ssh_exec`：

```json
{
  "connectionName": "dev",
  "command": "printf '%s\\n' \"$APP_ENV\"; pwd",
  "cwd": "/home/user/app",
  "env": { "APP_ENV": "development" },
  "timeoutMs": 10000
}
```

命令非零退出时，结果末尾包含 `[exit code] N`；连接失败和超时作为工具错误返回。环境变量通过 POSIX shell export 设置，仍经过同一命令过滤规则。

## 文件读取与编辑

`ssh_file_read` 按行读取：

```json
{"connectionName":"dev","remotePath":"/home/user/app/config.txt","format":"lines","startLine":1,"lineCount":80}
```

`format: "bytes"` 使用 `offsetBytes/maxBytes` 分页，两套参数不能混用。`ssh_file_write` 的 `mode` 可选 `create`（默认独占创建）、`overwrite` 或 `append`。

`ssh_file_edit` 精确替换：

```json
{"connectionName":"dev","remotePath":"/home/user/app/config.txt","edits":[{"oldText":"port=3000","newText":"port=4000"}]}
```

旧文本必须唯一匹配。写入临时文件后使用 SFTP POSIX rename 原子替换；服务器不支持扩展时保留原文件并返回错误。保留普通权限位，不保留所有者、ACL 和扩展属性；同一服务内的编辑按连接与实际路径串行处理，并发内容变化会拒绝编辑；不提供跨进程事务锁。

先预览差异，再按预览版本修改并留备份：

```json
{"connectionName":"dev","remotePath":"/home/user/app/config.txt","edits":[{"oldText":"port=3000","newText":"port=4000"}],"dryRun":true}
```

预览不创建任何文件，返回 unified diff 和原始内容的 `beforeSha256`。执行时使用相同的 `edits`，把返回的哈希填入 `expectedSha256`，设置 `dryRun: false`、`backup: true`。哈希不匹配会拒绝修改。为兼容现有调用，`ssh_file_edit` 的 `dryRun` 与 `backup` 都默认关闭。

备份位于原文件旁，文件名追加 `.ssh-agent-backup-<随机标识>`，权限为 `0600`，路径通过 `backupPath` 返回。备份失败会中止替换；替换失败时可能保留备份，错误中会给出路径。备份保留原始 UTF-8 BOM 和换行字节，不自动清理；恢复时先读取并核对备份，再用文件写入工具恢复。日志清理工具不会删除这些远端备份。

预览 diff 最多返回 65,536 字符，并有计算预算。`diffTruncated: true` 表示差异被截断或因预算未生成，不应当作完整补丁；内容哈希仍针对完整文件。最终内容超过 4 MiB 会在写入前拒绝；无实际变化时不写入或备份。

## 搜索代码与日志

`ssh_file_grep` 的正则搜索：

```json
{
  "connectionName": "dev",
  "remotePath": "/home/user/app",
  "pattern": "error|warning",
  "regex": true,
  "ignoreCase": true,
  "filePattern": "*.log",
  "contextBefore": 2,
  "contextAfter": 2,
  "maxResults": 50
}
```

`outputMode` 可选 `content`、`files`、`count`。`ssh_file_glob` 支持 `**/*.{ts,js}` 等路径模式。搜索默认跳过版本控制目录，可配置 `exclude` / `includeHidden`，不跟随符号链接。

文本操作通常限制 4 MiB；搜索的 `maxFileBytes` 可调到 64 MiB。扫描数量、深度与总字节数有预算，耗尽时报告 `truncated`。单次正则匹配超过 2 秒会终止匹配线程。

## 预览与执行同步

调用 `ssh_sync` 预览：

```json
{
  "connectionName": "dev",
  "localPath": "/home/user/work/app/",
  "remotePath": "/home/user/app/",
  "direction": "upload",
  "exclude": ["node_modules", ".git"],
  "dryRun": true
}
```

检查结果后，用相同参数并改成 `dryRun: false` 执行。`direction: "download"` 反向下载。`deleteExtra: true` 会删除目标多余内容，默认关闭；源目录末尾 `/` 遵循 rsync 语义，表示同步目录中的内容。

默认 `engine: "rsync"`，两端需安装 rsync。支持块级差分、压缩、archive 元数据与部分扩展参数，所有者/组的保留受账户权限和系统支持影响。同步通过已有 SSH 连接传输。`engine: "sftp"` 可使用大小和修改时间进行文件级同步，两端根目录需存在；同时指定删除会切换到 rsync。

## 持久终端与 tmux

调用 `ssh_session_ensure` 创建或复用终端：

```json
{
  "connectionName": "dev",
  "sessionName": "work",
  "cwd": "/home/user/app",
  "observerMode": "tmux",
  "autoClose": true
}
```

返回的 `attachCommand` 可以在本机终端运行，以查看远程输出。tmux 窗口用于观察日志，向远端输入命令仍使用 `ssh_session_write`：

```json
{"sessionName":"work","input":"pwd\n"}
```

用 `ssh_session_read` 读取输出；后续将返回的 `nextOffsetChars` 作为 `offsetChars` 继续读取。内存保留约 1 Mi 字符，完整落盘日志用 `ssh_session_log` 和 `offsetBytes` 分页读取，停止后仍保留。

创建时可设置 `cols` / `rows`，默认 120×30，范围均为 1–1000。调整已有终端时调用 `ssh_session_resize`：

```json
{"sessionName":"work","cols":132,"rows":42}
```

两种后端都把尺寸变化传到远端 PTY，影响交互程序布局；可输入 `stty size` 验证。`ensure` 复用现有终端时不会改变其尺寸，需显式调用 resize。升级前启动的旧 worker 需停止并重新创建后才能支持此操作。tmux 观察窗口的本地尺寸与远端 PTY 尺寸分别管理。

## 诊断、热加载与日志清理

诊断某个连接的本机依赖、SSH 握手和 SFTP：

```json
{"connectionName":"dev"}
```

将参数传给 `ssh_server_diagnose`。结果不包含密码、私钥或完整连接配置。

重新读取启动时的配置并应用变化：

```json
{}
```

调用 `ssh_config_reload`，无需参数。它重读启动时指定的 JSON 或 OpenSSH 文件，保留命令行覆盖、主机选择和权限限制。未变化的 ssh2 连接保持可用；配置变化或被移除的连接会断开，下一次调用时再连接。原生 OpenSSH 连接每次都会断开，以重新应用文件及 Include 中的规则。配置解析失败时保留旧配置；连接正在建立时需稍后重试。

独立终端 worker 保留创建时的配置，热加载不会改变其权限或重连 shell。修改对应配置前应先停止这些终端，否则配置哈希变化后无法继续访问，需恢复匹配配置后再停止。HTTP 监听地址、令牌和传输方式仍需重启服务才能改变。

## 本机网页工作台

使用 `--ui` 自动启动或复用共享服务，并打开本机 SSH Workbench：

```bash
node build/index.js --ui --import-ssh-config --http-port 3000
```

浏览器会自动打开；默认优先使用 3000 端口，占用时自动使用空闲端口。网页端复用 MCP 的 SSH 连接、持久会话和 SFTP 服务，不会复制一套连接逻辑。它适合查看 AI 会话、向共享终端发送命令、浏览文件并在写入前确认差异。共享模式自动生成 Token，通过浏览器 URL fragment 完成首次鉴权，页面随即清除 fragment；无需手工输入。

先预览 30 天前已结束会话的日志：

```json
{"maxAgeDays":30,"dryRun":true}
```

将参数传给 `ssh_session_log_cleanup`。确认候选项后，再将 `dryRun` 设为 `false` 删除日志和元数据。`maxAgeDays: 0` 选择所有可清理记录；年龄按日志和元数据的最近修改时间计算。也可设置 `maxTotalBytes`，先扣除按年龄选中的日志，再从旧到新清理，直到剩余可清理日志满足空间上限。

只清理 worker 已退出的会话，活动 worker、正在启动的同名会话和无法确认的状态都会跳过。自然退出但保留 worker 的终端需先调用 `ssh_session_stop`。空间上限只统计可清理日志，不保证整个状态目录低于此值。预览返回 `reclaimableBytes`；实际删除返回 `freedBytes`，不对活动日志进行截断或轮转。

MCP 进程重启后可以复用同一 worker、shell 和环境。`ensure` 不重置已有环境。`ssh_session_stop` 结束终端并关闭观察窗口；`autoClose` 在 shell 退出时回收 worker 与观察窗口。缺少 tmux 时返回日志路径，终端仍可用。

## 后台任务

使用 `ssh_job_start` 执行长任务：

```json
{"connectionName":"dev","command":"npm run build","cwd":"/home/user/app"}
```

从返回值取得 `jobId`，交给 `ssh_job_status` 查询状态和输出、`ssh_job_kill` 停止、`ssh_job_list` 查看列表。任务状态保存在远端 `~/.ssh-mcp-jobs`，可跨 MCP 重启和 SSH 断线；完成标记超过 7 天的任务会按保留策略清理。

## 双向端口转发

`ssh_forward_start` 把远端 8080 映射到本机：

```json
{"connectionName":"dev","remoteHost":"127.0.0.1","remotePort":8080,"localPort":18080}
```

随后访问本机 `http://127.0.0.1:18080`。`localPort: 0` 自动分配端口，以返回值为准。

`ssh_forward_reverse` 把本机 3000 映射到远端：

```json
{"connectionName":"dev","localHost":"127.0.0.1","localPort":3000,"remotePort":13000}
```

转发默认绑定 loopback，`bindHost` 可调整。反向绑定还受 sshd 配置控制。通过 `ssh_forward_list` 查看，通过 `ssh_forward_stop` 的 `forwardId` 关闭。


工作台操作说明：

- “重新读取配置”重新加载启动时指定的 JSON/OpenSSH 配置，保留原有 CLI 覆盖与权限限制；不会导入未授权的新配置来源。
- “运行诊断”实际探测 SSH 连接与 SFTP。“重新连接”重建当前主机连接，原连接上的转发会关闭；独立持久会话不随之重建。
- 终端每秒刷新输出，“启用输入”允许网页发送命令；所有客户端共享终端，不会暂停 AI 或锁定其他客户端输入。显示名称仅保存在当前浏览器，底层会话标识不变。支持停止会话；此界面不是完整的全屏终端模拟器。
- 目录路径可直接输入；支持上级目录、刷新、子目录上传。上传只接受不超过 4 MiB 的 UTF-8 文本，拒绝覆盖已有文件。二进制传输使用 MCP 上传/下载工具。
- 编辑器完整读取最大 4 MiB 文本，预览与保存校验 SHA-256；文件已被其他客户端修改时拒绝覆盖。支持空文件编辑。保存可创建私有备份，当前页面可恢复上次备份；重新打开页面后也可从目录中读取保留的备份文件。
- 后台任务与端口转发支持查看、刷新、停止；启动任务、创建转发使用 MCP 工具。
- `--ui-path /workbench` 可修改访问前缀，不能设为 `/` 或覆盖 MCP 的 HTTP 路径。无尾斜杠的地址会自动跳转，保证相对资源加载正确。


### 实时观察 AI 的操作

1. 已有 stdio MCP 启动配置可继续使用；首次接入 Codex 时，运行 `npm run setup:codex`，然后重新加载 MCP 连接。
2. 在项目目录运行 `npm run ui`。AI 客户端与网页会自动发现/启动同一个服务；先启动哪一端都可以。
3. 在自动打开的网页进入 **操作记录**。无需修改为 HTTP 配置或复制 Token。

`npm run service:status` 查看所有共享实例，`npm run service:stop` 停止当前状态目录中的所有共享实例。关闭网页、关闭 AI 客户端或启动终端，不会停止后台服务。重启电脑后不自动开机启动；下次 AI 连接或运行 `npm run ui` 时按需启动。

发现信息保存在状态目录的 `services/` 下，权限为 `0600`，不要分享其中的 Token。服务只绑定 `127.0.0.1`；校验随机实例身份和 Token 后才能复用。多个启动进程通过锁文件协调；端口占用时改用空闲端口，陈旧锁和已退出实例会自动恢复。请求失败不重放操作，下一次请求会尝试重新接入。

共享范围包含启动配置、配置来源、默认服务器、凭据、SSH Agent、工作目录以及构建版本。工作目录也是本地文件访问权限范围，因此不同目录不会强行合并；Codex 一键接入会固定项目目录。显式 `--mcp-transport http` 或 `--standalone` 仍使用独立进程，适用于手动部署。升级后旧服务不会被强制关闭，可先 `npm run service:stop` 再启动新版本。

面板按时间显示操作。桌面端左侧选择记录，右侧查看结果，并在“执行结果 / 文件差异 / 调用参数”间切换；技术信息默认折叠。服务器列表以表格呈现，文件差异使用蓝色新增、红色删除。窄屏端上下排列，选择记录后跳到详情，可返回列表。统计项可快速筛选进行中、文件修改和需要关注的操作；支持复制内容、按 `/` 聚焦搜索。来源区分 `AI / MCP`、网页操作、状态跟踪；其中 `AI / MCP` 表示 MCP 客户端调用，并不能区分具体 AI 模型或人类调用者。支持服务器/来源/状态筛选与全文搜索。

命令输出使用经过鉴权的 SSE 实时推送，约 200 ms 合并一次更新。后台任务与终端输出约每秒检查一次；网络、远端响应和任务数量会影响延迟。文件上传、下载、同步等操作会立即显示进行中，并在完成后显示结果；不提供逐字节传输进度。自动查询终端输出、服务器列表等网页轮询不会产生重复的操作条目。

后台任务启动后，原记录会继续跟踪任务状态与末尾输出，直到退出、被停止或跟踪中断；关闭网页不影响服务端跟踪。SSH 连接不可用等情况会标记“跟踪中断”，不代表远端任务已停止。持久终端的输入单独记录，后续输出显示在共享会话记录中，不能将混合输入的输出精确归因到某条命令。

记录默认位于 `~/.local/state/ssh-agent-mcp/activity-<配置标识>.json`，可通过已有环境变量 `SSH_AGENT_STATE_DIR` 改变状态目录；按配置的主机名、地址、端口和用户名区分历史文件。每份历史最多保留 200 条，超出后淘汰较早的已完成条目；全为运行状态时淘汰最早条目及其自动跟踪。单个文本字段约 24,000 字符，后台任务/终端自动跟踪保留约 16 KiB 尾部输出。写盘最多每秒一次，正常关闭会立即保存；异常断电可能丢失最近约一秒更新。重启后尚未完成的普通调用标为中断，远端任务和会话则尝试继续跟踪。

历史采用私有文件权限，并对已配置凭据、常见密码/Token 字段做尽力脱敏，但未知敏感数据仍可能出现在命令输出中。该功能是单服务实例的操作观察记录，不是防篡改审计系统，会汇总自动接入此实例的多个 MCP 客户端，但不记录独立服务、其他 SSH 客户端或 AI 的思考过程。
