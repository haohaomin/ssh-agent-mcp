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

旧文本必须唯一匹配。写入临时文件后使用 SFTP POSIX rename 原子替换；服务器不支持扩展时保留原文件并返回错误。保留普通权限位，不保留所有者、ACL 和扩展属性；并发内容变化会拒绝编辑，但不提供跨进程事务锁。

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
