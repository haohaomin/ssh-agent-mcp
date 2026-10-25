const root = document.querySelector('#app');
const base = location.pathname.replace(/\/$/, '');
const api = `${base}/api`;
const state = { view: 'overview', host: '', servers: [], sessions: [], session: null, file: '', original: '', draft: '', preview: false, owned: false };
const $ = selector => root.querySelector(selector);
const $$ = selector => [...root.querySelectorAll(selector)];
let bearer = sessionStorage.getItem('ssh-agent-mcp-token') || '';
const request = async (path, options = {}, retried = false) => {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const response = await fetch(`${api}${path}`, { ...options, headers });
  if (response.status === 401 && !retried) {
    const entered = window.prompt('此工作台启用了 HTTP token，请输入 token');
    if (entered) { bearer = entered.trim(); sessionStorage.setItem('ssh-agent-mcp-token', bearer); return request(path, options, true); }
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || `请求失败（${response.status}）`);
  return data;
};
const say = message => { $('#notice').textContent = message; $('#notice').hidden = false; };
const fail = error => say(`操作失败：${error.message || error}`);
const activeServer = () => state.servers.find(server => server.name === state.host);
const connectionName = () => state.host || undefined;

function setView(view) {
  state.view = view;
  const titles = { overview: '概览', terminal: '终端会话', files: '文件管理', tasks: '后台任务', forwards: '端口转发' };
  $('#page-title').textContent = titles[view];
  $$('.nav button').forEach(button => button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false'));
  $$('.view').forEach(panel => { panel.hidden = panel.id !== `view-${view}`; });
  $('#host-bar').hidden = view === 'overview';
  $('#details').hidden = true;
  if (view === 'terminal') loadSessions();
  if (view === 'files') loadFiles('/');
  if (view === 'tasks') loadTasks();
  if (view === 'forwards') loadForwards();
}

function renderServers() {
  $('#servers').replaceChildren(...state.servers.map(server => {
    const button = document.createElement('button');
    button.className = 'server'; button.dataset.host = server.name; button.setAttribute('aria-pressed', String(server.name === state.host));
    button.innerHTML = `<i class="dot ${server.connected ? 'connected' : ''}"></i><span>${escapeHtml(server.name)}<small>${server.connected ? '已连接' : '未连接'}</small></span>`;
    button.addEventListener('click', () => chooseHost(server.name));
    return button;
  }));
  $('#server-count').textContent = `${state.servers.length} 台已导入`;
  $('#connected-count').textContent = `${state.servers.filter(server => server.connected).length} 台已连接`;
  renderHost();
}

function renderHost() {
  const server = activeServer();
  if (!server) return;
  $('#host-name').textContent = server.name;
  $('#host-address').textContent = `${server.username}@${server.host}:${server.port}`;
  $('#env-tag').textContent = server.name.toLowerCase().includes('prod') ? '生产环境' : 'SSH 主机';
  $('#env-tag').classList.toggle('prod', server.name.toLowerCase().includes('prod'));
  $('#connection-label').textContent = server.connected ? '已连接' : '未连接';
  $('#connection-dot').classList.toggle('connected', server.connected);
  $('#detail-status').textContent = server.connected ? '已连接 · 主机状态正常' : '尚未连接';
}

async function chooseHost(name) {
  state.host = name; renderServers();
  if (state.view === 'overview') setView('terminal');
  try { await request('/connect', { method: 'POST', body: JSON.stringify({ connectionName: name }) }); await loadServers(); say(`已连接到 ${name}`); } catch (error) { fail(error); }
}

async function loadServers() {
  const data = await request('/servers'); state.servers = data.servers || [];
  if (!state.host) state.host = data.defaultConnectionName || state.servers[0]?.name || '';
  renderServers();
}

function renderSessions() {
  const tabs = $('#session-tabs'); tabs.replaceChildren();
  state.sessions.forEach((session, index) => {
    const button = document.createElement('button'); button.className = 'outline'; button.textContent = session.sessionName; button.setAttribute('aria-pressed', String(state.session?.sessionName === session.sessionName));
    button.addEventListener('click', () => { state.session = session; renderSessions(); readSession(); }); tabs.append(button);
  });
  if (!state.sessions.length) tabs.innerHTML = '<span class="muted">暂无持久会话，请新建一个</span>';
  $('#takeover').disabled = !state.session;
  $('#rename-session').disabled = !state.session;
}

async function loadSessions() {
  try { state.sessions = await request('/sessions'); state.sessions = state.sessions.filter(session => !session.closed && (!state.host || session.connectionName === state.host)); state.session = state.sessions[0] || null; renderSessions(); if (state.session) await readSession(); else $('#terminal-output').textContent = '当前没有持久会话。点击“＋ 新建”开始。'; } catch (error) { fail(error); }
}

async function readSession() {
  if (!state.session) return;
  try { const result = await request(`/sessions/${encodeURIComponent(state.session.sessionName)}/read?maxChars=65536`); $('#terminal-output').textContent = result.output || '（暂无输出）'; } catch (error) { fail(error); }
}

async function createSession() {
  try { const name = `工作会话-${state.sessions.length + 1}`; const session = await request('/sessions/start', { method: 'POST', body: JSON.stringify({ sessionName: name, connectionName: connectionName(), cols: 120, rows: 30 }) }); state.sessions = [session, ...state.sessions]; state.session = session; renderSessions(); await readSession(); say('已创建持久终端会话'); } catch (error) { fail(error); }
}

function renderFile() { $('#file-content').value = state.draft; $('#file-name').textContent = state.file || '选择文件'; $('#edit-state').textContent = state.draft === state.original ? '未修改' : '未保存'; $('#file-content').disabled = !state.file; $('#file-actions').hidden = !state.file || state.draft === state.original; }
async function loadFiles(path) {
  try { const result = await request(`/files?path=${encodeURIComponent(path)}&connectionName=${encodeURIComponent(connectionName() || '')}`); const list = $('#file-list'); list.replaceChildren(...(result.entries || []).map(entry => { const button = document.createElement('button'); button.textContent = `${entry.type === 'directory' ? '▾ ' : ''}${entry.name}`; button.addEventListener('click', () => entry.type === 'directory' ? loadFiles(`${path.replace(/\/$/, '')}/${entry.name}`) : loadFile(`${path.replace(/\/$/, '')}/${entry.name}`)); return button; })); if (!result.entries?.length) list.innerHTML = '<span class="muted">目录为空或不可访问</span>'; } catch (error) { fail(error); }
}
async function loadFile(path) { try { const result = await request(`/file?path=${encodeURIComponent(path)}&connectionName=${encodeURIComponent(connectionName() || '')}`); state.file = path; state.original = result.content || ''; state.draft = state.original; $('#file-path').textContent = path; $('#file-preview').hidden = true; renderFile(); } catch (error) { fail(error); } }
async function loadTasks() { try { const result = await request(`/jobs?connectionName=${encodeURIComponent(connectionName() || '')}`); $('#task-list').innerHTML = result.output ? `<pre>${escapeHtml(result.output)}</pre>` : '<span class="muted">暂无后台任务</span>'; } catch (error) { fail(error); } }
async function loadForwards() {
  try {
    const result = await request('/forwards');
    const rows = result.map(forward => {
      const row = document.createElement('div');
      row.className = 'forward-row';
      row.innerHTML = `<span><strong>${escapeHtml(forward.direction || 'local')} · ${escapeHtml(String(forward.localPort || forward.remotePort || ''))}</strong><small>${escapeHtml(forward.connectionName || '')}</small></span><button class="outline">停止转发</button>`;
      row.querySelector('button').addEventListener('click', async () => {
        try { await request('/forwards/stop', { method: 'POST', body: JSON.stringify({ forwardId: forward.forwardId }) }); loadForwards(); }
        catch (error) { fail(error); }
      });
      return row;
    });
    if (!rows.length) { const empty = document.createElement('span'); empty.className = 'muted'; empty.textContent = '暂无端口转发'; rows.push(empty); }
    $('#forward-list').replaceChildren(...rows);
  } catch (error) { fail(error); }
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
async function previewFile() { $('#before-file').textContent = state.original; $('#after-file').textContent = state.draft; $('#file-preview').hidden = false; }
async function applyFile() { const edit = { remotePath: state.file, edits: [{ oldText: state.original, newText: state.draft }], backup: $('#backup-file').checked, connectionName: connectionName() }; try { await request('/file/edit', { method: 'POST', body: JSON.stringify(edit) }); state.original = state.draft; $('#file-preview').hidden = true; renderFile(); say('文件版本校验通过，修改已保存。'); } catch (error) { fail(error); } }

setTimeout(() => {
$$('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
$('#import-config').addEventListener('click', () => say('配置导入由启动参数控制；重启服务后会自动读取 ~/.ssh/config。'));
$('#import-main').addEventListener('click', () => $('#import-config').click());
$('#connection-details').addEventListener('click', () => { $('#details').hidden = !$('#details').hidden; });
$('#close-details').addEventListener('click', () => { $('#details').hidden = true; });
$('#diagnose').addEventListener('click', () => { $('#diagnosis').textContent = activeServer()?.connected ? '诊断通过：连接和服务器状态正常。' : '请先连接服务器，再运行诊断。'; });
$('#reconnect').addEventListener('click', () => chooseHost(state.host));
$('#new-session').addEventListener('click', createSession);
$('#refresh-files').addEventListener('click', () => loadFiles('/'));
$('#file-content').addEventListener('input', event => { state.draft = event.target.value; renderFile(); });
$('#preview-file').addEventListener('click', previewFile);
$('#back-edit').addEventListener('click', () => { $('#file-preview').hidden = true; });
$('#apply-file').addEventListener('click', applyFile);
$('#takeover').addEventListener('click', async () => { if (!state.session) return; state.owned = !state.owned; $('#command').disabled = !state.owned; $('#command').placeholder = state.owned ? '输入命令后回车' : '只读观察中'; $('#session-mode').textContent = state.owned ? '可输入' : '观察中'; $('#input-owner').textContent = state.owned ? '输入权：你 · AI 输入已暂停' : '输入权：AI · 你正在观察'; });
$('#command').addEventListener('keydown', async event => { if (event.key !== 'Enter' || !state.session) return; event.preventDefault(); try { await request(`/sessions/${encodeURIComponent(state.session.sessionName)}/write`, { method: 'POST', body: JSON.stringify({ input: `${event.target.value}\n` }) }); event.target.value = ''; setTimeout(readSession, 120); } catch (error) { fail(error); } });
$('#rename-session').addEventListener('click', () => { $('#rename-row').hidden = false; $('#session-name').value = state.session?.sessionName || ''; $('#session-name').focus(); });
$('#save-name').addEventListener('click', () => { say('会话重命名需要重新创建持久会话；当前仅保留原会话名称。'); $('#rename-row').hidden = true; });

loadServers().catch(fail);
}, 0);
