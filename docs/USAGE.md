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
