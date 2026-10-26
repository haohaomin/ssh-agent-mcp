const titles = {
  ssh_exec: '执行命令', web_command: '执行命令', ssh_file_edit: '修改文件', web_file_edit: '修改文件',
  ssh_file_write: '写入文件', web_file_create: '上传文本', ssh_file_read: '读取文件', web_file_read: '读取文件',
  ssh_upload: '上传文件', ssh_download: '下载文件', ssh_sync: '同步文件', ssh_job_start: '启动后台任务',
  ssh_job_status: '查询任务', ssh_job_list: '查看任务列表', ssh_job_kill: '停止任务', web_job_kill: '停止任务',
  ssh_session_start: '创建终端', ssh_session_ensure: '复用终端', web_sessions_start: '创建终端',
  ssh_session_write: '发送终端命令', web_session_write: '发送终端命令', session_output: '终端实时输出',
  ssh_session_stop: '停止终端', web_session_stop: '停止终端', ssh_session_read: '读取终端',
  ssh_session_list: '查看终端列表', ssh_session_log: '读取终端日志', ssh_session_resize: '调整终端尺寸', web_session_resize: '调整终端尺寸',
  ssh_session_log_cleanup: '清理终端日志', ssh_forward_list: '查看转发列表',
  ssh_forward_start: '创建本地转发', ssh_forward_reverse: '创建反向转发', ssh_forward_stop: '停止转发', web_forward_stop: '停止转发',
  ssh_server_diagnose: '连接诊断', web_diagnose: '连接诊断', ssh_config_reload: '重新读取配置', web_config_reload: '重新读取配置',
  ssh_server_list: '查看服务器', ssh_directory_list: '浏览目录', ssh_file_grep: '搜索文件内容', ssh_file_glob: '查找文件',
  web_connect: '连接服务器', web_reconnect: '重新连接', web_disconnect: '断开连接', ssh_server_disconnect: '断开连接',
};
const statuses = { running: '进行中', succeeded: '已完成', failed: '失败', interrupted: '跟踪中断' };
const sources = { mcp: 'AI / MCP', web: '网页操作', monitor: '自动跟踪' };
const globalOperations = new Set(['ssh_server_list', 'ssh_config_reload', 'web_config_reload', 'ssh_session_list', 'ssh_session_log_cleanup', 'ssh_forward_list']);
const changes = new Set(['ssh_file_edit','web_file_edit','ssh_file_write','web_file_create','ssh_upload','ssh_sync']);
const $ = selector => document.querySelector(selector);
const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };
const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
export function serverResult(record) {
  if (record.operation !== 'ssh_server_list') return undefined;
  const raw = record.result?.split('Raw JSON:\n')[1];
  const result = parse(raw || record.result || '');
  return Array.isArray(result) ? result.filter(item => item && typeof item.name === 'string') : undefined;
}
export function activityInfo(record) {
  const input = record.operation === 'ssh_server_list' ? {} : parse(record.input) || {};
  const servers = serverResult(record);
  const title = titles[record.operation] || '执行操作';
  const scope = globalOperations.has(record.operation) ? '所有服务器' : record.connectionName || '全局';
  const duration = Math.max(0, new Date(record.finishedAt || record.updatedAt) - new Date(record.startedAt));
  let summary = input.command || input.remotePath || input.localPath || input.input || input.sessionName || input.jobId;
  if (!summary && servers) summary = `${servers.length} 台服务器 · ${servers.filter(s => s.connected).length} 台已连接`;
  if (!summary) summary = record.status === 'running' ? '正在执行，等待输出…' : record.status === 'failed' ? '执行未完成，查看失败原因' : `${title} · ${statuses[record.status] || record.status}`;
  return { title, input, servers, scope, summary: String(summary), duration: duration < 1000 ? `${duration} ms` : `${(duration / 1000).toFixed(1)} 秒`, changed: changes.has(record.operation) && input.dryRun !== true };
}
const iconPaths = {
  command: '<path d="m5 6 5 5-5 5m8 0h6"/>',
  file: '<path d="M13 3H5v18h14V9l-6-6Z"/><path d="M13 3v6h6M8 13h8M8 17h5"/>',
  server: '<rect x="4" y="4" width="16" height="6" rx="2"/><rect x="4" y="14" width="16" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  task: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="m10 8 5 4-5 4Z"/>',
};
function recordIcon(record) { const kind = /file|directory|upload|download|sync/.test(record.operation) ? 'file' : /server|config|connect/.test(record.operation) ? 'server' : /job|forward/.test(record.operation) ? 'task' : 'command'; return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[kind]}</svg>`; }

export class ActivityPanel {
  records = new Map(); nodes = new Map(); paused = false; stopped = false; selected = null; tab = 'result'; metric = 'all';
  constructor(base, token, onChange = () => {}) {
    this.base = base; this.token = token; this.onChange = onChange;
    for (const id of ['activity-search', 'activity-host', 'activity-status', 'activity-source']) $(`#${id}`).addEventListener('input', () => { if (id === 'activity-status') this.metric = 'all'; this.render(); });
    $('#activity-pause').addEventListener('click', () => {
      this.paused = !this.paused; $('#activity-pause').textContent = this.paused ? '继续显示' : '暂停显示';
      $('#activity-pause').setAttribute('aria-pressed', String(this.paused));
      if (!this.paused) this.render(); else $('#activity-counts').textContent = '显示已暂停 · 后台仍在记录';
    });
    $('#activity-reset').addEventListener('click', () => {
      for (const id of ['activity-search','activity-host','activity-source','activity-status']) $(`#${id}`).value = '';
      this.metric = 'all'; this.render();
    });
    $('#activity-back').addEventListener('click', () => {
      $('.activity-feed').scrollIntoView({block:'start',behavior:'auto'});
      this.nodes.get(this.selected)?.focus({preventScroll:true});
    });
    document.querySelectorAll('[data-activity-metric]').forEach(button => button.addEventListener('click', () => {
      this.metric = button.dataset.activityMetric; $('#activity-status').value = ''; this.render();
    }));
    const tabs = [...document.querySelectorAll('[data-detail-tab]')];
    tabs.forEach((button, index) => {
      button.addEventListener('click', () => { this.tab = button.dataset.detailTab; this.renderDetail(); });
      button.addEventListener('keydown', event => {
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault(); const at = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length-1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[at].focus(); tabs[at].click();
      });
    });
    $('#activity-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(this.copyText || ''); $('#activity-copy').textContent = '已复制'; }
      catch { $('#activity-copy').textContent = '复制失败，请手动选择'; }
      clearTimeout(this.copyTimer); this.copyTimer = setTimeout(() => { $('#activity-copy').textContent = '复制内容'; }, 1800);
    });
    document.addEventListener('keydown', event => {
      if (event.key === '/' && !$('#view-activity').hidden && !event.ctrlKey && !event.metaKey && !event.altKey && !/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) && !event.target.isContentEditable) { event.preventDefault(); $('#activity-search').focus(); }
    });
    window.addEventListener('pagehide', () => { this.stopped = true; this.controller?.abort(); });
    window.addEventListener('pageshow', event => { if (event.persisted) { this.stopped = false; this.start(); } });
  }
  setServers(servers) {
    const select = $('#activity-host'), current = select.value;
    select.replaceChildren(new Option('全部服务器', ''), ...servers.map(server => new Option(server.name, server.name)));
    select.value = current;
  }
  async start() {
    if (this.connecting) return;
    this.connecting = true;
    try {
      while (!this.stopped) {
        try {
          this.controller = new AbortController();
          const response = await fetch(`${this.base}/activity/events`, { headers: this.token() ? { Authorization: `Bearer ${this.token()}` } : {}, signal: this.controller.signal });
          if (!response.ok || !response.body) throw new Error(response.status === 401 ? '鉴权失效，请刷新页面输入 Token' : `连接失败 (${response.status})`);
          $('#activity-live').textContent = '● 实时同步中';
          const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
          try {
            while (!this.stopped) {
              const { value, done } = await reader.read(); if (done) throw new Error('连接已断开');
              buffer += decoder.decode(value, { stream: true });
              let boundary;
              while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
                if (event.startsWith('data: ')) this.accept(JSON.parse(event.slice(6)));
              }
            }
          } finally { await reader.cancel().catch(() => {}); }
        } catch (error) {
          if (this.stopped) break;
          $('#activity-live').textContent = `${error.message} · 3 秒后重连`;
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
    } finally { this.connecting = false; }
  }
  accept(event) {
    if (event.type === 'snapshot') {
      this.records = new Map(event.records.map(record => [record.id, record]));
      $('#activity-storage').hidden = !event.storageError; $('#activity-storage').textContent = event.storageError || '';
    } else if (event.type === 'storage-error') {
      $('#activity-storage').hidden = false; $('#activity-storage').textContent = '历史记录写入失败；当前页面仍可实时查看';
    } else if (event.type === 'upsert') {
      for (const id of event.removed || []) this.records.delete(id);
      this.records.set(event.record.id, event.record);
      if (event.record.status !== 'running') { clearTimeout(this.refreshTimer); this.refreshTimer = setTimeout(this.onChange, 300); }
    }
    if (!this.paused) this.render();
  }
  render() {
    const query = $('#activity-search').value.toLowerCase(), host = $('#activity-host').value, status = $('#activity-status').value, source = $('#activity-source').value;
    // Pause freezes a snapshot, but filtering and inspecting that snapshot remain available.
    if (!this.paused || !this.displayed) this.displayed = [...this.records.values()].map(record => ({...record}));
    const all = this.displayed;
    const attention = record => ['failed','interrupted'].includes(record.status);
    const records = all.filter(record => {
      const info = activityInfo(record);
      return (!host || (!globalOperations.has(record.operation) && record.connectionName === host)) && (!status || record.status === status) && (!source || record.source === source)
        && (this.metric === 'all' || this.metric === 'running' && record.status === 'running' || this.metric === 'changes' && info.changed || this.metric === 'failed' && attention(record))
        && (!query || [info.title, info.scope, record.operation, record.input, record.output, record.result, record.diff].join('\n').toLowerCase().includes(query));
    }).sort((a,b) => new Date(b.startedAt)-new Date(a.startedAt));
    for (const [key,value] of Object.entries({all:all.length,running:all.filter(r=>r.status==='running').length,changes:all.filter(r=>activityInfo(r).changed).length,failed:all.filter(attention).length})) $(`#metric-${key}`).textContent = value;
    document.querySelectorAll('[data-activity-metric]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.activityMetric===this.metric)));
    if (!records.some(record=>record.id===this.selected)) { this.selected = records[0]?.id || null; this.tab = 'result'; }
    const list = $('#activity-list'), ids = new Set(records.map(record=>record.id));
    for (const [id,node] of this.nodes) if (!ids.has(id)) { node.remove(); this.nodes.delete(id); }
    records.forEach((record,index) => {
      const info = activityInfo(record); let node = this.nodes.get(record.id);
      if (!node) {
        node = element('button','activity-record'); node.type = 'button';
        node.innerHTML = `<span class="record-icon">${recordIcon(record)}</span><span class="activity-main"><span class="record-top"><strong></strong><time></time></span><span class="activity-preview"></span><span class="record-bottom"><span class="record-scope"></span><span class="activity-status"></span></span></span>`;
        node.addEventListener('click', () => {
          this.selected = record.id; this.tab = 'result'; this.render();
          if (matchMedia('(max-width:820px)').matches) $('#activity-inspector').scrollIntoView({block:'start',behavior:'auto'});
        });
        this.nodes.set(record.id,node);
      }
      node.dataset.status = record.status; node.setAttribute('aria-pressed',String(record.id===this.selected)); node.setAttribute('aria-controls','activity-inspector');
      node.querySelector('strong').textContent = info.title;
      const pathPreview = info.input.remotePath || info.input.localPath;
      node.querySelector('.activity-preview').textContent = pathPreview ? String(pathPreview).replace(/^.*\/(?=[^/]+\/[^/]+$)/,'…/') : info.summary.slice(0,200);
      node.querySelector('.record-scope').textContent = info.scope;
      node.querySelector('.activity-status').textContent = statuses[record.status] || record.status;
      const time = node.querySelector('time'); time.dateTime = record.startedAt; time.textContent = new Date(record.startedAt).toLocaleTimeString('zh-CN',{hour12:false});time.title = new Date(record.startedAt).toLocaleString('zh-CN');
      if (list.children[index] !== node) list.insertBefore(node,list.children[index] || null);
    });
    $('#activity-empty').hidden = records.length > 0;
    $('#activity-empty h2').textContent = all.length ? '没有匹配的操作' : '等待第一条操作';
    $('#activity-empty p').textContent = all.length ? '尝试其他关键词，或清除筛选条件。' : '让 AI 使用 SSH 工具执行操作，进展会出现在这里。';
    $('#activity-counts').textContent = this.paused ? `显示已暂停 · ${records.length} 条记录` : `${records.length} 条操作${records.length !== all.length ? ` / 共 ${all.length} 条` : ''}`;
    $('#activity-reset').hidden = !(query || host || status || source || this.metric !== 'all');
    this.renderDetail();
  }
  renderDetail() {
    const record = this.displayed?.find(record=>record.id===this.selected);
    $('#activity-detail-empty').hidden = Boolean(record); $('#activity-detail').hidden = !record;
    if (!record) { this.detailSignature = ''; return; }
    const info = activityInfo(record);
    $('#detail-operation-kind').textContent = record.diff ? '文件变更' : /exec|command|session/.test(record.operation) ? '远程执行' : '操作详情';
    $('#activity-detail-title').textContent = info.title;
    $('#activity-detail-summary').textContent = info.summary;
    const status = $('#activity-detail-status');status.textContent = statuses[record.status] || record.status;status.dataset.status = record.status;
    $('#activity-detail-host').textContent = info.scope;
    $('#activity-detail-source').textContent = sources[record.source] || record.source;
    $('#activity-detail-time').textContent = new Date(record.startedAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
    $('#activity-detail-duration').textContent = info.duration;
    document.querySelectorAll('[data-detail-tab]').forEach(button=> {const selected = button.dataset.detailTab===this.tab; button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
    $('#activity-tab-diff').textContent = record.diff ? '文件差异 •' : '文件差异';
    const content = $('#activity-detail-content'); content.setAttribute('aria-labelledby',`activity-tab-${this.tab}`);
    $('#activity-content-label').textContent = this.tab==='result' ? record.status==='running' ? '实时输出' : record.status==='failed' ? '失败详情' : '执行结果' : this.tab==='diff' ? '修改前后对比' : '工具调用参数';
    const value = this.tab==='input' ? JSON.stringify(info.input,null,2) : this.tab==='diff' ? record.diff || '' : (record.status==='running' ? record.output : record.result || record.output) || '';
    this.copyText = value;
    $('#activity-copy').disabled = !value || value==='{}';
    const signature = [record.id,this.tab,record.status,value].join('\0');
    if (signature !== this.detailSignature) {
      const same = this.detailId===record.id && this.detailTab===this.tab, scroll = content.scrollTop;
      const atEnd = content.scrollHeight-content.clientHeight-scroll < 40;
      content.replaceChildren();
      if (this.tab==='result' && info.servers) {
        const table = element('table','result-server-table'); table.innerHTML='<thead><tr><th>服务器</th><th>连接状态</th></tr></thead>';
        const body = element('tbody');
        for (const server of info.servers) {
          const row = element('tr'), name = element('td'), state = element('td');
          name.append(element('strong','',server.name),element('small','',`${server.username || ''}@${server.host || ''}:${server.port || 22}`));
          const badge = element('span','status-pill',server.connected ? '已连接' : '未连接');badge.dataset.status=server.connected?'succeeded':'idle';state.append(badge);row.append(name,state);body.append(row);
        }
        table.append(body);content.append(table);
      } else if (!value || value==='{}') content.append(element('p','content-empty',this.tab==='input'?'此操作无需填写参数。':this.tab==='diff'?'此操作没有文件差异。':record.status==='running'?'正在执行，输出到达后会自动显示。':'操作已结束，没有文本输出。'));
      else if (this.tab==='diff') {
        const pre=element('pre','activity-diff');
        for(const line of value.split('\n').filter(line => !/^={4,}$/.test(line))) pre.append(element('span',line.startsWith('@@')?'diff-hunk':line.startsWith('+')?'diff-added':line.startsWith('-')?'diff-removed':'',line+'\n'));
        content.append(pre);
      } else content.append(element('pre','activity-code',value));
      content.scrollTop = same ? (atEnd && record.status==='running' ? content.scrollHeight : scroll) : 0;
      this.detailSignature=signature;this.detailId=record.id;this.detailTab=this.tab;
    }
    $('#activity-detail-note').textContent = [record.truncated ? '长输出已截断，显示保留的内容。' : '', record.operation==='session_output' ? '这是共享终端输出，可能包含多个客户端的输入结果。' : '', info.input.dryRun ? '本次为预览，没有写入文件。' : ''].filter(Boolean).join(' ');
    $('#activity-detail-note').hidden = !$('#activity-detail-note').textContent;
    $('#activity-detail-technical').textContent = `工具：${record.operation}\n记录：${record.id}${record.jobId?'\n任务：'+record.jobId:''}${record.sessionName?'\n会话：'+record.sessionName:''}`;
  }
}
