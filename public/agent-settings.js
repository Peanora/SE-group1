const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const state = { revision: null, providers: [], roles: {}, roleDefinitions: [], environment: {}, dirty: false, saving: false, loading: false };

function message(selector, text = '') {
  $(selector).textContent = text;
  $(selector).hidden = !text;
}

function dirty() {
  state.dirty = true;
  $('#agent-settings-save-state').textContent = '有未保存的修改';
  message('#agent-settings-notice');
}

function providerOptions(selected) {
  return `<option value="env"${selected === 'env' ? ' selected' : ''}>环境默认${state.environment.configured ? `（${escape(state.environment.model)}）` : '（尚未配置）'}</option>`
    + state.providers.map(provider => `<option value="${escape(provider.id)}"${provider.id === selected ? ' selected' : ''}>${escape(provider.name || '未命名服务')} / ${escape(provider.model || '未填模型')}</option>`).join('');
}

function updateRoleOptions() {
  for (const select of document.querySelectorAll('[data-agent-role]')) select.innerHTML = providerOptions(state.roles[select.dataset.agentRole]);
}

function renderProviders(openId) {
  $('#agent-providers-empty').hidden = state.providers.length !== 0;
  $('#agent-providers').innerHTML = state.providers.map((provider, index) => {
    const prefix = `agent-provider-${index}`;
    return `<details class="agent-provider" data-provider-id="${escape(provider.id)}"${openId === provider.id ? ' open' : ''}>
      <summary><strong data-provider-title>${escape(provider.name || '新服务')}</strong><small data-provider-summary>${escape(provider.model || '填写模型名称')} · ${provider.hasKey ? '密钥已设置' : '密钥未设置'}</small></summary>
      <div class="agent-provider-fields">
        <label for="${prefix}-name">服务名称<input id="${prefix}-name" data-field="name" value="${escape(provider.name)}" maxlength="80" required autocomplete="off" placeholder="例如：规划模型服务"></label>
        <label for="${prefix}-url">API 基础地址<input id="${prefix}-url" data-field="baseUrl" aria-label="API 基础地址" value="${escape(provider.baseUrl)}" type="url" maxlength="2000" required autocomplete="off" spellcheck="false" placeholder="https://your-service.example/v1"><small>填写基础地址，不包含 /chat/completions。</small></label>
        <label for="${prefix}-model">模型名称<input id="${prefix}-model" data-field="model" value="${escape(provider.model)}" maxlength="200" required autocomplete="off" spellcheck="false" placeholder="服务实际支持的模型名称"></label>
        <label for="${prefix}-key">API 密钥<input id="${prefix}-key" data-field="apiKey" aria-label="API 密钥" type="password" maxlength="4096" autocomplete="new-password" spellcheck="false" placeholder="${provider.hasKey ? '已设置；留空保留' : '本机服务可留空'}"><small>${provider.hasKey ? '已有密钥不会回传到页面。填写新密钥可替换。' : '远程服务需要密钥；localhost、127.0.0.1 本机服务可留空。'}</small></label>
        ${provider.hasKey ? `<label class="agent-key-clear" for="${prefix}-clear"><input id="${prefix}-clear" data-field="clearKey" type="checkbox"${provider.clearKey ? ' checked' : ''}>清除已有密钥</label>` : ''}
        <div class="agent-provider-controls">
          <label for="${prefix}-json">JSON 输出<select id="${prefix}-json" data-field="jsonMode" aria-label="JSON 输出"><option value="true"${provider.jsonMode !== false ? ' selected' : ''}>发送 JSON 模式参数</option><option value="false"${provider.jsonMode === false ? ' selected' : ''}>不发送 JSON 模式参数</option></select></label>
          <label for="${prefix}-thinking">思考参数<select id="${prefix}-thinking" data-field="thinking" aria-label="思考参数"><option value=""${!provider.thinking ? ' selected' : ''}>不发送</option><option value="disabled"${provider.thinking === 'disabled' ? ' selected' : ''}>disabled</option><option value="enabled"${provider.thinking === 'enabled' ? ' selected' : ''}>enabled</option></select></label>
        </div>
        <button class="button agent-provider-delete" type="button" data-delete-provider>删除服务</button>
      </div>
    </details>`;
  }).join('');
  // Passwords stay only in this page's draft and are never included in markup or browser storage.
  for (const details of document.querySelectorAll('[data-provider-id]')) details.querySelector('[data-field="apiKey"]').value = state.providers.find(provider => provider.id === details.dataset.providerId)?.apiKey || '';
}

function render() {
  const environment = state.environment;
  $('#environment-status').textContent = environment.configured
    ? `${environment.model}（${environment.baseUrl}）`
    : '尚未配置。添加 API 服务并分配角色后即可使用。';
  renderProviders();
  $('#agent-role-bindings').innerHTML = state.roleDefinitions.map(role => `<div class="agent-role"><label for="agent-role-${escape(role.id)}">${escape(role.label)}</label><p id="agent-role-description-${escape(role.id)}">${escape(role.description)}</p><select id="agent-role-${escape(role.id)}" data-agent-role="${escape(role.id)}" aria-describedby="agent-role-description-${escape(role.id)}">${providerOptions(state.roles[role.id])}</select></div>`).join('');
  $('#agent-settings-form').hidden = false;
  $('#agent-settings-save-state').textContent = `已应用配置版本 ${state.revision}`;
}

async function request(method, body) {
  let response;
  try {
    response = await fetch('/api/agent-settings', { method, headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch { throw new Error('无法连接本机工作台。请检查服务后重试，当前填写内容仍保留。'); }
  let result;
  try { result = await response.json(); } catch { throw new Error('服务返回了无法读取的结果。请检查当前服务版本，当前填写内容仍保留。'); }
  if (!response.ok) {
    let text = typeof result.error === 'string' ? result.error : result.error?.message || result.message || '配置未能保存。';
    if (response.status === 401 || response.status === 403) text = '请使用本机工作台的负责人账号配置 API。可先到「团队账号」登录，再返回重试。';
    if (response.status === 404) text = '当前服务尚未加载 Agent 配置接口。请重启本机工作台服务后刷新，当前填写内容仍保留。';
    if (response.status === 409) text += ' 当前修改仍保留；请核对其他页面的配置与运行状态后重试。若配置版本已变化，请重新载入后再编辑。';
    throw new Error(text);
  }
  return result;
}

function accept(value) {
  state.revision = value.revision;
  state.providers = value.providers.map(provider => ({ ...provider, apiKey: '', clearKey: false }));
  state.roles = { ...value.roles };
  state.roleDefinitions = value.roleDefinitions;
  state.environment = value.environment;
  state.dirty = false;
  render();
}

function setBusy() {
  const busy = state.loading || state.saving;
  $('#agent-settings-fields').disabled = busy;
  $('#save-agent-settings').disabled = busy;
  $('#reload-agent-settings').disabled = busy;
  $('#save-agent-settings').textContent = state.saving ? '正在保存…' : '保存并应用';
}

async function load() {
  if (state.loading || state.saving) return;
  state.loading = true; setBusy(); message('#agent-settings-error');
  try { accept(await request('GET')); message('#agent-settings-notice'); }
  catch (error) { message('#agent-settings-error', error.message); message('#agent-settings-notice'); }
  finally { state.loading = false; setBusy(); }
}

$('#agent-providers').addEventListener('input', event => {
  const field = event.target.dataset.field;
  if (!field) return;
  const details = event.target.closest('[data-provider-id]');
  const provider = state.providers.find(item => item.id === details.dataset.providerId);
  if (!provider) return;
  provider[field] = field === 'clearKey' ? event.target.checked : field === 'jsonMode' ? event.target.value === 'true' : event.target.value;
  if (field === 'name') details.querySelector('[data-provider-title]').textContent = provider.name || '新服务';
  if (field === 'model') details.querySelector('[data-provider-summary]').textContent = `${provider.model || '填写模型名称'} · ${provider.hasKey ? '密钥已设置' : '密钥未设置'}`;
  if (field === 'name' || field === 'model') updateRoleOptions();
  dirty();
});

$('#agent-role-bindings').addEventListener('change', event => {
  if (!event.target.dataset.agentRole) return;
  state.roles[event.target.dataset.agentRole] = event.target.value; dirty();
});

$('#add-agent-provider').addEventListener('click', () => {
  if (state.providers.length >= 30) { message('#agent-settings-error', '最多添加 30 个 API 服务。'); return; }
  const id = crypto.randomUUID();
  state.providers.push({ id, name: '', baseUrl: '', model: '', apiKey: '', hasKey: false, jsonMode: true, thinking: '', clearKey: false });
  renderProviders(id); updateRoleOptions(); dirty(); message('#agent-settings-error');
  document.querySelector(`[data-provider-id="${id}"] [data-field="name"]`).focus();
});

$('#agent-providers').addEventListener('click', event => {
  if (!event.target.closest('[data-delete-provider]')) return;
  const details = event.target.closest('[data-provider-id]'), id = details.dataset.providerId;
  const bound = state.roleDefinitions.filter(role => state.roles[role.id] === id);
  if (bound.length) { message('#agent-settings-error', `此服务仍用于${bound.map(role => role.label).join('、')}。请先在「角色分工」更换服务，再删除。`); return; }
  state.providers = state.providers.filter(provider => provider.id !== id);
  renderProviders(); updateRoleOptions(); dirty(); message('#agent-settings-error'); $('#add-agent-provider').focus();
});

$('#agent-settings-form').addEventListener('invalid', event => { const details = event.target.closest('details'); if (details) details.open = true; }, true);
$('#agent-settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.loading || state.saving) return;
  const payload = { revision: state.revision, providers: state.providers.map(({ id, name, baseUrl, model, apiKey, clearKey, jsonMode, thinking }) => ({
    id, name, baseUrl, model, jsonMode, thinking, ...(apiKey ? { apiKey } : {}), ...(clearKey ? { clearKey: true } : {}),
  })), roles: { ...state.roles } };
  state.saving = true; setBusy(); message('#agent-settings-error'); message('#agent-settings-notice');
  try { accept(await request('PUT', payload)); message('#agent-settings-notice', '配置已保存并应用。后续模型调用将使用所选服务。'); }
  catch (error) { message('#agent-settings-error', error.message); }
  finally { state.saving = false; setBusy(); }
});
$('#reload-agent-settings').addEventListener('click', () => { void load(); });
void load();
