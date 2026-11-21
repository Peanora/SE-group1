const $ = selector => document.querySelector(selector), roles = { owner: '负责人', reviewer: '评审者', observer: '观察者' };
const explanations = { owner: '可以开发、变更需求、管理成员和审阅；发布到外部仍需要独立授权。', reviewer: '可以查看项目，确认或驳回规格、计划及测试定义；开发和需求变更由负责人执行。', observer: '可以查看团队项目、报告和交付；不能启动开发或修改需求。' };
let session, busy = false, cursor = 0;
const node = (tag, text) => { const element = document.createElement(tag); if (text != null) element.textContent = text; return element; };
function note(text, error = false) { const element = $(error ? '#team-error' : '#team-notice'); element.textContent = text; element.hidden = !text; }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, cache: 'no-store', headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json().catch(() => ({})); if (!response.ok) throw Object.assign(new Error(data.error || '当前操作未确认，请刷新核对。'), { status: response.status }); return data;
}
async function perform(work) {
  if (busy) return; busy = true; note('', true); note(''); document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try { await work(); } catch (error) { note(error.message, true); if (error.status === 401) await readSession().catch(() => {}); }
  finally { busy = false; document.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
}
function render() {
  $('#team-login').hidden = !session?.enabled || !!session.user; $('#team-account').hidden = !session?.user;
  $('#team-description').textContent = !session?.enabled ? '本地单人模式正在使用。需要团队登录时，在本地配置中开启团队模式后重启服务。' : session.setupRequired ? '首次开启团队模式，请先设置负责人账号。其他成员由负责人添加。' : '团队资料仅向已登录成员开放，操作权限以服务器核对为准。';
  $('#login-title').textContent = session?.setupRequired ? '设置负责人账号' : '登录工作台'; $('#login-submit').textContent = session?.setupRequired ? '设置并登录' : '登录';
  $('#login-password').autocomplete = session?.setupRequired ? 'new-password' : 'current-password';
  if (!session?.user) return;
  $('#account-name').textContent = `${session.user.name} · ${roles[session.user.role] || '未知角色'}`; $('#account-permission').textContent = explanations[session.user.role] || '账号权限待核对。';
  $('#member-admin').hidden = session.user.role !== 'owner'; $('#team-audit').hidden = !['owner', 'reviewer'].includes(session.user.role);
}
async function readSession() {
  const previous = session?.user; session = await api('/api/team/session'); if (!session.user) $('#member-password').value = ''; render();
  if (previous && !session.user) {
    $('#members').replaceChildren(); $('#audit-list').replaceChildren(); $('#member-form').reset(); cursor = 0;
    $('#account-name').textContent = ''; $('#account-permission').textContent = ''; $('#login-password').value = ''; $('#login-name').value = previous.name; $('#login-name').focus();
  }
  return session;
}
async function members() {
  const data = await api('/api/team/members'), fragment = document.createDocumentFragment();
  for (const member of data.members) {
    const row = node('div'); row.className = 'team-member'; row.dataset.memberId = member.id; row.append(node('strong', member.name));
    const roleLabel = node('label', '角色'), select = node('select'); select.setAttribute('aria-label', `${member.name}的角色`);
    for (const [value, label] of Object.entries(roles)) { const option = node('option', label); option.value = value; select.append(option); } select.value = member.role; roleLabel.append(select);
    const enabledLabel = node('label'), active = node('input'); enabledLabel.className = 'team-enabled'; active.type = 'checkbox'; active.checked = member.active; active.setAttribute('aria-label', `启用${member.name}`); enabledLabel.append(active, node('span', '已启用'));
    const save = node('button', '保存权限'); save.type = 'button'; save.className = 'button button-outline';
    save.addEventListener('click', () => { void perform(async () => {
      const role = select.value, enabled = active.checked;
      await api(`/api/team/members/${encodeURIComponent(member.id)}`, { method: 'PATCH', body: JSON.stringify({ role, active: enabled }) });
      await readSession();
      if (session.user?.role === 'owner') { const fresh = await api('/api/team/members'); if (!fresh.members.some(item => item.id === member.id && item.role === role && item.active === enabled)) throw new Error('权限更新尚未核对，请刷新后查看。'); await members(); }
      note(session.user ? '已核对保存后的权限；该成员原有登录已失效。' : '当前账号权限已更新，请重新登录。');
    }); });
    row.append(roleLabel, enabledLabel, save); fragment.append(row);
  }
  $('#members').replaceChildren(fragment);
}
const actionNames = { 'team.setup': '设置负责人', 'team.login': '登录', 'team.login_failed': '登录失败', 'team.logout': '退出账号', 'team.member_created': '添加成员', 'team.member_updated': '更新成员权限', 'request.finished': '操作结果', 'request.denied': '拒绝越权操作' };
async function audit(reset = false) {
  if (reset) { cursor = 0; $('#audit-list').replaceChildren(); }
  const data = await api(`/api/team/audit?after=${cursor}`);
  for (const event of data.events) {
    const item = node('li'), time = node('time', new Date(event.at).toLocaleString('zh-CN')), label = actionNames[event.action] || (event.action.startsWith('request.') ? '提交操作请求' : '账号操作');
    item.append(time, node('span', `${roles[event.actor_role] || '访客'}：${label} · ${event.status === 0 ? '已受理，结果待核对' : event.status < 400 ? '已完成' : `未通过（${event.status}）`}`));
    if (event.target || event.request_id) { const detail = node('details'); detail.append(node('summary', '关联记录'), node('code', [event.target, event.request_id].filter(Boolean).join('\n'))); item.append(detail); }
    $('#audit-list').append(item);
  }
  cursor = data.cursor; $('#audit-more').hidden = data.events.length < 200;
}
$('#login-form').addEventListener('submit', event => { event.preventDefault(); void perform(async () => {
  const name = $('#login-name').value, password = $('#login-password').value;
  await api(`/api/team/${session.setupRequired ? 'setup' : 'login'}`, { method: 'POST', body: JSON.stringify({ name, password }) });
  await readSession(); if (!session.user || session.user.name !== name.normalize('NFC')) throw new Error('登录状态尚未核对，请刷新后查看，不会自动重复提交。');
  $('#login-password').value = ''; window.location.assign('/');
}); });
$('#logout').addEventListener('click', () => { void perform(async () => { await api('/api/team/logout', { method: 'POST', body: '{}' }); await readSession(); if (session.user) throw new Error('退出状态尚未核对，请刷新。'); $('#members').replaceChildren(); $('#audit-list').replaceChildren(); note('已退出当前账号。'); $('#login-name').focus(); }); });
$('#member-form').addEventListener('submit', event => { event.preventDefault(); void perform(async () => {
  const name = $('#member-name').value, password = $('#member-password').value, role = $('#member-role').value;
  const added = await api('/api/team/members', { method: 'POST', body: JSON.stringify({ name, password, role }) }), fresh = await api('/api/team/members');
  if (!fresh.members.some(item => item.id === added.member?.id && item.name === name.normalize('NFC') && item.role === role && item.active)) throw new Error('新账号状态尚未核对，请刷新成员列表，不会自动重复添加。');
  $('#member-password').value = ''; $('#member-name').value = ''; await members(); note('已核对新成员账号，请通过你选择的方式告知初始密码。');
}); });
$('#audit-refresh').addEventListener('click', () => { void perform(() => audit(true)); }); $('#audit-more').addEventListener('click', () => { void perform(() => audit()); });
try { await readSession(); if (session.user?.role === 'owner') await members(); if (['owner', 'reviewer'].includes(session.user?.role)) await audit(true); if (session.enabled && !session.user) $('#login-name').focus(); }
catch (error) { note(error.message, true); }
