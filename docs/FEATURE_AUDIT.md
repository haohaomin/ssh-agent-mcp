# 功能检查与统一接口

检查日期：2026-10-25。判断标准是「同一能力有一套可用实现」，不复制原项目的全部参数、命令行程序或运行方式。

## 结果

两个原项目的功能入口已统一为 30 个 MCP 工具。常规连接使用 ssh2；需要证书或复杂配置时自动使用本机 OpenSSH。原项目无需启动或安装，接口不要求兼容旧名称。

本轮补齐此前缺失的高级能力：

- 正则、上下文、忽略大小写、文件列表/计数模式、完整常用 glob 语法。
- rsync 块级差分、目标删除、压缩、元数据和常用扩展参数；保留 SFTP 同步选项。
- 独立终端 worker、跨 MCP 重启复用、完整落盘日志、可选 tmux 观察。
- OpenSSH 证书、ProxyCommand、Match、系统配置及其他原生配置兼容。
- 双向转发的绑定地址配置。
- 单连接诊断，含握手、SFTP 和本机依赖探测。
- JSON/OpenSSH 配置热加载，保留启动参数和权限限制，按变化增量断开 ssh2 连接；原生连接重建以应用文件规则。
- 已结束会话日志清理，默认 dry-run，并支持总空间阈值。

命名、参数与重复功能已合并：连接使用 `connectionName`，命令使用 `command/cwd/env/timeoutMs`，路径使用 `localPath/remotePath`，标识使用 `sessionName/jobId/forwardId`。读取入口为 `ssh_file_read(format=bytes|lines)`，写入入口为 `ssh_file_write(mode=create|overwrite|append)`；字符与字节偏移明确区分。实际协议参数见 [TOOLS.md](TOOLS.md)。

## 按能力对照

| 能力 | 原项目来源 | 统一实现 | 检查依据 |
|---|---|---|---|
| MCP stdio / HTTP | 两者 / TypeScript | 官方 SDK 接入 | HTTP、生命周期测试；真实 stdio MCP 客户端发现工具与调用 |
| 多连接、连接状态 | TypeScript | `ssh_server_list` 与统一配置 | 配置、状态采集、服务器列表测试 |
| 连接诊断 | 新增 | `ssh_server_diagnose` | ssh2/OpenSSH 真实 MCP + sshd 测试；无凭据泄露单测 |
| 配置热加载 | 新增 | `ssh_config_reload` | MCP 真实 JSON 重读；OpenSSH 来源与策略保留测试；真实 ssh2 连接复用及旧 close 事件回归 |
| 密码、私钥、Agent、键盘交互、代理 | TypeScript；Python 委托 OpenSSH | 既有 ssh2 认证与代理实现 | 连接管理、交互认证、代理模拟测试；本机 SSH 密码连接实测 |
| 本机 SSH 配置复用 | 两者 | 静态导入 + 原生兼容后端 | Include、系统配置、证书、ProxyCommand/Match 延迟执行、认证覆盖与导出测试 |
| 跳板连接 | Python OpenSSH | ssh2 ProxyJump 链 | 本机两个 SSH 服务之间实际跳板连接 |
| 命令、工作目录、环境变量、超时 | 两者 | `ssh_exec` | 命令管理测试、真实 SSH exec；本机 shell 环境变量引用测试 |
| 文件与目录上传下载 | 两者 | `ssh_upload/download`，SFTP | 文件/目录传输、超时和路径校验测试 |
| 文件读取及分页 | 两者 | `ssh_file_read` | 字节读测试、按行读测试 |
| 新建、覆盖、追加 | 两者 | `ssh_file_write` | 独占创建、写入参数及错误处理测试 |
| 精确编辑 | Python | `ssh_file_edit` | 唯一匹配、失败保留原文件、权限和临时文件清理测试 |
| 编辑审核与备份 | 新增 | `ssh_file_edit(dryRun, expectedSha256, backup)` | 预览无写入、可应用 diff、过期哈希拒绝、BOM/CRLF 与备份权限、失败保留原文件 |
| 终端尺寸调整 | 新增 | `ssh_session_resize` 与创建时 cols/rows | 两种后端真实远端 `stty size` 验证创建与 resize；旧 worker 需重建 |
| 目录浏览 | Python | `ssh_directory_list` | 文件类型、隐藏项和截断测试 |
| 内容搜索、文件查找 | Python | `ssh_file_grep/glob` | 字面量/正则、上下文、count/files、glob 字符类/花括号、隐藏项与排除测试 |
| 增量目录同步 | Python | `ssh_sync`，默认 rsync，可选 SFTP | 真实 SSH 上预览、上传、块级匹配数据、删除与下载；SFTP 排除及无变化测试 |
| 持久交互终端、增量输出、复用 | Python | `ssh_session_*` | 真实父进程退出后重新接入同一 worker；环境保留；重复会话及命令过滤检查 |
| 观察终端输出 | Python | `ssh_session_read/log` 与可选 tmux 观察 | 实时回读、完整日志权限、停止后日志读取；tmux 3.8 真实 pane 内容、窗口复用、手动停止与 autoClose 清理均通过 |
| 日志生命周期 | 新增 | `ssh_session_log_cleanup` | 已结束会话筛选、dry-run 与明确执行删除测试 |
| 长任务、状态、停止、列表 | TypeScript | `ssh_job_*` | 本机临时目录中实际运行后台任务脚本，工具及校验测试 |
| 本地/反向端口转发 | Python | `ssh_forward_*` | 本机实际 TCP 数据经 SSH 正向/反向传输及清理 |

## 运行条件和行为边界

- rsync 同步需要两端安装 rsync；常用扩展参数有明确列表，不能通过参数覆盖传输桥接或注入其他命令。archive 元数据能力受远端权限与系统支持约束，没有事务回滚。
- 持久终端可以跨 MCP 重启，不能跨机器重启或 SSH 断线恢复原 shell。完整日志保留在本地状态目录，需要按实际使用情况清理。
- tmux 是可选观察方式，缺少时自动返回日志路径，不影响终端操作。
- 原生兼容连接需要本机 OpenSSH 及原配置文件；配置内本地命令在连接时按 OpenSSH 规则执行。
- 文件精确编辑要求服务端支持 POSIX rename 扩展。文本及搜索有可报告的资源预算；正则超时会终止匹配线程。
- 原有显式命令/路径限制仍有效：任意交互 shell 和 rsync 要求未配置命令过滤的连接；可使用受过滤的命令工具及 SFTP。Shell 堡垒机模式的文件服务取决于是否存在 SFTP 通道。
- 新参数和工具名称不保证与旧 MCP 调用兼容。

## 验证范围

本次全面复测修复了原生转发通道子进程未清理、自然退出终端重开时旧 worker 遗留，以及 SSH 断线清理反向转发时抛异常三个问题。终端 IPC 同时改为 UTF-8 流式解码。安装 tmux 后的补测进一步修复了 autoClose 退出时遗留观察窗口的问题。详细记录见 [测试报告](TEST_REPORT.md)。

最终验证：`npm test` 301 项通过，0 失败、0 跳过；TypeScript 构建与 `npm pack --dry-run` 通过。工具参考已按实际 schema 生成，共 30 个工具。

实际网络测试使用本机临时 SSH 服务，并以真实 sshd 验证：仅证书可用的认证、SFTP 原子编辑、ProxyCommand/Match、双向 TCP 转发、rsync 块级差分/删除，以及父进程退出后终端复用与日志持久化。基础回归还覆盖配置、命令、文件、后台任务、HTTP 和连接生命周期。

没有连接用户真实服务器，未验证所有远端系统和堡垒机组合。本机已安装 tmux 3.8，已补齐两种后端的观察窗口测试。没有吞吐基准测试，不能据此宣称所有场景均最快。
