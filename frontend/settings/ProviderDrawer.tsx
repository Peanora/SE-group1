import { useLayoutEffect, useRef } from 'react';
import type { FormEvent, RefObject } from 'react';
import type { Provider, ProviderInput } from './api';

export interface Editor {
  id: string;
  provider?: Provider;
}

interface DrawerProps {
  editor: Editor | null;
  dialogRef: RefObject<HTMLDialogElement | null>;
  busy: boolean;
  saving: boolean;
  error: string;
  onDirty: () => void;
  onError: (message: string) => void;
  onClose: () => void;
  onSave: (provider: ProviderInput) => void;
}

function ProviderFields({ editor, busy, saving, error, onDirty, onError, onClose, onSave }: Omit<DrawerProps, 'dialogRef'>) {
  const provider = editor?.provider;
  const pricing = provider?.pricing;
  const pricingEdited = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || busy) return;
    const fields = new FormData(event.currentTarget);
    const key = String(fields.get('apiKey') ?? '');
    const input: ProviderInput = {
      id: editor.id,
      name: String(fields.get('name') ?? ''),
      baseUrl: String(fields.get('baseUrl') ?? ''),
      model: String(fields.get('model') ?? ''),
      jsonMode: fields.get('jsonMode') === 'true',
      thinking: String(fields.get('thinking') ?? ''),
    };
    if (key) input.apiKey = key;
    if (fields.has('clearKey')) input.clearKey = true;
    if (pricingEdited.current) {
      const currency = String(fields.get('currency') ?? '').trim().toUpperCase();
      const inputPrice = String(fields.get('inputPerMillion') ?? '');
      const outputPrice = String(fields.get('outputPerMillion') ?? '');
      if (!currency && !inputPrice && !outputPrice) {
        input.pricing = null;
      } else if (!currency || !inputPrice || !outputPrice) {
        onError('请同时填写货币及两项单价，或全部清空。');
        errorRef.current?.scrollIntoView({ block: 'nearest' });
        return;
      } else {
        input.pricing = { currency, inputPerMillion: Number(inputPrice), outputPerMillion: Number(outputPrice) };
      }
    }
    onSave(input);
  }

  return (
    <form id="provider-form" onSubmit={submit} onInput={onDirty}>
      <header className="settings-drawer-heading">
        <div>
          <h2 id="provider-dialog-heading">{provider ? '编辑 API 服务' : '添加 API 服务'}</h2>
          <p>兼容 Chat Completions 的模型接口</p>
        </div>
        <button type="button" className="settings-close" data-close-provider="" aria-label="关闭服务编辑" disabled={busy} onClick={onClose}>×</button>
      </header>
      <div className="settings-drawer-content">
        <p ref={errorRef} id="provider-error" className="settings-message settings-error" role="alert" hidden={!error}>{error}</p>
        <fieldset id="provider-fields" className="settings-fields" disabled={busy}>
          <legend className="settings-visually-hidden">服务配置</legend>
          <div className="settings-field">
            <label htmlFor="provider-name">服务名称</label>
            <input id="provider-name" name="name" defaultValue={provider?.name} maxLength={80} autoComplete="off" placeholder="例如：团队主模型" required />
          </div>
          <div className="settings-field">
            <label htmlFor="provider-url">API 基础地址</label>
            <input id="provider-url" name="baseUrl" type="url" defaultValue={provider?.baseUrl} maxLength={2000} autoComplete="off" spellCheck={false} placeholder="https://your-service.example/v1" aria-describedby="provider-url-note" required />
            <small id="provider-url-note">填写服务的基础地址，留出 /chat/completions 路径由工作台补齐。</small>
          </div>
          <div className="settings-field">
            <label htmlFor="provider-model">模型名称</label>
            <input id="provider-model" name="model" defaultValue={provider?.model} maxLength={200} autoComplete="off" spellCheck={false} placeholder="服务实际支持的模型名称" required />
          </div>
          <div className="settings-field">
            <label htmlFor="provider-key">API 密钥</label>
            <input id="provider-key" name="apiKey" type="password" maxLength={4096} autoComplete="new-password" spellCheck={false} placeholder={provider?.hasKey ? '已设置，留空保留' : '本机服务可留空'} aria-describedby="provider-key-note" />
            <small id="provider-key-note">{provider?.hasKey ? '留空保留已有密钥。填写新密钥可替换。' : '密钥保存在本机服务端。本机模型服务可留空。'}</small>
            {provider?.hasKey && <label id="provider-clear-label" className="settings-checkbox" htmlFor="provider-clear">
              <input id="provider-clear" name="clearKey" type="checkbox" />清除已有密钥
            </label>}
          </div>
          <details className="settings-advanced">
            <summary>接口参数</summary>
            <div className="settings-field">
              <label htmlFor="provider-json">JSON 输出</label>
              <select id="provider-json" name="jsonMode" defaultValue={String(provider?.jsonMode !== false)}>
                <option value="true">发送 JSON 模式参数</option>
                <option value="false">不发送 JSON 模式参数</option>
              </select>
            </div>
            <div className="settings-field">
              <label htmlFor="provider-thinking">思考参数</label>
              <select id="provider-thinking" name="thinking" defaultValue={provider?.thinking ?? ''}>
                <option value="">不发送</option>
                <option value="disabled">disabled</option>
                <option value="enabled">enabled</option>
              </select>
            </div>
          </details>
          <details id="provider-pricing" className="settings-advanced" open={Boolean(pricing)} onInput={() => { pricingEdited.current = true; }}>
            <summary>模型单价</summary>
            <p id="provider-pricing-note">更换模型或地址后请重新填写。留空表示未知，实际账单由服务方结算。</p>
            <div className="settings-field">
              <label htmlFor="provider-currency">货币代码</label>
              <input id="provider-currency" name="currency" maxLength={3} autoComplete="off" placeholder="CNY" defaultValue={pricing?.currency} aria-describedby="provider-pricing-note" />
            </div>
            <div className="settings-price-fields">
              <div className="settings-field">
                <label htmlFor="provider-input-price">每百万输入 token 单价</label>
                <input id="provider-input-price" name="inputPerMillion" type="number" defaultValue={pricing?.inputPerMillion} min="0" max="1000000" step="any" />
              </div>
              <div className="settings-field">
                <label htmlFor="provider-output-price">每百万输出 token 单价</label>
                <input id="provider-output-price" name="outputPerMillion" type="number" defaultValue={pricing?.outputPerMillion} min="0" max="1000000" step="any" />
              </div>
            </div>
          </details>
        </fieldset>
      </div>
      <footer className="settings-drawer-footer">
        <button type="button" className="settings-button" data-close-provider="" disabled={busy} onClick={onClose}>取消</button>
        <button id="save-provider" className="settings-button settings-primary" type="submit" disabled={busy}>{saving ? '正在保存…' : '保存并应用'}</button>
      </footer>
    </form>
  );
}

export function ProviderDrawer({ dialogRef, ...props }: DrawerProps) {
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (props.editor && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLInputElement>('#provider-name')?.focus();
    }
  }, [dialogRef, props.editor]);

  return (
    <dialog id="provider-dialog" className="settings-drawer" aria-labelledby="provider-dialog-heading" ref={dialogRef} onCancel={event => {
      event.preventDefault();
      if (!props.busy) props.onClose();
    }}>
      <ProviderFields key={props.editor?.id ?? 'closed'} {...props} />
    </dialog>
  );
}
