import { ActivityPanel } from './activity.js';
import { terminalChunk, terminalText, parseJobs, selectSession, sessionIdentity } from './ui-model.js';
const root = document.querySelector('#app');
const api = `${location.pathname.replace(/\/$/, '')}/api`;
const state = { view: 'overview', host: '', defaultHost: '', servers: [], sessions: [], session: null, file: '', original: '', draft: '', hash: '', directory: '.', owned: false, epoch: 0, backup: null };
const $ = selector => document.querySelector(selector);
const $$ = selector => [...root.querySelectorAll(selector)];
let bearer = sessionStorage.getItem('ssh-agent-mcp-token') || '';
const launchToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (launchToken) {
  bearer = launchToken;
  sessionStorage.setItem('ssh-agent-mcp-token', bearer);
  history.replaceState(null, '', location.pathname + location.search);
}
let pollBusy = false, authenticationNeeded = false;
let commandContext = null, draftRevision = 0;
const request = async (path, options = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const response = await fetch(`${api}${path}`, { ...options, headers });
  if (response.status === 401) {
    authenticationNeeded = true; $('#auth-form').hidden = false;
    throw new Error('连接凭据已失效，请重新打开工作台或输入访问令牌。');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || `请求失败（${response.status}）`);
  return data;
};
const activityPanel = new ActivityPanel(api, () => bearer, () => syncWorkbench().catch(fail));
const post = (path, data = {}) => request(path, { method: 'POST', body: JSON.stringify(data) });
let noticeTimer;
const say = message => { clearTimeout(noticeTimer); $('#notice').textContent = message; $('#notice').hidden = false; noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 8000); };
const fail = error => {
  const message = error.message || String(error);
  say(`操作失败：${message.includes('File hash differs') ? '远端文件已被其他操作修改。草稿已保留，请重新读取文件并预览后再保存。' : message}`);
};
const activeServer = () => state.servers.find(server => server.name === state.host);
const connectionName = () => state.host || undefined;
const dirty = () => state.draft !== state.original;
const discard = () => !dirty() || window.confirm('文件有未保存修改，确定放弃这些修改吗？');
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const guarded = fn => async event => { const button = event.currentTarget; button.disabled = true; try { await fn(event); } catch (error) { fail(error); } finally { button.disabled = button.id === 'stop-session' && (!state.session || state.session.closed); } };
const labelKey = session => `ssh-session-label:${state.host}:${session.sessionName}`;
const sessionLabel = session => localStorage.getItem(labelKey(session)) || session.sessionName;

function setInput(enabled) {
  const live = Boolean(state.session && !state.session.closed);
  const context = JSON.stringify([state.host, sessionIdentity(state.session)]);
  if (context !== commandContext) {
    $('#command').value = ''; $('#command-output').textContent = ''; $('#terminal-output').textContent = '';
    commandContext = context;
  }
  if (!live) $('#command').value = '';
  state.owned = Boolean(enabled && live);
  $('#command').disabled = !state.owned;
  $('.prompt').hidden = !live;
  $('#command').placeholder = !live ? '请先新建会话' : state.owned ? '输入命令后回车' : '只读观察中';
  $('#session-mode').textContent = !live ? state.session?.closed ? '已结束' : '未创建会话' : state.owned ? '可输入' : '观察中';
  $('#session-mode').className = live ? 'blue' : 'muted';
  $('#takeover').textContent = state.owned ? '切回只读' : '启用输入';
  $('#input-owner').textContent = !live ? '新建会话后可查看输出和发送命令' : state.owned ? '多客户端共享终端，请避免同时输入' : '只读观察；启用输入后可发送命令';
  if (!state.session) $('#session-description').textContent = '持久会话';
}
function resetFile() {
  draftRevision++;
  Object.assign(state, { file: '', original: '', draft: '', hash: '', redacted: false, backup: null });
  $('#file-preview').hidden = true; $('#restore-file').hidden = true; $('#backup-path').textContent = ''; renderFile();
}
function setView(view) {
  state.view = view;
  sessionStorage.setItem('ssh-agent-view', view);
  const titles = { overview: '概览', activity: '操作记录', terminal: '终端会话', files: '文件管理', tasks: '后台任务', forwards: '端口转发' };
  $('#page-title').textContent = titles[view];
  $$('.nav button').forEach(button => button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false'));
  $$('.view').forEach(panel => { panel.hidden = panel.id !== `view-${view}`; });
  $('#host-bar').hidden = ['overview', 'activity'].includes(view); $('#details').hidden = true;
  refreshView().catch(fail);
}
async function refreshView() {
  if (!state.host) return;
  if (state.view === 'terminal') await loadSessions();
  if (state.view === 'files') await loadFiles(state.directory);
  if (state.view === 'tasks') await loadTasks();
  if (state.view === 'forwards') await loadForwards();
}
// Keep button nodes stable while polling so keyboard focus and pointer presses survive.
function reconcileButtons(container, items, keyOf, create, update) {
  const keys = new Set(items.map(keyOf));
  const existing = new Map([...container.children].map(node => [node.dataset.key, node]));
  for (const child of [...container.children]) if (!keys.has(child.dataset.key)) child.remove();
  items.forEach((item, index) => {
    const key = keyOf(item), button = existing.get(key) || create(key);
    button.dataset.key = key; update(button, item);
    if (container.children[index] !== button) container.insertBefore(button, container.children[index] || null);
  });
}
function renderServers() {
  const visible = state.servers.filter(server => server.name.toLowerCase().includes($('#server-search').value.toLowerCase()));
  $('#side-server-count').textContent = state.servers.length;
  $('#server-no-match').hidden = visible.length > 0;
  reconcileButtons($('#servers'), visible, server => server.name, name => {
    const button = document.createElement('button'); button.className = 'server'; button.title = name;
    button.addEventListener('click', guarded(() => chooseHost(name))); return button;
  }, (button, server) => {
    button.setAttribute('aria-pressed', String(server.name === state.host));
    const content = `<i class="dot ${server.connected ? 'connected' : ''}"></i><span>${escapeHtml(server.name)}<small>${server.connected ? '已连接' : '未连接'}</small></span>`;
    if (button.innerHTML !== content) button.innerHTML = content;
  });
  $('#server-count').textContent = `${state.servers.length} 台已导入`;
  $('#connected-count').textContent = `${state.servers.filter(server => server.connected).length} 台已连接`;
  const server = activeServer();
  $('#host-name').textContent = server?.name || '未选择服务器';
  $('#host-address').textContent = server ? `${server.username}@${server.host}:${server.port}` : '';
  $('#env-tag').textContent = server?.name.toLowerCase().includes('prod') ? '生产环境' : 'SSH 主机';
  $('#env-tag').classList.toggle('prod', Boolean(server?.name.toLowerCase().includes('prod')));
  $('#connection-label').textContent = server?.connected ? '已连接' : '未连接';
  $('#connection-label').className = server?.connected ? 'blue' : 'muted';
  $('#connect').hidden = Boolean(server?.connected);
  $('#disconnect').hidden = !server?.connected;
  $('#reconnect').textContent = server?.connected ? '重新连接' : '连接';
  $('#connection-dot').classList.toggle('connected', Boolean(server?.connected));
  $('#detail-status').textContent = server?.connected ? 'SSH 连接已建立' : '尚未连接';
  $('#detail-source').textContent = server?.source || '—'; $('#detail-backend').textContent = server?.backend || '—';
}
async function chooseHost(name) {
  if (name !== state.host) {
    if (!discard()) return;
    state.epoch++; state.host = name; sessionStorage.setItem('ssh-agent-host', name); state.session = null; state.sessions = []; setInput(false); resetFile();
    state.directory = sessionStorage.getItem(`ssh-agent-directory:${name}`) || activeServer()?.initialPath || '.'; $('#diagnosis').textContent = ''; renderSessions();
    $('#terminal-output').textContent = ''; $('#file-list').replaceChildren(); $('#task-list').replaceChildren(); $('#forward-list').replaceChildren();
  }
  renderServers();
  const epoch = state.epoch;
  await post('/connect', { connectionName: name });
  if (epoch !== state.epoch) return;
  await loadServers();
  if (state.view === 'overview') setView('terminal'); else await refreshView();
  say(`已连接到 ${name}`);
}
let serverRequest = 0;
async function loadServers() {
  const sequence = ++serverRequest;
  const data = await request('/servers'); if (sequence !== serverRequest) return; state.servers = data.servers || []; state.defaultHost = data.defaultConnectionName;
  if (!state.servers.some(server => server.name === state.host)) {
    const saved = sessionStorage.getItem('ssh-agent-host');
    state.host = state.servers.some(server => server.name === saved) ? saved : data.defaultConnectionName || state.servers[0]?.name || '';
    sessionStorage.setItem('ssh-agent-host', state.host); state.epoch++;
    state.directory = sessionStorage.getItem(`ssh-agent-directory:${state.host}`) || activeServer()?.initialPath || '.'; state.session = null; setInput(false); resetFile();
  }
  renderServers(); activityPanel.setServers(state.servers);
}
function renderSessions() {
  setInput(state.owned);
  reconcileButtons($('#session-tabs'), state.sessions, session => session.sessionName, name => {
    const button = document.createElement('button'); button.className = 'outline';
    button.addEventListener('click', () => {
      const session = state.sessions.find(item => item.sessionName === name); if (!session) return;
      $('#rename-row').hidden = true; state.session = session;
      sessionStorage.setItem(`ssh-agent-session:${state.host}`, name); setInput(false); renderSessions(); readSession().catch(fail);
    }); return button;
  }, (button, session) => {
    const label = sessionLabel(session); if (button.textContent !== label) button.textContent = label;
    button.setAttribute('aria-pressed', String(state.session?.sessionName === session.sessionName));
  });
  if (!state.sessions.length) $('#session-tabs').innerHTML = '<span class="muted">暂无持久会话，请新建一个</span>';
  for (const id of ['takeover', 'rename-session', 'stop-session']) $(`#${id}`).disabled = !state.session || state.session.closed;
  if (!state.session) $('#rename-row').hidden = true;
}
let sessionRequest = 0;
async function loadSessions() {
  const epoch = state.epoch, sequence = ++sessionRequest, sessions = await request('/sessions');
  if (epoch !== state.epoch || sequence !== sessionRequest) return;
  state.sessions = sessions.filter(session => !session.closed && (session.connectionName || state.defaultHost) === state.host);
  const previous = sessionIdentity(state.session);
  state.session = selectSession(state.sessions, state.session, sessionStorage.getItem(`ssh-agent-session:${state.host}`));
  if (state.session) sessionStorage.setItem(`ssh-agent-session:${state.host}`, state.session.sessionName);
  if (previous !== sessionIdentity(state.session)) { $('#rename-row').hidden = true; setInput(false); }
  renderSessions();
  if (state.session) await readSession(); else $('#terminal-output').textContent = '当前没有持久会话。点击“＋ 新建”开始。';
}
const terminalBuffers = new Map(), terminalReads = new Set();
async function readSession() {
  if (!state.session) return;
  const session = state.session, epoch = state.epoch, identity = sessionIdentity(session);
  const key = JSON.stringify([state.host, identity]);
  if (terminalReads.has(key)) return;
  terminalReads.add(key);
  try {
    const previous = terminalBuffers.get(key);
    const start = previous?.offset ?? Math.max(0, (session.nextOffsetChars || 0) - 65536);
    const result = await request(`/sessions/${encodeURIComponent(session.sessionName)}/read?offset=${start}&maxChars=65536`);
    const next = terminalChunk(previous, result, start); terminalBuffers.set(key, next);
    if (terminalBuffers.size > 20) for (const cached of terminalBuffers.keys()) { if (cached !== key) { terminalBuffers.delete(cached); break; } }
    if (epoch !== state.epoch || sessionIdentity(state.session) !== identity) return;
    const panel = $('.terminal'), follow = panel.scrollHeight-panel.scrollTop-panel.clientHeight < 60;
    const output = terminalText(next.text) || (result.closed ? '会话已结束。' : '（暂无输出）');
    if ($('#terminal-output').textContent !== output) $('#terminal-output').textContent = output;
    if (follow) panel.scrollTop = panel.scrollHeight;
    $('#session-description').textContent = `${sessionLabel(session)} · ${session.cols || 120} × ${session.rows || 30}`;
    if (result.closed) { session.closed = true; setInput(false); $('#session-mode').textContent = '已结束'; renderSessions(); }
  } finally { terminalReads.delete(key); }
}
async function createSession() {
  if (!state.host) throw new Error('请先选择服务器');
  const epoch = state.epoch;
  const session = await post('/sessions/start', { sessionName: `工作会话-${crypto.randomUUID().slice(0, 8)}`, connectionName: connectionName(), cols: 120, rows: 30 });
  if (epoch !== state.epoch) return;
  state.sessions.unshift(session); state.session = session; sessionStorage.setItem(`ssh-agent-session:${state.host}`, session.sessionName); setInput(false); renderSessions(); await readSession(); say('已创建持久终端会话');
}
function renderFile() {
  if ($('#file-content').value !== state.draft) $('#file-content').value = state.draft;
  $('#file-name').textContent = state.file.split('/').pop() || '选择文件'; $('#file-name').title = state.file; $('#edit-state').textContent = dirty() ? '未保存' : '未修改';
  $('#file-content').disabled = !state.file; $('#file-content').readOnly = !!state.redacted; $('#file-actions').hidden = !state.file || state.redacted || !dirty();
  if (state.redacted) $('#edit-state').textContent = '含已隐藏的敏感值，只读';
}
let directoryRequest = 0, fileRequest = 0;
async function loadFiles(path) {
  const epoch = state.epoch, sequence = ++directoryRequest;
  const result = await request(`/files?path=${encodeURIComponent(path)}&hidden=true&connectionName=${encodeURIComponent(state.host)}`);
  if (epoch !== state.epoch || sequence !== directoryRequest) return;
  state.directory = result.resolvedPath || path; sessionStorage.setItem(`ssh-agent-directory:${state.host}`, state.directory); $('#file-path').textContent = state.directory; $('#directory-input').value = state.directory;
  $('#file-list').replaceChildren(...(result.entries || []).map(entry => {
    const button = document.createElement('button'); button.textContent = `${entry.type === 'directory' ? '▾ ' : entry.type === 'symlink' ? '↗ ' : ''}${entry.name}`;
    const fullPath = `${state.directory.replace(/\/$/, '')}/${entry.name}`;
    button.dataset.path = fullPath; button.setAttribute('aria-pressed', String(state.file === fullPath));
    button.title = fullPath;
    button.addEventListener('click', guarded(() => entry.type === 'directory' ? loadFiles(fullPath) : loadFile(fullPath))); return button;
  }));
  if (!result.entries?.length) $('#file-list').innerHTML = '<span class="muted">目录为空</span>';
  if (result.truncated) say('目录超过 500 项，仅显示前 500 项。');
}
async function loadFile(path, force = false) {
  if (!force && !discard()) return;
  const epoch = state.epoch, sequence = ++fileRequest, revision = draftRevision;
  const result = await request(`/file?path=${encodeURIComponent(path)}&connectionName=${encodeURIComponent(state.host)}`);
  if (epoch !== state.epoch || sequence !== fileRequest) return;
  if (revision !== draftRevision) { say('读取期间文件有新修改，草稿已保留；请保存后重新打开文件。'); return; }
  resetFile(); Object.assign(state, { file: path, original: result.content, draft: result.content, hash: result.sha256, redacted: !!result.redacted }); renderFile();
  $$('#file-list button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.path === path)));
}
let taskRequest = 0, forwardRequest = 0;
async function loadTasks() {
  const epoch = state.epoch, host = state.host, sequence = ++taskRequest;
  const result = await request(`/jobs?connectionName=${encodeURIComponent(host)}`);
  if (epoch !== state.epoch || sequence !== taskRequest) return;
  const jobs = parseJobs(result.output), label = {running:'运行中',starting:'启动中',exited:'已结束',killed:'已停止',lost:'状态丢失'};
  const rows = jobs.map(job => {
    const row = document.createElement('div'); row.className = 'forward-row';
    row.innerHTML = `<span><strong>${escapeHtml(job.command || job.id)}</strong><small>${escapeHtml(job.id)} · ${label[job.state]}${job.exitCode!==undefined ? ` · 退出码 ${job.exitCode}` : ''}</small></span>`;
    if (['running','starting'].includes(job.state)) {
      const button = document.createElement('button'); button.className = 'outline'; button.textContent = '停止任务'; button.setAttribute('aria-label', `停止任务 ${job.id}`);
      button.addEventListener('click', guarded(async () => { await post('/jobs/kill', { jobId: job.id, connectionName: host }); if (host === state.host) await loadTasks(); })); row.append(button);
    }
    return row;
  });
  if (!rows.length) { const empty = document.createElement('span'); empty.className = 'muted'; empty.textContent = result.paused ? '尚未连接，任务状态刷新已暂停；已有远端任务不受影响。点击「连接」后查看。' : '暂无后台任务，可让 AI 启动一个任务。'; rows.push(empty); }
  $('#task-list').replaceChildren(...rows);
}
async function loadForwards() {
  const epoch = state.epoch, sequence = ++forwardRequest, result = await request('/forwards'); if (epoch !== state.epoch || sequence !== forwardRequest) return;
  const rows = result.filter(forward => (forward.connectionName || state.defaultHost) === state.host).map(forward => {
    const row = document.createElement('div'); row.className = 'forward-row';
    row.innerHTML = `<span><strong>${forward.direction === 'remote' ? '远端 → 本机' : '本机 → 远端'} · ${escapeHtml(forward.localHost || forward.bindHost)}:${forward.localPort} ↔ ${escapeHtml(forward.remoteHost || forward.bindHost)}:${forward.remotePort}</strong><small>${escapeHtml(forward.connectionName || state.host)}</small></span><button class="outline">停止转发</button>`;
    row.querySelector('button').addEventListener('click', guarded(async () => { await post('/forwards/stop', { forwardId: forward.forwardId }); await loadForwards(); })); return row;
  });
  if (!rows.length) { const empty = document.createElement('span'); empty.className = 'muted'; empty.textContent = '暂无端口转发'; rows.push(empty); }
  $('#forward-list').replaceChildren(...rows);
}
function editData() { return { remotePath: state.file, content: state.draft, expectedSha256: state.hash, connectionName: state.host, backup: $('#backup-file').checked }; }
async function previewFile() {
  const data = editData(), epoch = state.epoch;
  await post('/file/edit', { ...data, dryRun: true });
  if (epoch !== state.epoch || data.remotePath !== state.file || data.content !== state.draft) return;
  $('#before-file').textContent = state.original; $('#after-file').textContent = state.draft; $('#file-preview').hidden = false;
}
async function applyFile() {
  const data = editData(), epoch = state.epoch;
  const result = await post('/file/edit', data);
  if (epoch !== state.epoch || data.remotePath !== state.file || data.expectedSha256 !== state.hash) return;
  state.original = data.content; state.hash = result.afterSha256; state.backup = result.backupPath || null;
  $('#backup-path').textContent = state.backup ? `备份：${state.backup}` : ''; $('#restore-file').hidden = !state.backup;
  $('#file-preview').hidden = true; renderFile(); say('文件版本校验通过，修改已保存。');
}
async function restoreFile() {
  if (!state.backup || !discard()) return;
  const epoch = state.epoch, path = state.file, hash = state.hash, host = state.host, revision = draftRevision;
  const backup = await request(`/file?path=${encodeURIComponent(state.backup)}&connectionName=${encodeURIComponent(host)}`);
  if (backup.redacted) throw new Error('备份包含已隐藏的敏感值，不能将隐藏后的内容写回文件。');
  const result = await post('/file/edit', { remotePath: path, content: backup.content, expectedSha256: hash, backup: true, connectionName: host });
  if (epoch !== state.epoch || state.file !== path || state.hash !== hash) return;
  state.original = backup.content; state.hash = result.afterSha256; state.backup = result.backupPath || null;
  if (revision === draftRevision) { state.draft = backup.content; draftRevision++; }
  $('#backup-path').textContent = state.backup ? `备份：${state.backup}` : ''; $('#restore-file').hidden = !state.backup;
  $('#file-preview').hidden = true; renderFile(); say(dirty() ? '远端已恢复备份；恢复期间的新草稿已保留。' : '已恢复上次备份');
}
$$('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
$('#import-config').addEventListener('click', guarded(async () => { if (!discard()) return; await post('/config/reload'); state.epoch++; state.session = null; setInput(false); resetFile(); await loadServers(); await refreshView(); say('已重新读取启动配置；独立持久会话保留原配置。'); }));
$('#import-main').addEventListener('click', () => $('#import-config').click());
$('#connection-details').addEventListener('click', () => { $('#details').hidden = !$('#details').hidden; });
$('#close-details').addEventListener('click', () => { $('#details').hidden = true; });
$('#diagnose').addEventListener('click', guarded(async () => { const epoch = state.epoch; const result = await post('/diagnose', { connectionName: state.host }); if (epoch !== state.epoch) return; $('#diagnosis').textContent = `${result.ok ? '诊断通过' : '诊断未通过'} · ${result.elapsedMs} ms\n${JSON.stringify(result.checks, null, 2)}`; await loadServers(); }));
$('#connect').addEventListener('click', guarded(() => chooseHost(state.host)));
$('#disconnect').addEventListener('click', guarded(async () => {
  const host = state.host, epoch = state.epoch;
  await post('/disconnect', { connectionName: host });
  await loadServers();
  if (epoch === state.epoch) {
    state.session = null; setInput(false);
    await loadSessions();
    if (state.view === 'tasks') await loadTasks();
    if (state.view === 'forwards') await loadForwards();
  }
  say(`已断开 ${host}，终端和转发已关闭；远端后台任务继续运行。`);
}));
$('#reconnect').addEventListener('click', guarded(async () => { const host = state.host; await post('/reconnect', { connectionName: host }); await loadServers(); say(`已重新建立 ${host} 的 SSH 连接；原转发随旧连接关闭。`); }));
$('#new-session').addEventListener('click', guarded(createSession));
$('#stop-session').addEventListener('click', guarded(async () => { if (!state.session) return; const session = state.session, epoch = state.epoch, key = JSON.stringify([state.host, sessionIdentity(state.session)]); await post(`/sessions/${encodeURIComponent(session.sessionName)}/stop`); terminalBuffers.delete(key); if (epoch !== state.epoch) return; if (state.session?.sessionName === session.sessionName) { state.session = null; setInput(false); } await loadSessions(); }));
$('#refresh-files').addEventListener('click', guarded(() => loadFiles(state.directory)));
$('#parent-directory').addEventListener('click', guarded(() => loadFiles(state.directory.replace(/\/[^/]+\/?$/, '') || '/')));
$('#directory-input').addEventListener('keydown', event => { if (event.key === 'Enter') loadFiles(event.target.value).catch(fail); });
$('#upload-file').addEventListener('click', () => $('#upload-input').click());
$('#upload-input').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  const host = state.host, directory = state.directory, epoch = state.epoch;
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error('文本上传最大支持 4 MiB');
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
    if (content.includes('\0')) throw new Error('请选择 UTF-8 文本文件，二进制文件请使用 MCP 传输工具');
    await post('/file/create', { remotePath: `${directory.replace(/\/$/, '')}/${file.name}`, content, connectionName: host });
    if (epoch === state.epoch) { say(`已上传 ${file.name}`); if (directory === state.directory) await loadFiles(directory); }
  } catch (error) { fail(error); } finally { event.target.value = ''; }
});
$('#file-content').addEventListener('input', event => { draftRevision++; state.draft = event.target.value; $('#file-preview').hidden = true; renderFile(); });
$('#preview-file').addEventListener('click', guarded(previewFile));
$('#back-edit').addEventListener('click', () => { $('#file-preview').hidden = true; });
$('#apply-file').addEventListener('click', guarded(applyFile)); $('#restore-file').addEventListener('click', guarded(restoreFile));
$('#refresh-tasks').addEventListener('click', guarded(loadTasks)); $('#refresh-forwards').addEventListener('click', guarded(loadForwards));
$('#takeover').addEventListener('click', () => setInput(!state.owned));
$('#command').addEventListener('keydown', async event => {
  if (event.key !== 'Enter' || !state.session || !state.owned || event.isComposing) return;
  event.preventDefault(); const input = event.target.value, session = state.session; event.target.value = '';
  try { await post(`/sessions/${encodeURIComponent(session.sessionName)}/write`, { input: `${input}\n` }); await readSession(); } catch (error) { fail(error); }
});
$('#rename-session').addEventListener('click', () => { $('#rename-row').hidden = false; $('#session-name').value = sessionLabel(state.session); $('#session-name').focus(); });
$('#save-name').addEventListener('click', () => { if (!state.session) return; localStorage.setItem(labelKey(state.session), $('#session-name').value.trim()); $('#rename-row').hidden = true; renderSessions(); say('已保存此浏览器中的显示名称，会话标识保持不变。'); });
window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
let lastViewSync = 0, syncBusy = false;
async function syncWorkbench() {
  if (syncBusy || document.hidden || authenticationNeeded) return;
  syncBusy = true;
  try {
    await loadServers();
    if (state.view === 'terminal' && !$('#rename-row').contains(document.activeElement)) await loadSessions();
    else if (state.view === 'tasks') await loadTasks();
    else if (state.view === 'forwards') await loadForwards();
    lastViewSync = Date.now();
  } finally { syncBusy = false; }
}
setInterval(async () => {
  if (document.hidden || pollBusy || authenticationNeeded) return;
  pollBusy = true;
  try {
    if (state.view === 'terminal' && state.session) {
      try { await readSession(); }
      catch { await loadSessions(); } // A worker may have exited or restarted under the same name.
    }
    if (Date.now()-lastViewSync > 5000 && !$('#rename-row').contains(document.activeElement)) await syncWorkbench();
  } catch (error) { if (state.view === 'terminal') setInput(false); fail(error); }
  finally { pollBusy = false; }
}, 1000);
$('#server-search').addEventListener('input', renderServers);
const navigationIcons = {
  overview:'<path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/>',
  activity:'<path d="M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01"/>',
  terminal:'<path d="m4 6 6 6-6 6m9 0h7"/>',
  files:'<path d="M3 6h7l2 3h9v11H3Z"/>',
  tasks:'<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m10 8 6 4-6 4Z"/>',
  forwards:'<path d="M3 8h18m-5-5 5 5-5 5M21 16H3m5-5-5 5 5 5"/>',
};
$$('.nav button').forEach(button => {
  button.firstChild.remove();
  button.insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${navigationIcons[button.dataset.view]}</svg>`);
});
const narrowSidebar = matchMedia('(max-width:560px)');
$('.server-section').open = !narrowSidebar.matches;
narrowSidebar.addEventListener('change', event => { $('.server-section').open = !event.matches; });
loadServers().then(() => {
  const saved = sessionStorage.getItem('ssh-agent-view');
  setView(Object.hasOwn(navigationIcons, saved) ? saved : 'overview'); activityPanel.start();
}).catch(fail);

$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  bearer = $('#auth-token').value.trim();
  sessionStorage.setItem('ssh-agent-mcp-token', bearer);
  try {
    await loadServers(); authenticationNeeded = false; $('#auth-form').hidden = true; $('#auth-token').value = '';
    await refreshView(); activityPanel.start();
  } catch (error) { fail(error); }
});

// Launching the same workbench URL may be a fragment-only navigation in an existing tab.
window.addEventListener('hashchange', async () => {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (!token) return;
  bearer = token; sessionStorage.setItem('ssh-agent-mcp-token', bearer);
  history.replaceState(null, '', location.pathname + location.search);
  try {
    await loadServers(); authenticationNeeded = false; $('#auth-form').hidden = true; $('#auth-token').value = '';
    await refreshView(); activityPanel.controller?.abort(); activityPanel.start();
  } catch (error) { fail(error); }
});
