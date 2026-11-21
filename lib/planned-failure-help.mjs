function firstBrowserFailures(report) {
  return ['DESKTOP', 'MOBILE'].flatMap(view => {
    const check = report?.checks?.find(item => item.id?.startsWith(`BROWSER-${view}-`) && item.passed === false
      && typeof item.actual === 'string' && item.actual.startsWith('{'));
    if (!check) return [];
    try { return [{ view, check, observation: JSON.parse(check.actual) }]; }
    catch { return []; }
  });
}

const statusIs = (request, status) => request?.assertions?.some(rule => rule.op === 'status' && rule.value === status
  || rule.op === 'statusIn' && Array.isArray(rule.value) && rule.value.includes(status));
const appPath = value => typeof value === 'string' && /^\/[A-Za-z0-9/_-]*(?:\.[A-Za-z0-9_-]+)?$/u.test(value) ? value : null;

export function findMissingBrowserLogin({ definition, browserReport, files } = {}) {
  const failures = firstBrowserFailures(browserReport);
  if (!failures.length) return null;
  const { view, check, observation } = failures[0];
  const steps = definition?.browser?.steps;
  if (!Array.isArray(steps) || failures.some(item => item.check.id.slice(item.view.length + 9) !== check.id.slice(view.length + 9))) return null;
  const index = steps.findIndex(step => check.id === `BROWSER-${view}-${step.id}`);
  const step = steps[index], page = appPath(step?.path);
  if (step?.op !== 'goto' || !page || observation.operation !== 'goto' || observation.observed?.status !== 200
    || !observation.guardFailures?.console_error) return null;
  if (steps.slice(0, index).some(prior => prior.session === step.session)) return null;

  const requests = (definition.steps ?? []).flatMap(item => item.type === 'request' ? [item.request] : []);
  if (!requests.some(request => request.path === '/api/auth/login' && request.method === 'POST' && request.session === step.session
    && (statusIs(request, 200) || statusIs(request, 201)))
    || !requests.some(request => request.path === '/api/auth/me' && request.method === 'GET' && !request.session && statusIs(request, 401))) return null;
  const before = steps.slice(0, index);
  const login = before.find(prior => prior.op === 'goto' && appPath(prior.path) && /^\/login(?:\.html)?$/u.test(prior.path));
  if (!login || !before.some(prior => prior.session === login.session && prior.op === 'fill' && /password/u.test(prior.testId))
    || !before.some(prior => prior.session === login.session && prior.op === 'click' && /login/u.test(prior.testId))) return null;
  if (files !== undefined) {
    const script = files.find(file => file.path === `public${page.replace(/\.html$/u, '')}.js`);
    const api = files.find(file => file.path === 'public/api.js');
    if (!script || !api?.content.includes('/api/auth/me') || !script.content.includes(login.path)
      || !/await\s+(?:window\.)?api\.me\(/u.test(script.content)) return null;
  }
  return { code: 'browser_login_missing', path: page, session: step.session, checkId: step.id };
}

export function plannedFailureHelp({ record, definition, engineeringContract } = {}) {
  if (!record || !['failed', 'stopped', 'timed_out', 'reconciliation_required'].includes(record.status)) return undefined;
  const version = record.versions?.at(-1), gate = version?.acceptance;
  const login = record.status === 'failed' && findMissingBrowserLogin({ definition, browserReport: gate?.browser });
  if (login) {
    const title = engineeringContract?.views?.find(view => view.path === login.path)?.title?.trim().slice(0, 80) || login.path;
    return { title: '验收清单漏了登录步骤', detail: `浏览器用测试账号 ${login.session} 打开「${title}」前，清单没有安排该账号登录。这一步失败后，后续页面检查没有跑完。`,
      nextStep: '点击「准备清单修订」，核对新方案和清单后再继续开发。原需求和执行记录都会保留。', action: 'review_checklist' };
  }
  if (record.status === 'reconciliation_required') return { title: '上一次执行的状态仍待核对', detail: '系统还没有确认上次任务已经停止。',
    nextStep: '查看执行记录，核对状态后再继续。', action: 'inspect' };
  if (record.status === 'stopped') return { title: '这次开发已停止', detail: '已生成的代码和运行记录已保留。',
    nextStep: '可以继续修复或重新开始开发。', action: 'retry' };
  if (record.status === 'timed_out') return { title: '这次开发超过了时限', detail: '系统保留了最后一版代码和已经得到的检查结果。',
    nextStep: '可以在已有代码上再运行一轮。', action: 'retry' };
  if (record.errorCode === 'rework_no_progress') return { title: '自动返工后仍卡在同一步', detail: '新代码跑出的检查结果和上一轮相同。系统保留了失败的位置和两轮结果。',
    nextStep: '先打开检查结果，核对这一步的预期，再决定是否继续修复。', action: 'inspect' };
  if (record.errorCode === 'unchanged_candidate') return { title: '返工没有产生代码改动', detail: '系统保留了上次的失败结果。',
    nextStep: '查看上次失败的检查，再决定是否继续修复。', action: 'inspect' };
  const blocking = gate?.issues?.find(item => item.severity === 'blocking' && item.status === 'open');
  if (blocking) return { title: '代码审查还有待修复的问题', detail: String(blocking.message ?? '检查到一个尚未解决的阻塞项。').slice(0, 280),
    nextStep: '继续修复时，系统会把这条问题交给开发流程，再检查新代码。', action: 'retry' };
  const first = firstBrowserFailures(gate?.browser)[0];
  if (first) {
    const page = appPath(first.observation.operation === 'goto' ? first.observation.expected : null);
    const title = engineeringContract?.views?.find(view => view.path === page)?.title || page;
    const position = definition?.browser?.steps?.findIndex(step => first.check.id === `BROWSER-${first.view}-${step.id}`) ?? -1;
    const operation = ({ fill: '填写内容', click: '点击按钮', visible: '检查内容是否显示', text: '核对页面文字', value: '核对输入值', count: '核对条数', createWithDelayedLoad: '在首次加载时提交内容' })[first.observation.operation];
    const detail = title ? `浏览器打开「${title}」时遇到页面错误，后续操作未完成。` : position >= 0 && operation
      ? `页面测试第 ${position + 1} 步「${operation}」未按预期完成。` : '浏览器未能完成验收清单里的一个页面操作。';
    return { title: '有一步页面操作没通过', detail,
      nextStep: '可以查看失败步骤，或让系统按这份检查记录继续修复。', action: 'retry' };
  }
  const failedInterface = (gate?.test?.checks ?? version?.selfCheck?.checks)?.find(check => check.passed === false && !check.actual?.includes?.('未执行'));
  if (failedInterface) return { title: '有一项功能检查没通过', detail: `首先失败的是「${String(failedInterface.name ?? failedInterface.id).slice(0, 120)}」。`,
    nextStep: '打开检查结果看实际反馈，或按这份反馈继续修复。', action: 'retry' };
  return { title: '这次开发未完成', detail: '系统未获得可以交付的检查结果。', nextStep: '查看本次执行记录再继续。', action: 'inspect' };
}
