import { copyBrowserScenarioData, normalizeBrowserScenario } from './browser-scenario-contract.mjs';

const fail = code => { throw Object.assign(new Error('延迟首次加载后的创建结果、边界或当前授权未满足。'), { code }); };
const need = (value, code = 'browser_create_race') => { if (!value) fail(code); };

/** Trusted runner action. Runtime/context lifecycle and approval stay with the
 * owning runner. This supports a REST collection GET/POST on the same loadPath;
 * it does not infer arbitrary forms, endpoints, scripts or expected values. */
export async function runBrowserCreateRace({ step: raw, context, origin, actionTimeoutMs, remaining, guard, bounded, inspect, violated }) {
  const data = copyBrowserScenarioData(raw), step = normalizeBrowserScenario({ version: 1, sessions: [data.session], steps: [data] }, data.requirementIds).steps[0];
  need(step.op === 'createWithDelayedLoad' && typeof guard === 'function' && typeof bounded === 'function' && typeof inspect === 'function' && typeof violated === 'function');
  const base = new URL(origin); need(base.origin === origin && base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && !base.username && !base.password);
  const end = Date.now() + Math.min(actionTimeoutMs, remaining());
  const current = () => { guard(); need(!violated(), 'browser_boundary'); need(Date.now() < end, 'browser_action_timeout'); };
  const timeout = () => Math.max(1, Math.min(end - Date.now(), remaining()));
  const pending = new Set();
  async function action(work) {
    current(); const promise = Promise.resolve().then(() => { current(); return work(); }); promise.catch(() => {}); pending.add(promise);
    let timer; try { const result = await bounded(Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('bounded action'), { code: 'browser_action_timeout' })), timeout()); })])); current(); return result; }
    finally { clearTimeout(timer); pending.delete(promise); }
  }
  const observation = { operation: step.op, branch: null, initialStatus: null, postStatus: null, beforeCount: null, afterCreateCount: null, afterReleaseCount: null, listRetained: false };
  const page = await action(() => context.newPage());
  const target = origin + step.loadPath;
  let held = false, released = false, release, readyResolve, readyReject, finishedResolve, finishedReject;
  const waitRelease = new Promise(resolve => { release = resolve; });
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }); ready.catch(() => {});
  const finished = new Promise((resolve, reject) => { finishedResolve = resolve; finishedReject = reject; }); finished.catch(() => {});
  const releaseLoad = () => { if (!released) { released = true; release(); } };
  const initialResponse = page.waitForResponse(response => response.url() === target && response.request().method() === 'GET', { timeout: timeout() }); initialResponse.catch(() => {});
  const routeHandler = async route => {
    if (route.request().method() !== 'GET' || held) { await route.fallback(); return; }
    held = true;
    try {
      current();
      // route.fetch does not run the context route guard. Disable redirects and
      // verify its exact response URL before accepting any actual response data.
      const response = await action(() => route.fetch({ timeout: timeout(), maxRedirects: 0 }));
      const headers = response.headers(); need(response.url() === target && response.status() >= 200 && response.status() < 300 && /^application\/json(?:\s*;|$)/iu.test(headers['content-type'] ?? ''));
      const body = await action(() => response.body()); need(body.length <= 256 * 1024); JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      observation.initialStatus = response.status(); readyResolve(); await action(() => waitRelease);
      await action(() => route.fulfill({ response, body })); finishedResolve();
    } catch (cause) { readyReject(cause); finishedReject(cause); await route.abort().catch(() => {}); }
  };
  try {
    await action(() => page.route(url => url.href === target, routeHandler));
    const response = await action(() => page.goto(origin + step.path, { waitUntil: 'domcontentloaded', timeout: timeout() }));
    need(response && response.status() < 400 && page.url() === origin + step.path); await action(() => ready);
    const unique = async (id, visible = true) => { const state = await action(() => inspect(context, page, id)); need(state.count === 1 && (!visible || state.visible)); return state; };
    for (const id of [step.inputTestId, step.submitTestId, step.countTestId]) await unique(id); await unique(step.listTestId, false);
    const submit = page.getByTestId(step.submitTestId), input = page.getByTestId(step.inputTestId);
    observation.beforeCount = (await unique(step.countTestId)).text;
    // Empty required input can disable submit without protecting initial load.
    // Supply the approved value before deciding which ordering is possible.
    const initiallyDisabled = await action(() => submit.isDisabled({ timeout: timeout() }));
    const editable = await action(() => input.isEditable({ timeout: timeout() }));
    if (editable) await action(() => input.fill(step.value, { timeout: timeout() }));
    else need(initiallyDisabled, 'browser_input_unavailable');
    const disabled = await action(() => submit.isDisabled({ timeout: timeout() }));
    observation.branch = disabled ? 'initial-load-create-disabled' : 'create-before-stale-load';
    const poll = async (id, predicate) => {
      for (;;) { const state = await unique(id); if (predicate(state)) return state; await action(() => new Promise(resolve => setTimeout(resolve, 20))); }
    };
    if (disabled) {
      releaseLoad(); await action(() => finished); const initial = await action(() => initialResponse); need(await action(() => initial.finished()) === null);
      while (await action(() => submit.isDisabled({ timeout: timeout() }))) await action(() => new Promise(resolve => setTimeout(resolve, 20)));
    }
    await action(() => input.fill(step.value, { timeout: timeout() }));
    const posted = page.waitForResponse(response => response.url() === target && response.request().method() === 'POST', { timeout: timeout() }); posted.catch(() => {});
    await action(() => submit.click({ timeout: timeout() })); const post = await action(() => posted); observation.postStatus = post.status(); need(post.status() >= 200 && post.status() < 300);
    need(await action(() => post.finished()) === null);
    observation.afterCreateCount = (await poll(step.countTestId, state => state.text.trim() === String(step.expectedCount))).text;
    await poll(step.listTestId, state => state.text.includes(step.value));
    releaseLoad(); await action(() => finished); const initial = await action(() => initialResponse); need(await action(() => initial.finished()) === null);
    // The body has finished, then let the application's response/JSON microtasks
    // render before the final observation. This is fixed scheduling, not model JS.
    await action(() => new Promise(resolve => setTimeout(resolve, 150)));
    const count = await unique(step.countTestId), list = await unique(step.listTestId), layout = await action(() => inspect(context, page));
    observation.afterReleaseCount = count.text; observation.listRetained = list.text.includes(step.value);
    need(count.text.trim() === String(step.expectedCount) && observation.listRetained && layout.scroll <= layout.width + 1);
    current(); return observation;
  } catch (cause) { throw Object.assign(new Error('延迟加载创建回归未通过。'), { code: cause?.code ?? 'browser_create_race', observation }); }
  finally {
    releaseLoad();
    // The owning runner closes this fresh context and stops its fresh runtime.
    // Outstanding route work must settle first or remain an explicit failure.
    await Promise.allSettled([...pending]);
  }
}
