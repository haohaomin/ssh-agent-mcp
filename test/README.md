# 测试文档

本项目使用 Node.js 内置的测试框架进行单元测试和集成测试。当前共 479 项，最近完整结果见 [测试报告](../docs/TEST_REPORT.md)。

实际 SSH 集成测试需要本机 `ssh`、`ssh-keygen`、`rsync` 和 sshd（默认 `/usr/sbin/sshd`，可用 `SSH_AGENT_TEST_SSHD` 指定）。测试创建临时密钥与仅监听 loopback 的临时服务器，不连接个人配置中的服务器。真实 sshd 测试要求账户可以使用公钥登录该本机测试服务。

新增的主要集成测试：

- `exec-deployment.test.js` / `exec-deployment-live.test.js`：命令过滤与参数预检、输出预算与落盘失败、ssh2/OpenSSH 的多行脚本、失败即停、同 shell 批量步骤、远端文件环境注入与符号链接边界，以及模拟 sudo 包装。真实 MCP stdio 全工具测试也覆盖新参数。Python 覆盖 58 行 JSON/SQL 脚本、异常与退出码、cwd/env/远端文件注入，以及超时前无缓冲输出；解释器过滤和 shell 专用参数冲突在连接前校验。

- `mcp-regressions.test.js`：两种后端真实 MCP HTTP 请求的并发编辑、默认连接终端复用、符号链接路径边界、上传/下载和转发停止记录归属。

- `activity-log.test.js` / `activity-live.test.js`：并发记录隔离、凭据脱敏、历史保留与重启、磁盘错误，以及两种 SSH 后端经真实 MCP HTTP 调用的 SSE 输出、文件差异、后台任务/终端自动跟踪和鉴权。

- `web-ui-live.test.js`：两种后端的真实 HTTP 工作流，包含连接/诊断/重连、完整文本读取、哈希校验、空文件编辑、备份恢复、上传、持久会话、任务和转发；配合 HTTP 与 CLI 回归验证鉴权、跨站防护和 UI 路由。

- `mcp-live-tools.test.js`：分别通过 ssh2/OpenSSH，从真实 MCP stdio 客户端调用全部 33 个工具；含超时、中文、二进制目录传输、rsync/SFTP、持久终端、任务、转发、连接诊断、配置热加载和日志清理。后台任务 HOME 被限定到临时目录。
- `full-features-live.test.js`：证书认证、ProxyCommand/Match、块级差分、父进程退出后的终端恢复。
- `auth-live-audit.test.js`：两种后端的加密私钥认证与错误主机公钥拒绝。
- `audit-regressions.test.js`：通道进程回收、终端重开与反向转发断线清理。
- `tmux-live.test.js`：需要本机 tmux，在隔离 server 中实测 ssh2/OpenSSH 的中文输出、pane 复用、手动停止及 autoClose 窗口清理。
- `search-matcher.test.js`：病态正则超时与后续恢复。

先 `npm run build`，再用 `node --test test/具体文件.test.js` 单独运行这些测试。

## 测试结构

```
test/
├── ssh-config-parser.test.js      # SSH 配置解析器测试
├── command-line-parser.test.js    # 命令行参数解析器测试
├── ssh-connection-manager.test.js # SSH 连接管理器测试
├── integration.test.js            # 集成测试
└── fixtures/                      # 测试数据（自动生成）
```

## 运行测试

### 运行所有测试

```bash
npm test
```

### 监听模式（开发时使用）

```bash
npm run test:watch
```

监听模式会在文件变化时自动重新运行测试。

### 运行单个测试文件

```bash
node --test test/ssh-config-parser.test.js
```

## 测试覆盖范围

### 1. SSH Config Parser 测试

测试 `src/utils/ssh-config-parser.ts` 的功能：

- ✅ 基本 Host 别名解析
- ✅ 多别名 Host 行（`Host a b c`）
- ✅ 通配符匹配（`Host *.example.com`）
- ✅ `Host *` 默认值 fallback
- ✅ `Include` 指令支持
- ✅ 路径展开（`~` 和相对路径）
- ✅ First-match-wins 语义
- ✅ 错误处理（文件不存在等）

### 2. Command Line Parser 测试

测试 `src/cli/command-line-parser.ts` 的功能：

- ✅ JSON 配置文件解析（对象和数组格式）
- ✅ `--ssh` 参数解析（JSON 和旧格式）
- ✅ 单连接模式（命令行参数和位置参数）
- ✅ SSH config 集成
- ✅ 参数优先级（命令行 > SSH config）
- ✅ 命令白名单和黑名单
- ✅ 其他选项（`--pty`, `--pre-connect`, `--proxy`, `--socksProxy`）
- ✅ 错误处理

### 3. SSH Connection Manager 测试

测试 `src/services/ssh-connection-manager.ts` 的功能：

- ✅ 配置管理（初始化、获取配置）
- ✅ 命令验证（白名单、黑名单、正则表达式）
- ✅ 连接状态管理
- ✅ 多服务器支持

### 4. 集成测试

端到端测试完整流程：

- ✅ 从命令行参数到连接管理器的完整流程
- ✅ 从 SSH config 到连接管理器的完整流程
- ✅ 多服务器配置场景
- ✅ 错误处理（无效配置、缺少字段等）

## 编写新测试

### 测试文件命名

测试文件应该以 `.test.js` 结尾，并放在 `test/` 目录下。

### 测试示例

```javascript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

describe('功能模块名称', () => {
  before(() => {
    // 测试前的准备工作
  });

  after(() => {
    // 测试后的清理工作
  });

  describe('子功能', () => {
    it('应该做某事', () => {
      // 测试代码
      assert.strictEqual(1 + 1, 2);
    });

    it('应该处理错误情况', () => {
      assert.throws(() => {
        throw new Error('测试错误');
      }, /测试错误/);
    });
  });
});
```

## 测试最佳实践

1. **独立性**：每个测试应该独立运行，不依赖其他测试的状态
2. **清理**：使用 `after` 钩子清理测试创建的临时文件和资源
3. **描述性**：测试名称应该清楚地描述测试的内容
4. **覆盖边界情况**：测试正常情况、边界情况和错误情况
5. **使用 fixtures**：将测试数据放在 `test/fixtures/` 目录下

## CI/CD 集成

测试可以轻松集成到 CI/CD 流程中：

```yaml
# GitHub Actions 示例
- name: Run tests
  run: npm test
```

## 调试测试

### 使用 Node.js 调试器

```bash
node --inspect-brk --test test/ssh-config-parser.test.js
```

然后在 Chrome 中打开 `chrome://inspect` 进行调试。

### 查看详细输出

```bash
node --test --test-reporter=tap test/**/*.test.js
```

## 常见问题

### Q: 测试失败但没有详细错误信息？

A: 使用 `--test-reporter=spec` 查看详细输出：

```bash
node --test --test-reporter=spec test/**/*.test.js
```

### Q: 如何跳过某个测试？

A: 使用 `it.skip()`:

```javascript
it.skip('暂时跳过的测试', () => {
  // 测试代码
});
```

### Q: 如何只运行某个测试？

A: 使用 `it.only()`:

```javascript
it.only('只运行这个测试', () => {
  // 测试代码
});
```

## 贡献指南

提交 PR 时，请确保：

1. 所有测试通过：`npm test`
2. 新功能有对应的测试
3. 测试覆盖了正常情况和边界情况
4. 代码编译通过：`npm run build`

- `shared-service.test.js`：真实 stdio 客户端并发接入、端口避让、共同活动记录、进程存活、配置隔离、崩溃恢复、不重放失败操作与鉴权停止。
- `setup-codex.test.js`：一键注册、原配置保留、幂等与同名无关配置保护。

- `disconnect.test.js`：ssh2/OpenSSH 的 MCP 与网页断开、跨服务器隔离、终端/转发清理、后台任务保留、暂停自动重连和并发启动保护。

- `activity-monitor-offline.test.js`：重建监视器后，离线历史任务等待显式连接再查询。
- `browser/workbench-races.js`：独立运行的真实浏览器回归，覆盖切换目标时清空未发送命令，以及延迟文件读取/恢复保留草稿；执行方式见 `browser/README.md`。

- `forward-lifecycle.test.js`：转发创建期间关闭/断线、迟到端口分配回收、反向转发超时，以及并发创建的数量限制和名额释放。

### 结构化结果与固定动作策略

- `execution-policy.test.js`：策略配置失败关闭、所有执行旁路连接前拒绝、步骤事件分片及内存上界。
- `execution-result-live.test.js`：两种后端真实 SSH 的结构化退出、步骤、并发、超时、日志故障和固定动作字面量执行。
- 阿里云独立 MCP 验证结果见 `docs/TEST_REPORT.md` 最新记录。

- `execution-edge-cases.test.js`：无退出状态的通道关闭、流错误日志保留，以及异步准备/排队期间的策略重载竞态。

- `operations-workflow.test.js`：多主机目标拒绝、后台脚本与状态恢复、35 MiB 跨端点传输、超时/摘要损坏/越界/受限策略回归。

- `operations-improvements.test.js`：脱敏配置失败关闭、跨块/跨页秘密、完整 exec 日志与终端日志、原生收尾诊断、inode/硬链接观察、空文件截断、默认原子替换、多机失败隔离/顺序/并发预算；两种真实 SSH 后端均覆盖。`agent-files.test.js` 另注入原地截短失败，检查备份与部分写入提示。
