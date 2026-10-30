# 工具与工作流

以下代码块是 MCP 工具调用参数，不是终端命令。`connectionName` 对应导入或 JSON 中的连接名，仅有一个连接时可省略；多个连接时必须明确指定，否则在连接前返回 `CONNECTION_REQUIRED`。全部字段及默认值见 [工具参考](TOOLS.md)。

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

命令非零退出时，结果末尾包含 `[exit code] N`；连接失败和超时作为工具错误返回。`command`、`script`、`steps` 或受限模式的 `action` 必须且只能提供一个。环境变量通过 POSIX shell export 设置，值按字面量传递。

### 结构化执行结果

`ssh_exec` 同时返回兼容旧客户端的 `content` 文本和符合 `outputSchema` 的 `structuredContent`。程序直接读取后者，不必解析 `[exit code]` 等日志文字。

| 字段 | 含义 |
| --- | --- |
| `connectionName` | 实际选定的连接名 |
| `failureStage` | 失败阶段：validation / preparation / connection / channel_open / execution；成功为 null |
| `output` | 经过输出预算处理的文本，与旧格式一致 |
| `started` / `completed` | 执行通道已接受请求 / 已收到退出状态或 shell 完成标记；不代表业务成功 |
| `exitCode` / `signal` | SSH 通道或 shell 协议报告的状态；未知为 `null`，不会从正文推断 |
| `timedOut` | 命令或通道打开超时；不是远端所有子进程已被杀死的证明 |
| `truncated` | 返回预算截断，或达到捕获硬上限 |
| `captureLimitExceeded` | 达到连接的 `maxOutputBytes`，与返回预算截断区分 |
| `fullOutputPath` | 已保存的本机捕获日志路径；未触发保存或保存失败为 `null` |
| `outputStorageError` | 本机日志写入错误码；无错误为 `null` |
| `steps` | 每步的 `index`（从 1 开始）、`status`、`exitCode`；非 steps 调用为空数组 |
| `error` | `{code, message, retriable}`，无错误为 `null`；非零退出仍保持旧接口不设置 `isError` 的行为 |

步骤状态来自每次调用独立标识的包装脚本事件，正常状态为 `succeeded` / `failed`。shell 已结束而后续步骤未开始时为 `skipped`；尚未观察到开始为 `not_started`；执行过但没有结束事件为 `unknown`。例如超时、`exec` 替换 shell、覆盖 `EXIT` trap 或关闭 stderr 时，不能把未知状态当成成功。日志中的伪造 `[step ...]` 文字不会改变结构化状态；事件包装本身不是针对恶意脚本的可信审计边界。

OpenSSH 后端对远端信号终止可能只报告本地 ssh 进程的退出码 `255`，此时 `signal` 为 `null`；ssh2 可以直接返回 SSH 信号。连接断开或超时时也不把未知退出码填成 `0`。通道关闭但没有报告退出状态时，返回工具错误且 `completed: false`；流错误保留已捕获的输出，同样应用输出预算和落盘逻辑。`retriable` 描述错误类型，不保证重放有副作用的命令安全。

### 管理员定义的固定动作

管理员在连接配置中启用 `executionPolicy.mode: "actions-only"` 后，用 `ssh_server_list` 查看动作名称和说明，再调用：

```json
{"connectionName":"production-checks","action":"identity","maxBytes":4096,"timeoutMs":10000}
```

动作的程序、参数和目录由配置固定。调用方只可选择动作和设置输出预算、超时，不能附加 `command`、`script`、`steps`、`cwd`、`env`、`envFromRemoteFiles`、`interpreter`、`failFast`、`stopOnError` 或启用 `sudo`。动作禁用 PTY，立即关闭 stdin（发送 EOF），使用清空的环境及固定的 `PATH=/usr/bin:/bin`、`LANG=C`；远端需有 `/usr/bin/env`。配置示例和权限边界见 [配置说明](CONFIGURATION.md#固定动作模式)。

### 多行脚本与部署步骤

多行内容用 `script` 直接传给解释器 stdin，只需 JSON 本身的转义，不再把整段脚本嵌套进远端命令引号。`interpreter` 可选 `bash`（默认）、`sh` 或 `python3`；脚本不分配 PTY，避免终端回显和换行转换。

```json
{
  "connectionName": "dev",
  "script": "for port in 80 443; do\n  printf '%s\\n' \"$port\"\ndone\n",
  "interpreter": "bash",
  "failFast": true,
  "maxBytes": 8192
}
```

`failFast` 只适用于 bash/sh 的 `script`，默认关闭；开启时使用 `set -e`，bash 还开启 `pipefail`。这遵循 shell 的错误处理语义：`if` 条件、`&&`/`||` 等显式处理过的失败不一定触发退出。复杂 SQL 建议先保存成文件，通过 `ssh_upload` 上传，再交给数据库客户端执行。

批量部署可用 `steps`，默认失败即停：

```json
{
  "connectionName": "dev",
  "cwd": "/home/user/ai-gateway",
  "steps": ["docker compose pull", "docker compose up -d", "docker compose ps"],
  "sudo": true,
  "stopOnError": true,
  "timeoutMs": 120000,
  "maxBytes": 16384
}
```

步骤在同一个 shell 中运行，`cd`、变量和函数会保留。输出以 `[step 1/3]` 和 `[step 1/3 exit code] N` 标识各步。`stopOnError: false` 会继续后续步骤，但最终保留第一个失败步骤的退出码；每步状态遵循 shell 语义，通常是该步骤最后一条命令的状态。显式 `exit`/`exec` 仍可结束整个 shell；不要覆盖工具用于状态报告的 `EXIT` trap。步骤间不需要新建持久终端，跨多次调用的交互工作仍使用 `ssh_session_*`。

`sudo: true` 使用 `sudo -n -- sh -c ...`，exec 模式中工作目录和环境在提权后的 shell 内设置，不会等待密码；旧 shell 传输模式的 `cwd` 仍由共享 shell 先切换。目标账户需有运行此包装 shell 的 NOPASSWD 权限；只允许 `sudo docker` 的规则不等同于允许包装 shell。权限不足会直接返回 sudo 的错误和退出码。

### Python 脚本原样执行

`interpreter: "python3"` 使用远端的 `python3 -u -`，代码通过 stdin 原样发送，不需要 base64 编码，也不创建远端脚本文件：

```json
{
  "connectionName": "dev",
  "interpreter": "python3",
  "script": "import json\nquery = \"SELECT CASE WHEN is_stream THEN 'stream' ELSE 'non-stream' END\"\nprint(json.dumps({\"query\": query, \"message\": \"中文\"}, ensure_ascii=False))",
  "maxBytes": 8192
}
```

远端需已安装 `python3`；工具不会自动安装依赖。`-u` 让标准输出和错误及时返回，便于观察运行进度。`cwd`、`env`、`sudo`、`envFromRemoteFiles`、`timeoutMs`、`maxBytes` 均可照常使用。SQL 和 JSON 字符串只需遵循 Python 语法及 JSON 参数编码，无需额外的 shell 转义。

Python 未捕获异常会返回 traceback 和非零退出码，`sys.exit(N)` 保留退出码；不要同时传 `failFast`。`steps` 仍是 bash/sh 步骤，不能选择 Python 解释器。通过 stdin 执行时 `__file__` 为 `<stdin>`、`sys.argv[0]` 为 `-`，stdin 已用于源码；需要真实文件路径、相邻模块或额外 stdin 数据的脚本，使用 `ssh_upload` 上传后执行。

### 输出预算与完整输出

`ssh_exec.maxBytes` 默认 **65536 字节**，控制返回正文的大小，超限保留 UTF-8 完整字符边界上的头尾片段。退出码、信号、超时和截断提示不计入预算，即使预算很小也不会丢失执行状态。

完整捕获结果尝试保存到 **运行 MCP 服务的机器**上的状态目录 `exec-output/<随机标识>.log`，结构化字段 `fullOutputPath` 和文本中的 `full output: ...` 给出绝对路径；目录权限 `0700`，文件权限 `0600`。该文件不是远端文件，不使用 `ssh_file_read` 读取。落盘失败时保留正文片段和原执行状态，并显示 `full output unavailable`；不要因为保存失败重跑已经完成的部署。

`maxBytes` 与连接配置的 `maxOutputBytes` 不同：后者默认 10 MiB，是捕获的硬上限，超过后关闭通道并返回 `OUTPUT_LIMIT_EXCEEDED`。落盘文件仅包含已捕获的输出及状态，不包含硬上限或超时之后未收到的输出。写入新的完整输出日志时自动清理 exec-output：保留 7 天、总量目标 512 MiB；本次新日志受保护，即使单文件超过目标也不立即删除。手动清理用 `ssh_session_log_cleanup(scope: "exec")`，默认预览。空闲时不定期唤醒清理，不清理远端 job 日志。返回文本和完整日志均可能包含命令主动打印的数据。

### 从远端文件注入环境变量

```json
{
  "connectionName": "dev",
  "script": "curl --fail --silent --show-error -H \"Authorization: Bearer $WB_KEY\" http://127.0.0.1:7863/v1/models",
  "envFromRemoteFiles": {"WB_KEY": "/home/user/ai-gateway/wb-api-key.txt"},
  "failFast": true,
  "maxBytes": 8192
}
```

文件内容只在远端读取并导出，不经过本机 SFTP 内容读取，也不写进调用参数。读取行为与 `KEY=$(cat file)` 一致，会去掉末尾换行；适用于无 NUL 的文本值。变量不能同时出现在 `env` 和 `envFromRemoteFiles` 中。读取失败会停止执行；与 `sudo` 配合时，在提权后的 shell 内读取。使用绝对 POSIX 路径，配置 `allowedRemotePaths` 时还会通过 SFTP 元数据解析符号链接并检查范围。

工具不会自动抹除命令主动输出的秘密；脚本应避免 `echo "$WB_KEY"`、`set -x` 或会回显认证信息的调试选项。普通返回值、活动历史和完整输出文件都可能保存这些主动输出。

`script`、`steps`、`envFromRemoteFiles` 需要 `exec` 传输模式，两种后端 ssh2/OpenSSH 均支持。配置命令白名单时不支持脚本或步骤；配置任意命令白名单/黑名单时，不允许非空 `env`、非空 `envFromRemoteFiles` 或 `sudo: true`，避免通过环境或权限改变已允许命令的含义。受限连接应使用审核过的固定脚本入口。

## 长任务使用后台任务

测速、构建、迁移等预计耗时较长的操作，首次执行就用 `ssh_job_start`。支持 `command` 或原样多行 `script`，脚本支持 bash/sh/python3；不要先用同步 exec 等超时，再重跑成后台任务。

```json
{"connectionName":"dev","script":"import time\nprint('started', flush=True)\ntime.sleep(400)\nprint('finished')","interpreter":"python3"}
```

启动结果的 `structuredContent` 包含 `connectionName`、`jobId`、`state: "accepted"`、`remoteLogPath` 和下一步操作。accepted 只表示启动包装程序已报告 PID，业务成功需查状态。任务脚本与输出保存在账户 HOME 的 `.ssh-mcp-jobs/<jobId>/`，新任务目录为 0700、文件为 0600；已有任务目录不会被覆盖。`env` 通过启动环境继承，`cwd` 设置任务目录；shell 脚本可用 `failFast`，Python 不接受该参数。后台脚本暂不支持 exec 的 `sudo`、远端密钥注入和 steps 参数。

```json
{"connectionName":"dev","jobId":"job-abcdefgh-0000","offsetBytes":0,"maxBytes":65536}
```

向 `ssh_job_status` 传入真实任务 ID，读取结构化 `state`、`exitCode`、`elapsedSeconds`、`offsetBytes`、`nextOffsetBytes`、`totalBytes` 和输出；下一轮使用 `nextOffsetBytes` 增量读取。状态来自工具协议元数据，不解析任务打印的 `[state]` 文本。状态包括 running / exited / killed / lost / not_found。脚本运行和日志保存在远端，MCP 重启或连接断开不要求重跑。

启动包装调用出错时，若工具已分配 ID，会返回该 `jobId` 和 `state: "unknown"`，应先查询状态再决定后续操作。如果超时由客户端产生、根本没收到工具结果，仍需通过 `ssh_job_list` 核实，不能保证已知任务 ID。客户端请求超时与远端命令超时是不同层级，调大 `ssh_exec.timeoutMs` 不能绕过客户端上限。工具不自动重放有副作用的操作。

## 跨主机文件传输

`ssh_file_transfer` 直接连接两个 SFTP 端点，经运行 MCP 的机器流式转发，不创建本地中转文件，也不把文件内容返回模型：

```json
{
  "sourceConnectionName":"source",
  "sourcePath":"/home/user/subscription.yaml",
  "destinationConnectionName":"aliyun-server",
  "destinationPath":"/home/user/subscription.yaml",
  "overwrite":false,
  "timeoutMs":60000
}
```

仅支持单个普通文件。默认最大 256 MiB，`maxBytes` 可调至 1 GiB；目标父目录须已存在。工具以 0600 创建随机临时文件，流式计算 SHA-256，重新读取目标临时文件核验，再原子发布。默认不覆盖，使用目标端 OpenSSH hardlink 扩展；`overwrite: true` 使用 posix-rename 扩展替换。扩展缺失会失败，不降级为不安全的覆盖操作。不会保留源文件权限、属主和时间戳。

结果返回两端连接名、路径、字节数、摘要和 `published`。两端路径限制与 actions-only 策略均会检查。校验失败或发布前超时不会替换原目标；临时文件尽力清理，清理失败提示路径。网络断在发布阶段时，结果仍可能不确定，应检查目标后再重试。可选择下面的断点续传；暂不提供后台传输任务，客户端自身超时仍适用。

## 文件读取与编辑

本地已存在的 compose.yml、Caddyfile、SQL 或二进制文件直接用 `ssh_upload`，无需读取内容再塞进工具参数：

```json
{"connectionName":"dev","localPath":"/Users/user/deploy/compose.yml","remotePath":"/home/user/ai-gateway/compose.yml"}
```

`localPath` 指运行 MCP 服务的机器上的路径，受本地路径范围限制；目录也可递归上传。

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

记录默认位于 `~/.local/state/ssh-agent-mcp/activity-<配置标识>.json`，可通过已有环境变量 `SSH_AGENT_STATE_DIR` 改变状态目录；按配置的主机名、地址、端口和用户名区分历史文件。每份历史最多保留 200 条，超出后淘汰较早的已完成条目；全为运行状态时淘汰最早条目及其自动跟踪。单个文本字段约 24,000 字符，后台任务/终端自动跟踪保留约 16 KiB 尾部输出。写盘最多每秒一次，正常关闭会立即保存。写盘失败时保留内存中的待保存记录，并按同样频率自动重试；成功后网页清除存储错误提示。关闭时做最后一次保存尝试并停止重试；若磁盘仍不可写，未保存记录无法保留。异常断电可能丢失最近约一秒更新。重启后尚未完成的普通调用（包括终端读写请求）标为中断，远端任务和会话输出则尝试继续跟踪。会话输出按配置、PID 和启动时间识别实例；同名重建不会向旧记录追加新会话的输出。旧版历史缺少实例标识时停止跟踪，再次确保会话或发送输入后为当前实例建立新记录。

历史采用私有文件权限，并对已配置凭据、常见密码/Token 字段做尽力脱敏，但未知敏感数据仍可能出现在命令输出中。该功能是单服务实例的操作观察记录，不是防篡改审计系统，会汇总自动接入此实例的多个 MCP 客户端，但不记录独立服务、其他 SSH 客户端或 AI 的思考过程。

## 资源锁

`ssh_exec` 和 `ssh_job_start` 可传 `resourceKey`，例如：

```json
{"connectionName":"dev","script":"docker compose up -d","cwd":"/srv/app","resourceKey":"deploy:app"}
```

相同远端 HOME 下相同名称使用同一个文件锁，能跨 SSH 连接和 MCP 实例互斥。需要远端 `flock`；缺失时退出 127，不会执行用户命令。锁被占用时立即退出 75，不排队也不自动重试；后台任务的冲突通过 `ssh_job_status.exitCode` 查看。命令自己也可能返回 75，因此不要只凭该数字断言冲突。操作系统在持锁进程关闭描述符后释放锁；超时关闭 SSH 通道并不证明远端工作已停止，后台子进程可能继续持锁。锁文件本身可以保留，不应通过删除锁文件解锁。

这是协作锁：不带相同 resourceKey 的命令、文件工具或直接 SSH 不受约束。不同账户、HOME 覆盖及 sudo 环境可能落入不同锁目录，需统一部署约定。它不是事务、幂等或权限边界。actions-only 与正则过滤连接不接受该参数。

## 断点续传

首次传输设置 `resumable: true`。工具错误返回 `transferId` 和临时路径；先检查目标是否已发布，未发布时向同样的端点和路径再次调用 `ssh_file_transfer` 并带回该 `transferId`。续传可跨 MCP 重启，临时文件在目标服务器，不依赖本机缓存。

```json
{"sourceConnectionName":"source","sourcePath":"/srv/archive.bin","destinationConnectionName":"destination","destinationPath":"/srv/archive.bin","resumable":true,"transferId":"12345678-1234-4234-8234-123456789abc","timeoutMs":120000}
```

示例 ID 必须换成真实返回值。续传前完整读取源前缀和目标临时文件并比较 SHA-256，只追加缺失后缀，完成后仍回读整份目标并核对最终摘要。结果中的 `resumedBytes` 是复用字节数；前缀校验仍会产生读取流量。前缀不一致、临时文件为符号链接或比源文件大时拒绝，不自动覆盖。源后缀允许反映当前源内容；这不保证与第一次开始时是同一文件版本，若业务要求固定版本应使用不可变源或额外核对预期摘要。

同一服务对同一目标禁止并行传输；不同服务、别名路径或其他程序仍须保证临时文件只有一个写入者。不要并发复用传输 ID。启用 resumable 后部分文件有意保留，不受本机日志清理影响；放弃传输时按返回路径手动清理。若中断发生在临时文件创建前，ID 可能存在但文件不存在，应确认后重新开始。客户端未收到任何结果时仍可能不知道传输 ID，此功能不会自动重放操作。

## 完整执行日志清理

```json
{"scope":"exec","maxAgeDays":7,"maxTotalBytes":536870912,"dryRun":true}
```

调用 `ssh_session_log_cleanup` 查看候选路径，再用 `dryRun: false` 删除。只处理 exec-output 目录内 UUID 命名的普通日志，跳过符号链接及其他文件；不删除终端、任务、活动历史或续传文件。省略 scope 保持原来的 sessions 清理。自动清理在写入完整日志后触发，清理失败不会覆盖已经完成的命令结果；手动清理可查看错误。

## 多机聚合执行

`ssh_exec_many` 复用 `ssh_exec` 的 command/script/steps/action 参数与逐机权限校验，一次请求显式选择目标：

```json
{
  "targets": ["production-a", "production-b"],
  "script": "uname -n\nprintf '\\n'; df -h /",
  "concurrency": 2,
  "maxTotalBytes": 65536
}
```

最多 16 个不重复目标，并发默认为 4、上限 8；`concurrency: 1` 串行执行。结果按输入顺序放在 `structuredContent.results`，各自包含实际连接名、退出码、失败阶段、步骤状态和完整日志路径。`succeeded`/`failed` 为汇总计数；任一目标失败或完成状态未知，整个结果 `isError: true`，其他目标仍会执行。没有自动重试或跨机回滚，不能把它当作部署事务。

`maxTotalBytes` 默认 64 KiB、最大 1 MiB，平均分给每个目标，同时受逐机 `maxBytes` 限制；状态、诊断、截断提示不计入正文预算。各机被截断的输出分别保存为日志。普通文本只返回逐机摘要，完整结果读取结构化字段。一次 MCP 请求仍需要每台主机各自执行 SSH 操作，不能据调用数比值直接推导速度提升。

## 单文件 bind mount 的 inode 保留

默认 `ssh_file_edit` 仍使用原子替换。如果容器以单文件 bind mount 挂载配置，需要让既有 inode 的读者看到更新，可显式选择 `writeMode: "inPlace"`：

```json
{
  "connectionName": "production",
  "remotePath": "/srv/caddy/Caddyfile",
  "edits": [{"oldText": "old.example.com", "newText": "new.example.com"}],
  "writeMode": "inPlace",
  "dryRun": true
}
```

应用时传相同 edits，设置 `dryRun: false` 并带上预览返回的 `expectedSha256`。该模式始终创建 `0600` 备份，再通过现有文件描述符重写、截短和回读校验；不采用 rename，不会重新创建已消失的目标。返回 `writeMode`、`atomic`、`inodePreserved` 和备份路径。

原地写入不是原子操作：读者可能读到中间状态，断线/磁盘故障可能留下部分修改，错误会提示备份位置。先停止其他写入者并安排服务重载；哈希检查和本实例锁无法排除外部进程的并发修改。它不能修复此前 rename 已造成的旧挂载，已失联的挂载仍需重建。没有根据 mtime 自动猜测 bind mount。

## OpenSSH 诊断与脱敏

原生 OpenSSH exec 的独立 stderr 中，完整的 `Shared connection to … closed.` 行移到 `transportDiagnostics`；stdout、其他警告及错误保持原样，退出码判定不受影响。该规则只识别这一固定行型，远端程序若在同一 stderr 打印完全相同的文字也会被归类，但消息保留在结构化元数据中。交互终端的混合终端流不做此过滤。

已知秘密的配置与范围见 [输出脱敏配置](CONFIGURATION.md#已知敏感值的输出脱敏)。完整 exec 日志同样脱敏，不提供绕过接口查看原值。启用脱敏前创建的持久终端需重新创建，才能保证其后续磁盘日志也采用新规则。
