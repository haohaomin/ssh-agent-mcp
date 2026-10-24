# 网站维护与 GitHub Pages

文档站由本仓库的 Markdown 和工具 schema 生成，采用静态 HTML、CSS 与 JavaScript。浏览器中不运行 SSH 服务，也不会读取访问者的 SSH 配置。

## 本机预览

```bash
npm ci
npm run docs:build
npm run docs:check
npm run docs:serve
```

打开 `http://127.0.0.1:4173`。生成目录为 `_site/`，不提交到 Git；网站使用相对资源链接，可部署在项目子路径下。预览服务只监听本机 loopback。

## 更新内容

| 内容 | 源文件 |
|---|---|
| 快速开始 | `README.md` |
| 连接与后端 | `docs/CONFIGURATION.md` |
| 场景与调用示例 | `docs/USAGE.md` |
| 工具参数 | `src/tools/`，通过 `npm run docs:tools` 生成 |
| 排错与验证 | `docs/TROUBLESHOOTING.md`、`docs/FEATURE_AUDIT.md`、`docs/TEST_REPORT.md` |
| 页面布局与交互 | `scripts/build-site.js`、`site/styles.css`、`site/app.js` |

搜索索引在构建时生成。所有字体、样式和脚本由站点自身提供，不依赖外部 CDN。代码块支持复制，工具参考支持筛选。

## 自动发布

仓库中的 `.github/workflows/pages.yml` 在 `main` 分支更新文档或相关代码时构建，并允许手动触发。工作流先构建并检查链接，再部署 `_site/`。

仓库 Settings → Pages → Build and deployment 的 Source 应设为 **GitHub Actions**。部署由 `github-pages` environment 管理。项目地址为：

[haohaomin.github.io/ssh-agent-mcp](https://haohaomin.github.io/ssh-agent-mcp/)

流程使用 GitHub 官方的 configure-pages、upload-pages-artifact 和 deploy-pages Actions。说明见 [GitHub Pages 自定义工作流文档](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。

## 公开仓库内容

只提交源代码、测试、通用示例和文档。以下文件已通过 `.gitignore` 排除：

- `.env`、私钥/证书容器和 `.ssh/`。
- `servers*.json`、`selected.json`、`connections*.json` 等本机连接配置。
- 终端日志、构建目录、浏览器测试产物和临时安装包。
- 原始 `ssh-mcp/` 与 `ssh-mcp-server/` 参考仓库。

Git 忽略规则不能识别任意文件中的凭据。新增文件仍应在提交前检查。测试中的主机、密码是虚构示例；真实 SSH 测试密钥在运行时临时生成。
