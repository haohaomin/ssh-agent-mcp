# 排错指南

## 服务启动后没有提示符

stdio 服务正在等待 MCP 客户端请求，不是交互式 SSH 命令行。通过客户端加载工具，先调用 `ssh_server_list`。诊断信息输出到 stderr，stdout 用于 MCP 协议。

## 客户端找不到 Node 或项目

`args` 中使用 `build/index.js` 的绝对路径，先执行 `npm run build`。桌面客户端的 PATH 可能与终端不同：执行 `command -v node`，把结果填入客户端的 `command`。

## 没有导入任何主机

确认配置文件存在。`Host *.example.com` 只是一条匹配规则，不会枚举成主机列表；启动时补充 `--host dev.example.com`。导入警告和跳过原因在 stderr。

## 为什么普通配置也走 OpenSSH

导入器只直接映射已实现的选项。遇到其他选项会采用原生兼容后端，例如 `Compression yes`。这是保守兼容策略；不会改变你使用的 MCP 工具名称。完整映射见 [连接与配置](CONFIGURATION.md)。

## 认证失败或主机公钥不匹配

先确认同一用户在终端能使用原配置连接。检查密钥路径、私钥权限、Agent socket，以及 `SSH_MCP_PASSPHRASE` 是否正确传入 MCP 进程。ssh2 与原生 SSH 的可用认证配置不同，查看导入时的后端提示。

对于未知主机，先通过已有 SSH 客户端核验指纹并准备 known_hosts。对于已保存但发生变化的公钥，先核实服务器变更原因，再更新对应记录。

## rsync 不存在或同步无变化

默认两端都需要 rsync；可显式使用 `engine: "sftp"` 进行文件级同步。确认 `dryRun` 是否仍为默认的 `true`，以及源目录末尾 `/` 是否符合预期。`deleteExtra: true` 需要 rsync。

## tmux 窗口没出现

观察窗口在后台创建，不会主动弹出系统终端。运行返回的 `attachCommand` 查看。macOS 可先执行 `brew install tmux`；MCP 进程的 PATH 也需要包含 tmux。

没有 tmux 时会返回 `mode: "transcript"` 与日志路径，终端仍能用。观察窗口只显示日志，交互输入通过 `ssh_session_write` 完成。

## 重启后无法复用终端

需要使用同一 `SSH_AGENT_STATE_DIR`、会话名和连接配置。修改认证或权限配置后，不会自动接入旧配置的 worker。MCP 进程重启可以复用；机器重启、worker 退出或 SSH 断线不能恢复原 shell。

## 命令或文件访问被拒绝

检查连接的 `commandWhitelist` / `commandBlacklist`、`allowedLocalPaths` / `allowedRemotePaths`。终端和 rsync 需要未配置命令过滤的连接。SFTP 工具独立检查路径；Shell 堡垒机模式不能提供 SFTP 通道。

## 精确编辑失败

旧文本缺失、多次匹配、文件被其他程序改变，或 SFTP 服务器不支持 POSIX rename 都会拒绝编辑。先重新读取文件，确认匹配范围；原子替换失败时原文件会保留。

## 测试启动 sshd 失败

真实集成测试需要本机 SSH 服务端可执行文件（默认 `/usr/sbin/sshd`），以及可进行公钥登录的本机账户。可用 `SSH_AGENT_TEST_SSHD` 指定路径。测试会创建自己的 loopback 服务、临时密钥与文件；无需把生产服务器填入测试配置。
