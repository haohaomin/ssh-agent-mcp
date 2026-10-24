import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {marked} from 'marked';
import {toolCatalog} from './tool-catalog.js';
const root=fileURLToPath(new URL('..',import.meta.url));
const out=path.join(root,'_site');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const repo='https://github.com/haohaomin/ssh-agent-mcp';
const tools=toolCatalog();
const pages=[
  {url:'index.html',title:'项目概览',tag:'START HERE'},
  {url:'guide.html',title:'快速开始',source:'README.md',tag:'GET STARTED'},
  {url:'configuration.html',title:'连接与配置',source:'docs/CONFIGURATION.md',tag:'CONNECTIONS'},
  {url:'usage.html',title:'工具与工作流',source:'docs/USAGE.md',tag:'WORKFLOWS'},
  {url:'tools.html',title:'工具参考',tag:'TOOL REFERENCE'},
  {url:'troubleshooting.html',title:'排错指南',source:'docs/TROUBLESHOOTING.md',tag:'TROUBLESHOOTING'},
  {url:'features.html',title:'功能对照',source:'docs/FEATURE_AUDIT.md',tag:'CAPABILITIES'},
  {url:'testing.html',title:'测试报告',source:'docs/TEST_REPORT.md',tag:'VERIFICATION'},
  {url:'pages.html',title:'网站维护',source:'docs/PAGES.md',tag:'MAINTENANCE'},
  {url:'contributing.html',title:'运行测试',source:'test/README.md',tag:'DEVELOPMENT'},
  {url:'credits.html',title:'来源与许可',source:'THIRD_PARTY.md',tag:'OPEN SOURCE'},
];
const mapping=new Map(pages.filter(p=>p.source).map(p=>[p.source,p.url]));mapping.set('docs/TOOLS.md','tools.html');
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const plain=s=>s.replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
const slug=s=>plain(s).toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu,'').trim().replace(/\s+/g,'-');
const search=[];
function renderMarkdown(source,url){
  const md=fs.readFileSync(path.join(root,source),'utf8');
  let html=marked.parse(md);const headings=[],seen=new Map();
  html=html.replace(/<h([1-6])>(.*?)<\/h\1>/gs,(_,level,content)=>{
    const base=slug(content)||'section',count=seen.get(base)||0;seen.set(base,count+1);const id=base+(count?'-'+count:'');
    if(level==='2')headings.push({id,title:plain(content)});
    search.push({title:plain(content),url:url+'#'+id,text:plain(marked.parse(md.slice(md.indexOf(plain(content))+plain(content).length,md.indexOf(plain(content))+500))).replace(/\s+/g,' ')});
    return `<h${level} id="${escape(id)}">${content}</h${level}>`;
  });
  html=html.replace(/href="([^"#]+)(#[^"]*)?"/g,(original,href,hash='')=>{
    if(/^(?:https?:|mailto:)/.test(href))return original;
    const target=path.posix.normalize(path.posix.join(path.posix.dirname(source),href));
    return `href="${escape(mapping.get(target)||repo+'/blob/main/'+target)}${hash}"`;
  });
  html=html.replace(/<table>/g,'<div class="table-scroll" tabindex="0" role="region" aria-label="可横向滚动的表格"><table>').replace(/<\/table>/g,'</table></div>');
  return {html,headings};
}
const labels={ssh_exec:'执行命令',ssh_server_list:'服务器列表',ssh_upload:'上传文件与目录',ssh_download:'下载文件与目录',ssh_file_read:'读取文件',ssh_file_write:'写入文件',ssh_file_edit:'精确编辑',ssh_directory_list:'浏览目录',ssh_file_grep:'搜索内容',ssh_file_glob:'查找路径',ssh_sync:'同步目录',ssh_session_start:'创建终端',ssh_session_ensure:'创建或复用终端',ssh_session_list:'列出终端',ssh_session_read:'读取终端输出',ssh_session_write:'发送终端输入',ssh_session_log:'读取完整日志',ssh_session_stop:'停止终端',ssh_job_start:'启动后台任务',ssh_job_status:'查看任务状态',ssh_job_list:'列出任务',ssh_job_kill:'停止任务',ssh_forward_start:'本地端口转发',ssh_forward_reverse:'反向端口转发',ssh_forward_list:'列出转发',ssh_forward_stop:'停止转发'};
const groups=[['connection','连接与命令',['ssh_server_list','ssh_exec']],['files','文件与搜索',['ssh_upload','ssh_download','ssh_file_read','ssh_file_write','ssh_file_edit','ssh_directory_list','ssh_file_grep','ssh_file_glob','ssh_sync']],['sessions','持久终端',tools.filter(t=>t.name.startsWith('ssh_session_')).map(t=>t.name)],['jobs','后台任务',tools.filter(t=>t.name.startsWith('ssh_job_')).map(t=>t.name)],['forwards','端口转发',tools.filter(t=>t.name.startsWith('ssh_forward_')).map(t=>t.name)]];
function toolPage(){
  const html=`<h1>每个工具，都有据可查。</h1><p class="lead">${tools.length} 个统一接口。以下参数直接取自实际 MCP schema，和代码保持一致。</p><label class="filter-label" for="tool-filter">筛选工具</label><input id="tool-filter" type="search" placeholder="输入名称或用途，例如：日志、sync、session" autocomplete="off"><p id="tool-count" class="muted" aria-live="polite">显示 ${tools.length} 个工具</p><p id="tool-empty" hidden>没有匹配的工具。试试「文件」「终端」或工具名。</p>`+groups.map(([id,title,names])=>`<section class="tool-group"><h2 id="${id}">${title}</h2>${names.map(name=>{
    const t=tools.find(t=>t.name===name);search.push({title:labels[name],url:'tools.html#'+name,text:name+' '+t.description});
    const props=Object.entries(t.schema.properties||{});
    return `<article class="tool-card" id="${name}" data-search="${escape(name+' '+labels[name]+' '+t.description)}"><div class="tool-heading"><h3>${labels[name]}</h3><a href="#${name}" aria-label="链接到 ${name}">#</a></div><code class="tool-name">${name}</code><p class="tool-description">${escape(t.description)}</p>${props.length?`<div class="table-scroll" tabindex="0" role="region" aria-label="${name} 参数"><table><thead><tr><th>参数</th><th>类型</th><th>默认值 / 必填</th></tr></thead><tbody>${props.map(([key,value])=>`<tr><td><code>${escape(key)}</code></td><td>${escape(value.enum?value.enum.join(' | '):value.type||'object')}</td><td>${t.schema.required?.includes(key)?'<span class="required">必填</span>':value.default!==undefined?`<code>${escape(JSON.stringify(value.default))}</code>`:'可选'}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">无需参数。</p>'}<details><summary>查看完整 JSON Schema</summary><pre><code class="language-json">${escape(JSON.stringify(t.schema,null,2))}</code></pre></details></article>`;
  }).join('')}</section>`).join('');
  return {html,headings:groups.map(([id,title])=>({id,title}))};
}
function home(){return `<section class="hero"><div><p class="eyebrow"><span class="status-dot"></span> OPEN SOURCE · MCP SERVER</p><h1>让 AI 用好<br>你的 <span>SSH.</span></h1><p class="hero-description">沿用本机连接配置，让命令、文件、终端与长任务，在一套工具中协同工作。</p><div class="actions"><a class="button primary" href="guide.html">开始使用 <span>↗</span></a><a class="button secondary" href="tools.html">浏览 ${tools.length} 个工具 <span>→</span></a></div><p class="hero-note">TypeScript · Node.js 22+ · macOS / Linux</p></div><div class="terminal"><div class="terminal-bar"><span class="terminal-dots">● ● ●</span><span>从已有配置开始</span><span>~/.ssh/config</span></div><pre><code><span class="syntax-key">Host</span> dev
    <span class="syntax-key">HostName</span> server.example.com
    <span class="syntax-key">User</span> developer
    <span class="syntax-key">IdentityFile</span> ~/.ssh/id_ed25519</code></pre><div class="terminal-divider"><span>↓</span> 导入配置 · 按需连接</div><div class="engine-row"><span><i></i> ssh2</span><span>OpenSSH 兼容后端</span></div><div class="terminal-bottom">一套连接配置。统一的 MCP 工具。</div></div></section><div class="facts"><div><strong>${tools.length}</strong><span>统一工具</span></div><div><strong>2</strong><span>连接后端</span></div><div><strong>290<span> / 290</span></strong><span>功能测试通过 · 2026-10-24</span></div><a href="testing.html">查看验证范围 ↗</a></div><section class="home-section"><div class="section-heading"><p class="eyebrow">ONE WORKSPACE, MANY POSSIBILITIES</p><h2>从连接服务器，到完成工作。</h2><p>复用已有配置，把常用远程操作放在一起。</p></div><div class="feature-grid"><a class="feature" href="configuration.html"><span class="feature-index">01 / CONNECT</span><h3>连接你已有的环境</h3><p>读取 SSH 别名、密钥和跳板规则。证书与特殊代理配置交给原生 OpenSSH。</p><span class="feature-link">连接与配置 ↗</span></a><a class="feature" href="usage.html#预览与执行同步"><span class="feature-index">02 / WORK</span><h3>处理文件与远程任务</h3><p>搜索、编辑、同步项目，启动后台任务。同步默认先预览，再执行修改。</p><span class="feature-link">探索工作流 ↗</span></a><a class="feature" href="usage.html#持久终端与-tmux"><span class="feature-index">03 / CONTINUE</span><h3>保留你的工作现场</h3><p>跨 MCP 重启复用终端与环境，完整输出落盘，也能通过 tmux 实时观察。</p><span class="feature-link">持久终端 ↗</span></a></div></section><section class="quick-panel"><div><p class="eyebrow">GET STARTED</p><h2>从本机 SSH 配置开始。</h2><p>构建后，把绝对路径加入 MCP 客户端即可使用。</p><a class="text-link" href="guide.html">查看完整安装步骤 →</a></div><pre><code class="language-bash">git clone ${repo}.git
cd ssh-agent-mcp
npm ci
npm run build</code></pre></section><section class="home-bottom"><div><h3>不知道从哪里开始？</h3><p>先列出服务器，再执行一条命令。</p></div><a href="usage.html">查看调用示例 →</a><a href="troubleshooting.html">打开排错指南 →</a></section>`;}
function template(page,html,headings=[]){return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f7f8f5"><title>${escape(page.title)} · ssh-agent-mcp</title><meta name="description" content="ssh-agent-mcp 文档：复用 OpenSSH 配置，通过 26 个 MCP 工具执行命令、编辑文件、同步目录和管理持久终端。"><link rel="icon" type="image/svg+xml" href="favicon.svg"><link rel="stylesheet" href="styles.css"><script src="app.js" defer></script></head><body><a class="skip-link" href="#main">跳到正文</a><header class="topbar"><a class="brand" href="index.html"><span class="brand-icon">&gt;_</span><span>ssh-agent-mcp</span></a><span class="version">v${escape(pkg.version)}</span><div class="header-spacer"></div><div class="search-wrap"><label class="sr-only" for="site-search">搜索文档</label><input id="site-search" type="search" placeholder="搜索文档…" autocomplete="off" aria-controls="search-results" aria-expanded="false"><kbd>⌘ K</kbd><div id="search-results" class="search-results" hidden aria-label="搜索结果"></div><span id="search-status" class="sr-only" role="status"></span></div><a class="github-link" href="${repo}">GitHub <span>↗</span></a><button class="menu-toggle" aria-controls="sidebar" aria-expanded="false" aria-label="打开导航">☰</button></header><div class="layout"><aside class="sidebar" id="sidebar"><div class="sidebar-label">DOCUMENTATION</div><nav aria-label="文档导航">${pages.map((p,i)=>`${[5,8].includes(i)?'<div class="nav-divider"></div>':''}<a href="${p.url}" ${p.url===page.url?'aria-current="page"':''}><span>${escape(p.title)}</span>${p.url==='tools.html'?'<span class="nav-count">26</span>':''}</a>`).join('')}</nav><div class="sidebar-bottom"><span class="status-dot"></span> 开源 · ISC + MIT<br><a href="${repo}/issues">反馈问题 ↗</a></div></aside><main id="main" class="${page.url==='index.html'?'home':'doc-layout'}" tabindex="-1">${page.url==='index.html'?html:`<article class="prose"><p class="eyebrow">${page.tag}</p>${html}<div class="doc-footer"><a href="${repo}/blob/main/${page.source||'src/tools'}">在 GitHub 查看来源 ↗</a><a href="#main">回到顶部 ↑</a></div></article>${headings.length?`<aside class="toc"><p>本页内容</p><nav aria-label="本页目录">${headings.map(h=>`<a href="#${escape(h.id)}">${escape(h.title)}</a>`).join('')}</nav></aside>`:''}`}</main></div><footer class="site-footer"><span>ssh-agent-mcp · 把远程工作连在一起。</span><a href="credits.html">开源声明 ↗</a></footer><div id="copy-status" class="sr-only" role="status"></div></body></html>`;}
fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});
for(const page of pages){let result=page.url==='index.html'?{html:home(),headings:[]}:page.url==='tools.html'?toolPage():renderMarkdown(page.source,page.url);search.push({title:page.title,url:page.url,text:plain(result.html).slice(0,600)});fs.writeFileSync(path.join(out,page.url),template(page,result.html,result.headings));}
for(const file of ['styles.css','app.js','favicon.svg'])fs.copyFileSync(path.join(root,'site',file),path.join(out,file));
fs.writeFileSync(path.join(out,'search-index.json'),JSON.stringify(search));fs.writeFileSync(path.join(out,'.nojekyll'),'');
console.log(`Built ${pages.length} pages and ${tools.length} tool references in _site/`);
