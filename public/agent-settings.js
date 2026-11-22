const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const pageKind = document.body.dataset.settingsPage;
const state = { snapshot: null, roles: {}, editing: null, loading: false, saving: false, rolesDirty: false, editorDirty: false, navigationApproved: false };
const providerFields = provider => Object.fromEntries(['id', 'name', 'baseUrl', 'model', 'jsonMode', 'thinking', 'pricing'].map(key => [key, provider[key]]));

function message(selector, text = '') {
  const element = $(selector); if (!element) return;
  element.textContent = text; element.hidden = !text;
}
function dirty() {
  state.rolesDirty = Object.entries(state.roles).some(([role, provider]) => state.snapshot.roles[role] !== provider);
  if ($('#agent-settings-save-state')) $('#agent-settings-save-state').textContent = state.rolesDirty ? '有未保存的角色分配' : `已应用配置版本 ${state.snapshot.revision}`;
  message('#agent-settings-notice');
}
function roleOptions(selected) {
  const { environment, providers } = state.snapshot;
  return `<option value="env"${selected === 'env' ? ' selected' : ''}>环境默认${environment.configured ? ` / ${escape(environment.model)}` : '（尚未配置）'}</option>`
    + providers.map(provider => `<option value="${escape(provider.id)}"${provider.id === selected ? ' selected' : ''}>${escape(provider.name)} / ${escape(provider.model)}</option>`).join('');
}
function render() {
  const snapshot = state.snapshot, environment = snapshot.environment;
  $('#environment-status').textContent = environment.configured ? environment.model : '尚未配置';
  $('.settings-status-dot').dataset.configured = String(environment.configured === true);
  if (pageKind === 'agents') {
    $('#agent-role-bindings').innerHTML = snapshot.roleDefinitions.map(role => `<div class="settings-role"><div><label for="agent-role-${escape(role.id)}">${escape(role.label)}</label><p id="agent-role-description-${escape(role.id)}">${escape(role.description)}</p></div><select id="agent-role-${escape(role.id)}" data-agent-role="${escape(role.id)}" aria-describedby="agent-role-description-${escape(role.id)}">${roleOptions(state.roles[role.id])}</select></div>`).join('');
    $('#agent-settings-form').hidden = false;
    $('#agent-settings-save-state').textContent = `已应用配置版本 ${snapshot.revision}`;
  } else {
    $('#api-services-section').hidden = false;
    $('#provider-count').textContent = snapshot.providers.length;
    $('#agent-providers-empty').hidden = snapshot.providers.length > 0;
    $('#agent-providers').innerHTML = snapshot.providers.map(provider => {
      const used = Object.values(snapshot.roles).filter(id => id === provider.id).length;
      return `<div class="settings-provider-row" data-provider-id="${escape(provider.id)}"><div><strong>${escape(provider.name)}</strong><p>${escape(provider.baseUrl)}</p></div><div class="settings-provider-model">${escape(provider.model)}<small>${provider.hasKey ? '密钥已设置' : '密钥未设置'} · ${used ? `${used} 个角色使用` : '尚未分配角色'}</small></div><div class="settings-provider-actions"><button type="button" data-edit-provider aria-label="编辑 ${escape(provider.name)}">编辑</button><button type="button" data-delete-provider aria-label="删除 ${escape(provider.name)}">删除</button></div><p class="settings-provider-error" data-provider-error role="alert" hidden></p></div>`;
    }).join('');
  }
}
function accept(value) {
  // The API returns only public metadata. Each page retains the other page's
  // fields from this exact revision so the CAS rejects cross-page overwrites.
  state.snapshot = value;
  state.roles = { ...value.roles };
  state.rolesDirty = false; state.editorDirty = false;
  render();
}
function setBusy() {
  const busy = state.loading || state.saving;
  $('#reload-agent-settings').disabled = busy;
  for (const selector of ['#agent-settings-fields', '#provider-fields', '#save-agent-settings', '#save-provider', '#add-agent-provider']) {
    const element = $(selector); if (element) element.disabled = busy || state.snapshot === null;
  }
  for (const button of document.querySelectorAll('[data-edit-provider], [data-delete-provider], [data-close-provider]')) button.disabled = busy;
  for (const selector of ['#save-agent-settings', '#save-provider']) {
    const element = $(selector); if (element) element.textContent = state.saving ? '正在保存…' : '保存并应用';
  }
}
async function request(method, body) {
  let response;
  try { response = await fetch('/api/agent-settings', { method, headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) }); }
  catch { throw new Error('无法连接本机工作台。请检查服务后重试，当前填写内容仍保留。'); }
  let result;
  try { result = await response.json(); }
  catch { throw new Error('服务返回了无法读取的结果。请检查当前服务版本，当前填写内容仍保留。'); }
  if (!response.ok) {
    let text = typeof result.error === 'string' ? result.error : result.error?.message || result.message || '配置未能保存。';
    if (response.status === 401 || response.status === 403) text = '请使用本机工作台的负责人账号配置 API。可先到「团队账号」登录，再返回重试。';
    if (response.status === 409) text += ' 当前修改仍保留。请关闭编辑并重新载入最新配置，再核对本次修改；其他页面的保存不会被覆盖。';
    throw Object.assign(new Error(text), { status: response.status });
  }
  return result;
}
async function load() {
  if (state.loading || state.saving) return;
  state.loading = true; setBusy(); message('#agent-settings-error');
  try { accept(await request('GET')); message('#agent-settings-notice'); }
  catch (error) { message('#agent-settings-error', error.message); message('#agent-settings-notice'); }
  finally { state.loading = false; setBusy(); }
}
function payload(providers, roles) {
  return { revision: state.snapshot.revision, providers, roles: { ...roles } };
}

$('#agent-role-bindings')?.addEventListener('change', event => {
  const role = event.target.dataset.agentRole; if (!role) return;
  state.roles[role] = event.target.value; dirty();
});
$('#agent-settings-form')?.addEventListener('submit', async event => {
  event.preventDefault(); if (state.loading || state.saving) return;
  const body = payload(state.snapshot.providers.map(providerFields), state.roles);
  state.saving = true; setBusy(); message('#agent-settings-error'); message('#agent-settings-notice');
  try { accept(await request('PUT', body)); message('#agent-settings-notice', '角色分配已保存并应用。后续调用将使用所选服务。'); }
  catch (error) { message('#agent-settings-error', error.message); $('#agent-settings-error').scrollIntoView({ block: 'nearest' }); }
  finally { state.saving = false; setBusy(); }
});

function openProvider(id, returnTarget) {
  if (!state.snapshot || state.loading || state.saving) return;
  const provider = id ? state.snapshot.providers.find(item => item.id === id) : null;
  if (id && !provider) return;
  if (!provider && state.snapshot.providers.length >= 30) { message('#agent-settings-error', '最多添加 30 个 API 服务。'); return; }
  state.editing = { id: provider?.id || crypto.randomUUID(), existing: !!provider, returnTarget, pricingEdited: false };
  state.editorDirty = false;
  $('#provider-dialog-heading').textContent = provider ? '编辑 API 服务' : '添加 API 服务';
  $('#provider-name').value = provider?.name || '';
  $('#provider-url').value = provider?.baseUrl || '';
  $('#provider-model').value = provider?.model || '';
  $('#provider-key').value = '';
  $('#provider-key').placeholder = provider?.hasKey ? '已设置；留空保留' : '本机服务可留空';
  $('#provider-key-note').textContent = provider?.hasKey ? '已有密钥不会回填；留空保留，填写新密钥可替换。' : '密钥仅保存在本机服务端；本机模型服务可留空。';
  $('#provider-clear-label').hidden = !provider?.hasKey;
  $('#provider-clear').checked = false;
  $('#provider-json').value = String(provider?.jsonMode !== false);
  $('#provider-thinking').value = provider?.thinking || '';
  $('.settings-advanced').open = false;
  $('#provider-pricing').open = !!provider?.pricing;
  $('#provider-currency').value = provider?.pricing?.currency ?? '';
  $('#provider-input-price').value = provider?.pricing?.inputPerMillion ?? '';
  $('#provider-output-price').value = provider?.pricing?.outputPerMillion ?? '';
  message('#provider-error'); message('#agent-settings-error'); message('#agent-settings-notice');
  $('#provider-dialog').showModal(); $('#provider-name').focus();
}
$('#add-agent-provider')?.addEventListener('click', event => openProvider(null, event.currentTarget));
$('#agent-providers')?.addEventListener('click', event => {
  const row = event.target.closest('[data-provider-id]'); if (!row) return;
  if (event.target.closest('[data-edit-provider]')) openProvider(row.dataset.providerId, event.target.closest('button'));
  if (event.target.closest('[data-delete-provider]')) void deleteProvider(row.dataset.providerId);
});
for (const button of document.querySelectorAll('[data-close-provider]')) button.addEventListener('click', () => { if (!state.saving) $('#provider-dialog').close(); });
$('#provider-dialog')?.addEventListener('cancel', event => { if (state.saving) event.preventDefault(); });
$('#provider-dialog')?.addEventListener('close', () => {
  const previous = state.editing;
  $('#provider-key').value = ''; $('#provider-form').reset(); state.editing = null; state.editorDirty = false;
  if (previous?.returnTarget?.isConnected) previous.returnTarget.focus({ preventScroll: true });
  else if (previous) (document.querySelector(`[data-provider-id="${CSS.escape(previous.id)}"] [data-edit-provider]`) || $('#add-agent-provider')).focus({ preventScroll: true });
});
$('#provider-form')?.addEventListener('submit', async event => {
  event.preventDefault(); if (!state.editing || state.loading || state.saving) return;
  const values = new FormData(event.currentTarget);
  const provider = { id: state.editing.id, name: values.get('name'), baseUrl: values.get('baseUrl'), model: values.get('model'),
    jsonMode: values.get('jsonMode') === 'true', thinking: values.get('thinking'),
    ...(values.get('apiKey') ? { apiKey: values.get('apiKey') } : {}), ...(values.get('clearKey') ? { clearKey: true } : {}) };
  const currency = values.get('currency').trim().toUpperCase(), inputPrice = values.get('inputPerMillion'), outputPrice = values.get('outputPerMillion');
  if (state.editing.pricingEdited) {
    if (!currency && inputPrice === '' && outputPrice === '') provider.pricing = null;
    else if (!currency || inputPrice === '' || outputPrice === '') {
      message('#provider-error', '请同时填写货币及两项单价，或全部清空。');
      $('#provider-error').scrollIntoView({ block: 'nearest' });
      return;
    } else provider.pricing = { currency, inputPerMillion: Number(inputPrice), outputPerMillion: Number(outputPrice) };
  }
  const providers = state.snapshot.providers.map(item => item.id === provider.id ? provider : providerFields(item));
  if (!state.editing.existing) providers.push(provider);
  // API maintenance never changes role assignments, including unconfigured roles.
  const body = payload(providers, state.snapshot.roles);
  state.saving = true; setBusy(); message('#provider-error');
  try {
    accept(await request('PUT', body)); $('#provider-key').value = ''; $('#provider-dialog').close();
    message('#agent-settings-notice', 'API 服务已保存并应用，可在 Agent 角色页分配使用。');
  } catch (error) { message('#provider-error', error.message); $('#provider-error').scrollIntoView({ block: 'nearest' }); }
  finally { state.saving = false; setBusy(); }
});
$('#provider-form')?.addEventListener('input', () => { state.editorDirty = true; });
$('#provider-pricing')?.addEventListener('input', () => { if (state.editing) state.editing.pricingEdited = true; });
async function deleteProvider(id) {
  if (state.loading || state.saving) return;
  const localError = document.querySelector(`[data-provider-id="${CSS.escape(id)}"] [data-provider-error]`);
  const showDeleteError = text => {
    if (!localError) { message('#agent-settings-error', text); return; }
    localError.textContent = text; localError.hidden = !text;
    if (text) localError.scrollIntoView({ block: 'nearest' });
  };
  showDeleteError('');
  const bound = state.snapshot.roleDefinitions.filter(role => state.snapshot.roles[role.id] === id);
  if (bound.length) { showDeleteError(`此服务仍用于${bound.map(role => role.label).join('、')}。请先在「Agent 角色」更换服务并保存，再删除。`); return; }
  const providerName = state.snapshot.providers.find(provider => provider.id === id)?.name || '此服务';
  if (!window.confirm(`删除 API 服务「${providerName}」？已保存的地址、模型和访问密钥也会删除。`)) return;
  const body = payload(state.snapshot.providers.filter(provider => provider.id !== id).map(providerFields), state.snapshot.roles);
  state.saving = true; setBusy(); message('#agent-settings-error'); message('#agent-settings-notice');
  let deleted = false;
  try { accept(await request('PUT', body)); deleted = true; message('#agent-settings-notice', 'API 服务已删除。'); }
  catch (error) { showDeleteError(error.message); }
  finally { state.saving = false; setBusy(); if (deleted) $('#add-agent-provider').focus({ preventScroll: true }); }
}
$('#reload-agent-settings').addEventListener('click', () => {
  if ((state.rolesDirty || state.editorDirty) && !window.confirm('重新载入会替换尚未保存的修改。是否继续？')) return;
  void load();
});
document.addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest('a[href]');
  if (!link || link.target === '_blank' || link.hasAttribute('download') || link.getAttribute('href').startsWith('#') || !(state.rolesDirty || state.editorDirty || state.saving)) return;
  if (!window.confirm(state.saving ? '配置正在保存，离开后需重新核对保存结果。是否离开？' : '当前修改尚未保存。是否放弃修改并离开？')) { event.preventDefault(); return; }
  state.navigationApproved = true;
});
window.addEventListener('beforeunload', event => {
  if (!state.navigationApproved && (state.rolesDirty || state.editorDirty || state.saving)) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pageshow', () => { state.navigationApproved = false; });
// Browser back/forward caching must not retain a typed credential after navigation.
window.addEventListener('pagehide', () => { if ($('#provider-key')) $('#provider-key').value = ''; });
void load();
