export interface Pricing {
  currency: string;
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface ProviderInput {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  jsonMode: boolean;
  thinking: string;
  pricing?: Pricing | null;
  apiKey?: string;
  clearKey?: true;
}

export interface Provider extends Omit<ProviderInput, 'apiKey' | 'clearKey'> {
  hasKey: boolean;
}

export interface Snapshot {
  revision: number;
  providers: Provider[];
  roles: Record<string, string>;
  roleDefinitions: { id: string; label: string; description: string }[];
  environment: { configured: boolean; model: string };
}

interface SettingsUpdate {
  revision: Snapshot['revision'];
  providers: ProviderInput[];
  roles: Snapshot['roles'];
}

export type StartupReadiness =
  | { kind: 'ready' }
  | { kind: 'blocked' | 'unavailable'; reason?: string }
  | { kind: 'unknown' };

export async function requestStartupReadiness(signal: AbortSignal): Promise<StartupReadiness> {
  try {
    const response = await fetch('/api/health', { cache: 'no-store', signal });
    if (!response.ok) return { kind: 'unknown' };
    const config = (await response.json())?.automaticDelivery;
    const reason = typeof config?.reason === 'string' && config.reason.trim() ? config.reason.trim() : undefined;
    if (config?.available === false) return { kind: 'unavailable', reason };
    if (config?.available === true && config.ready === false) return { kind: 'blocked', reason };
    if (config?.available === true && config.ready === true) return { kind: 'ready' };
  } catch {
    return { kind: 'unknown' };
  }
  return { kind: 'unknown' };
}

export function providerFields({ id, name, baseUrl, model, jsonMode, thinking, pricing }: Provider): ProviderInput {
  return { id, name, baseUrl, model, jsonMode, thinking, pricing };
}

export async function requestSettings(update?: SettingsUpdate): Promise<Snapshot> {
  let response;
  try {
    response = await fetch('/api/agent-settings', update ? {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    } : undefined);
  } catch {
    throw new Error('无法连接本机工作台。请检查服务后重试，当前填写内容仍保留。');
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('服务返回了无法读取的结果。请检查当前服务版本，当前填写内容仍保留。');
  }

  if (!response.ok) {
    let message = typeof result.error === 'string'
      ? result.error
      : result.error?.message || result.message || '配置未能保存。';
    if (response.status === 401 || response.status === 403) {
      message = '请使用本机工作台的负责人账号配置 API。可先到「团队账号」登录，再返回重试。';
    }
    if (response.status === 409) {
      message += ' 当前修改仍保留。请关闭编辑并重新载入最新配置，再核对本次修改；其他页面的保存不会被覆盖。';
    }
    throw new Error(message);
  }
  return result;
}
