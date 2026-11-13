import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { webProfile } from './web-profile.mjs';
import { applyProjectFiles, readProjectFiles, validateProjectFiles } from './project-files.mjs';
import { startWebRuntime } from './web-runtime.mjs';
import { createWindowsSandbox } from './windows-sandbox.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const databaseObserverSource = readFileSync(new URL('./web-database-observer.cjs', import.meta.url));
export const databaseObserverHash = hash(databaseObserverSource);
const definitions = [
  ['WEB-001', '独立源码快照', '允许文件已写入独立目录并绑定源码版本'],
  ['WEB-002', '受控应用启动', '真实隔离应用就绪'],
  ['WEB-003', '账户与会话', '三账户角色正确，错误凭据及伪造会话拒绝，Cookie属性完整'],
  ['WEB-004', '后端访问控制', '匿名401，普通用户创建图书和审计403'],
  ['WEB-005', '初始库存', 'book-1库存1，无初始借阅或操作审计'],
  ['WEB-006', '非法操作原子拒绝', '非法输入400、不存在404，全部业务数据不变'],
  ['WEB-007', '管理员新增馆藏', '新增库存2，字段与审计一致'],
  ['WEB-008', '最后一本并发竞争', '并发客户端恰好一个201、一个409，库存0'],
  ['WEB-009', '重复借阅保护', '同用户同书重复409且数据不变'],
  ['WEB-010', '记录与归属隔离', 'member仅本人，admin全部；他人归还403且数据不变'],
  ['WEB-011', '归还与重复保护', '本人归还恢复库存，重复409且数据不变'],
  ['WEB-012', '管理员代还', '另一用户重新借阅，admin归还且actor正确'],
  ['WEB-013', '退出会话失效', '退出清Cookie，旧Cookie不可访问'],
  ['WEB-014', '精确审计', '每次成功操作恰好一项，无失败操作审计'],
  ['WEB-015', '外置同源前端', 'HTML有登录表单和外置JS/CSS，同源资源可读且无内联代码'],
  ['WEB-016', '确认停止与重启', '旧进程确认停止后复用数据库，新登录后业务数据完全保留'],
  ['WEB-017', 'SQLite独立观察', '停止后只读普通SQLite表，库存/借还/审计与API和预期完全一致'],
  ['WEB-018', '版本与停止门禁', '源码未变化，所有启动进程确认正常停止'],
];
for (const item of definitions) Object.freeze(item);
Object.freeze(definitions);
export const webManifest = Object.freeze({
  hash: hash(JSON.stringify({ task: webProfile.task, definitions, implementation: hash(readFileSync(new URL(import.meta.url))), databaseObserverHash })),
  count: definitions.length,
  checks: Object.freeze(definitions.map(([id, name]) => Object.freeze({ id, name }))),
});
const compact = value => { try { return JSON.stringify(value).slice(0, 1800); } catch { return '无法序列化的观察结果'; } };
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const requireThat = (condition, expected, actual) => { if (!condition) throw Object.assign(new Error('业务断言未满足。'), { expected, actual: compact(actual) }); };
const stable = value => Array.isArray(value) ? value.map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const fields = (item, keys) => item && typeof item === 'object' ? Object.fromEntries(keys.map(key => [key, item[key]])) : item;
const userFields = item => fields(item, ['id', 'role']);
const bookFields = item => fields(item, ['id', 'title', 'copies', 'available']);
const loanFields = item => fields(item, ['id', 'bookId', 'userId', 'status']);
const eventFields = item => fields(item, ['action', 'actorId', 'targetId', 'at']);

async function directoryChain(directory, create = false) {
  const absolute = path.resolve(directory), anchor = path.parse(absolute).root;
  let current = anchor;
  for (const part of absolute.slice(anchor.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      await mkdir(current, { mode: 0o700 }); info = await lstat(current);
    }
    requireThat(info.isDirectory() && !info.isSymbolicLink() && samePath(await realpath(current), current), '无链接的可信目录链', '目录不安全');
  }
}

/** Fixed host-side acceptance; candidate test files and completion markers are never executed. */
export async function runWebTests({ rootDir, files, signal, executable = process.env.EXECUTION_SANDBOX_EXE, timeoutMs = 60_000, onEvent = () => {} } = {}) {
  const checks = [], processes = [], databaseCommands = [], databasePreflights = [];
  const result = { status: 'error', profileId: webProfile.id, manifestHash: webManifest.hash, sourceHash: null, checks, processes, databaseCommands, databasePreflights, workspace: null, error: null, terminationConfirmed: false };
  const controller = new AbortController();
  let timer, timedOut = false, runtime = null, canonicalFiles, expectedState, databaseState, observerSandbox, uncertain = false;
  const validSignal = signal instanceof AbortSignal;
  const emit = event => { try { if (typeof onEvent === 'function') onEvent(event); } catch { /* Observers do not grant a verdict. */ } };
  const abort = () => controller.abort();
  const started = Date.now();
  const guard = () => {
    if (uncertain) throw Object.assign(new Error('进程停止尚未确认，等待协调。'), { code: 'reconciliation_required' });
    if (controller.signal.aborted) throw Object.assign(new Error(timedOut ? '验收总时长预算已耗尽。' : '验收已取消。'), { code: timedOut ? 'timed_out' : 'cancelled' });
  };
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - started));
  const remember = record => { if (record?.pid && !processes.some(item => item.pid === record.pid && item.startedAt === record.startedAt)) processes.push(record); };
  const assertFiles = async () => requireThat(hash(JSON.stringify(await readProjectFiles(result.workspace))) === result.sourceHash, '源码与验收版本一致', '源码被篡改');
  const observeDatabase = async () => {
    guard(); await assertFiles();
    const platform = path.join(result.workspace, '.platform'); await directoryChain(platform);
    const runnerFile = path.join(platform, 'runner.cjs');
    try { await writeFile(runnerFile, databaseObserverSource, { flag: 'wx', mode: 0o400 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const assertRunner = async () => {
      await directoryChain(platform);
      const info = await lstat(runnerFile);
      requireThat(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size === databaseObserverSource.length && hash(await readFile(runnerFile)) === databaseObserverHash, '固定可信数据库观察器', '观察器被替换');
      await assertFiles();
    };
    await assertRunner(); guard();
    if (!observerSandbox) {
      observerSandbox = createWindowsSandbox({ executable });
      try { await observerSandbox.preflight({ workspace: result.workspace, signal: controller.signal }); }
      catch (error) {
        uncertain ||= error.reconciliationRequired === true || error.result?.terminationConfirmed === false;
        if (error.result) databasePreflights.push({ ...error.result, ...(error.probeDirectory ? { probeDirectory: error.probeDirectory } : {}), ...(error.cleanupError ? { cleanupError: error.cleanupError } : {}), kind: 'database_preflight', runnerHash: databaseObserverHash, sourceHash: result.sourceHash });
        throw error;
      }
    }
    await assertRunner(); guard();
    emit({ phase: 'database_observation', type: 'starting' });
    const command = await observerSandbox.run({ workspace: result.workspace, runnerFile, signal: controller.signal, timeoutMs: Math.min(3000, remaining()), maxOutputBytes: 64 * 1024 });
    databaseCommands.push({ ...command, kind: 'database_observation', runnerHash: databaseObserverHash, sourceHash: result.sourceHash });
    uncertain ||= command.terminationConfirmed !== true;
    await assertRunner(); guard();
    requireThat(command.exitCode === 0 && command.terminationConfirmed === true && command.stopReason === null && command.truncated === false, '数据库观察命令正常结束', { exitCode: command.exitCode, terminationConfirmed: command.terminationConfirmed, stopReason: command.stopReason, truncated: command.truncated });
    requireThat(typeof command.stdout === 'string' && Buffer.byteLength(command.stdout) <= 64 * 1024, '有界数据库JSON观察结果', '输出超限');
    let data;
    try { data = JSON.parse(command.stdout); } catch { requireThat(false, '有效数据库观察JSON', 'JSON无效'); }
    requireThat(data?.ok === true && Object.keys(data).sort().join(',') === 'books,events,loans,ok' && ['books', 'loans', 'events'].every(key => Array.isArray(data[key]) && data[key].length <= 100), '完整固定数据库观察字段', '观察结果格式无效');
    for (const row of data.books) requireThat(typeof row.id === 'string' && typeof row.title === 'string' && Number.isInteger(row.copies), '图书列类型有效', '数据库列类型错误');
    for (const row of data.loans) requireThat(['id', 'bookId', 'userId', 'status'].every(key => typeof row?.[key] === 'string'), '借阅列类型有效', '数据库列类型错误');
    for (const row of data.events) requireThat(['action', 'actorId', 'targetId', 'at'].every(key => typeof row?.[key] === 'string'), '审计列类型有效', '数据库列类型错误');
    return { books: data.books, loans: data.loans, events: data.events };
  };
  const stop = async () => {
    if (!runtime) return;
    const current = runtime; runtime = null;
    let record;
    try { record = await current.stop(); } catch (error) { uncertain = true; throw error; }
    remember(record);
    uncertain ||= record.terminationConfirmed !== true;
    requireThat(record.terminationConfirmed === true && record.status === 'stopped' && record.sourceUnchanged === true && record.exitCode === 0 && record.stopAcknowledged === true, '进程已正常停止且源码未变', { status: record.status, terminationConfirmed: record.terminationConfirmed, sourceUnchanged: record.sourceUnchanged, exitCode: record.exitCode });
  };
  const launch = async () => {
    guard();
    try {
      runtime = await startWebRuntime({ workspace: result.workspace, executable, signal: controller.signal, timeoutMs: remaining(), requestTimeoutMs: Math.min(5000, remaining()), maxOutputBytes: 4 * 1024 * 1024, onEvent: event => emit({ phase: 'runtime', ...event }) });
    } catch (error) { remember(error.result); uncertain ||= error.reconciliationRequired === true || error.result?.terminationConfirmed === false; throw error; }
  };
  const jars = { admin: {}, alice: {}, bob: {}, anonymous: {} };
  const request = async (who, method, route, body, raw = false) => {
    guard(); requireThat(runtime, '应用已启动', '无运行进程');
    const jar = typeof who === 'object' ? who : jars[who];
    const response = await runtime.request({ method, path: route, headers: { accept: raw ? '*/*' : 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(jar?.cookie ? { cookie: jar.cookie } : {}) }, body: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body) });
    guard();
    const cookies = response.headers['set-cookie'] ?? [];
    for (const cookie of cookies) {
      const match = cookie.match(/^app_session=([^;]*)/u);
      if (match && jar) jar.cookie = /(?:^|;)\s*max-age=0(?:;|$)/iu.test(cookie) || !match[1] ? '' : `app_session=${match[1]}`;
    }
    if (raw) return response;
    requireThat(/^application\/json(?:;|$)/iu.test(response.headers['content-type'] ?? ''), 'application/json响应', { status: response.status, contentType: response.headers['content-type'] });
    let json;
    try { json = JSON.parse(Buffer.from(response.body).toString('utf8')); } catch { requireThat(false, '有效JSON对象', { status: response.status, json: false }); }
    requireThat(json && typeof json === 'object' && !Array.isArray(json), 'JSON对象', { status: response.status });
    return { ...response, json };
  };
  const status = (response, wanted) => {
    requireThat(response.status === wanted, `HTTP ${wanted}`, { status: response.status });
    if (wanted >= 400) requireThat(typeof response.json.error === 'string' && response.json.error.trim(), '非空JSON error', { errorPresent: !!response.json.error });
    return response.json;
  };
  const login = async name => {
    const response = await request(name, 'POST', '/api/login', { username: name, password: `${name}-pass` });
    requireThat(same(userFields(status(response, 200).user), { id: name, role: name === 'admin' ? 'admin' : 'member' }), '正确的用户id与角色', userFields(status(response, 200).user));
    const cookie = response.headers['set-cookie']?.find(value => /^app_session=\S/u.test(value));
    requireThat(cookie && /;\s*HttpOnly(?:;|$)/iu.test(cookie) && /;\s*Path=\/(?:;|$)/iu.test(cookie) && /;\s*SameSite=Lax(?:;|$)/iu.test(cookie), 'HttpOnly/Path=/SameSite=Lax会话Cookie', { validCookie: !!cookie });
    requireThat(!!jars[name].cookie, '非空会话', '会话为空');
  };
  const business = async () => {
    const books = status(await request('admin', 'GET', '/api/books'), 200).books;
    const loans = status(await request('admin', 'GET', '/api/loans'), 200).loans;
    const events = status(await request('admin', 'GET', '/api/audit'), 200).events;
    requireThat(Array.isArray(books) && Array.isArray(loans) && Array.isArray(events), '业务列表数组', '列表格式错误');
    return { books: books.map(bookFields), loans: loans.map(loanFields), events: events.map(eventFields) };
  };
  const unchanged = async action => { const before = stable(await business()); await action(); requireThat(same(stable(await business()), before), '拒绝操作无业务副作用', '拒绝前后数据不同'); };
  const selectBook = (state, id = 'book-1') => state.books.find(book => book.id === id);
  const expectedAudit = [];
  let createdBook, loan, secondLoan, winner, loser;
  const addAudit = (action, actorId, targetId) => expectedAudit.push({ action, actorId, targetId });
  const verifyAudit = events => {
    requireThat(events.length === expectedAudit.length, '成功操作与审计一一对应', { expected: expectedAudit.length, actual: events.length });
    const actual = events.map(({ action, actorId, targetId, at }) => {
      requireThat(typeof at === 'string' && /^\d{4}-\d\d-\d\dT/u.test(at) && Number.isFinite(Date.parse(at)), 'ISO审计时间', '时间无效');
      return { action, actorId, targetId };
    });
    requireThat(same(stable(actual), stable(expectedAudit)), '审计行为/操作者/目标精确匹配', actual);
  };
  async function check(index, dependencies, fn) {
    const [id, name, expected] = definitions[index];
    let item;
    try {
      guard();
      requireThat(dependencies.every(prior => checks[prior]?.passed), '前置检查通过', '前置检查失败；该项未获得通过结论');
      await fn(); guard(); item = { id, name, passed: true, expected, actual: '符合固定验收条件' };
    } catch (error) {
      item = { id, name, passed: false, expected: error.expected ?? expected, actual: error.actual ?? (error.code === 'cancelled' || error.code === 'timed_out' ? error.message : '执行或断言失败') };
      if (error.code === 'source_changed') result.error = '验收期间源码被修改。';
    }
    checks.push(item); emit({ phase: 'check', ...item });
  }
  try {
    requireThat(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 600_000, '1至600000毫秒总预算', '预算无效');
    requireThat(signal === undefined || validSignal, '有效取消信号', '信号无效');
    if (validSignal) signal.addEventListener('abort', abort, { once: true });
    if (validSignal && signal.aborted) abort();
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    await check(0, [], async () => {
      requireThat(typeof rootDir === 'string' && path.isAbsolute(rootDir) && path.resolve(rootDir) !== path.parse(path.resolve(rootDir)).root, '可信非根绝对输出目录', '输出目录无效');
      canonicalFiles = validateProjectFiles(files);
      requireThat(canonicalFiles.some(file => file.path === 'src/app.mjs'), 'src/app.mjs应用入口', '缺少入口');
      result.sourceHash = hash(JSON.stringify(canonicalFiles));
      await directoryChain(rootDir, true); guard();
      result.workspace = await mkdtemp(path.join(path.resolve(rootDir), 'web-validation-'));
      requireThat((await applyProjectFiles({ workspace: result.workspace, files: canonicalFiles })).sourceHash === result.sourceHash, '完整写入绑定源码', '源码不一致');
    });
    await check(1, [0], launch);
    await check(2, [1], async () => {
      status(await request('anonymous', 'POST', '/api/login', { username: 'alice', password: 'wrong' }), 401);
      status(await request({ cookie: 'app_session=admin' }, 'GET', '/api/me'), 401);
      for (const name of ['admin', 'alice', 'bob']) { await login(name); requireThat(same(userFields(status(await request(name, 'GET', '/api/me'), 200).user), { id: name, role: name === 'admin' ? 'admin' : 'member' }), '会话身份保持', '身份错误'); }
    });
    await check(3, [2], async () => {
      await unchanged(async () => {
        for (const route of ['/api/me', '/api/books', '/api/loans', '/api/audit']) status(await request('anonymous', 'GET', route), 401);
        status(await request('anonymous', 'POST', '/api/loans', { bookId: 'book-1' }), 401);
        status(await request('alice', 'POST', '/api/books', { title: '无权新增', copies: 1 }), 403);
        status(await request('bob', 'GET', '/api/audit'), 403);
      });
    });
    await check(4, [2], async () => {
      const state = await business(); const book = selectBook(state);
      requireThat(state.books.length === 1 && book?.copies === 1 && book.available === 1 && book.title === webProfile.task.initialBooks[0].title && state.loans.length === 0 && state.events.length === 0, '初始book-1标题/库存与固定档案一致且无借阅和操作审计', state);
    });
    await check(5, [3, 4], async () => {
      await unchanged(async () => {
        for (const input of [{ title: '', copies: 1 }, { title: 'bad', copies: -1 }, { title: 'bad', copies: 1.5 }, { title: 'bad', copies: 1001 }, { title: 'x'.repeat(121), copies: 1 }]) status(await request('admin', 'POST', '/api/books', input), 400);
        status(await request('admin', 'POST', '/api/books', '{'), 400);
        status(await request('alice', 'POST', '/api/loans', {}), 400);
        status(await request('alice', 'POST', '/api/loans', { bookId: 'book-1', userId: 'bob', role: 'admin' }), 400);
        status(await request('alice', 'POST', '/api/loans', { bookId: 'missing-book' }), 404);
        status(await request('alice', 'POST', '/api/loans/missing-loan/return', {}), 404);
      });
    });
    await check(6, [5], async () => {
      createdBook = bookFields(status(await request('admin', 'POST', '/api/books', { title: '  验收新增馆藏  ', copies: 2 }), 201).book);
      requireThat(createdBook && typeof createdBook.id === 'string' && createdBook.id && createdBook.id !== 'book-1' && createdBook.title === '验收新增馆藏' && createdBook.copies === 2 && createdBook.available === 2, '新增图书的完整字段与修剪标题', createdBook);
      const state = await business(); requireThat(same(selectBook(state, createdBook.id), createdBook), '新增图书可查询', '新增结果未保存'); addAudit('create_book', 'admin', createdBook.id);
    });
    await check(7, [6], async () => {
      const responses = await Promise.all(['alice', 'bob'].map(name => request(name, 'POST', '/api/loans', { bookId: 'book-1' })));
      requireThat(same(responses.map(item => item.status).sort(), [201, 409]), '两个并发客户端恰好一成功', responses.map(item => item.status));
      const index = responses.findIndex(item => item.status === 201); winner = ['alice', 'bob'][index]; loser = winner === 'alice' ? 'bob' : 'alice';
      loan = loanFields(status(responses[index], 201).loan); status(responses[1 - index], 409);
      requireThat(loan && typeof loan.id === 'string' && loan.id && loan.bookId === 'book-1' && loan.userId === winner && loan.status === 'active', '借阅绑定当前用户', loan);
      const state = await business(); requireThat(selectBook(state).available === 0 && state.loans.length === 1 && same(state.loans[0], loan), '唯一有效借阅且库存0', state); addAudit('borrow', winner, loan.id);
    });
    await check(8, [7], async () => unchanged(async () => { status(await request(winner, 'POST', '/api/loans', { bookId: 'book-1' }), 409); }));
    await check(9, [8], async () => {
      for (const name of ['alice', 'bob']) {
        const own = status(await request(name, 'GET', '/api/loans'), 200).loans;
        requireThat(Array.isArray(own) && own.every(item => item.userId === name) && own.length === (name === winner ? 1 : 0), '仅展示本人记录', own);
      }
      await unchanged(async () => { status(await request(loser, 'POST', `/api/loans/${encodeURIComponent(loan.id)}/return`, {}), 403); });
    });
    await check(10, [9], async () => {
      const returned = loanFields(status(await request(winner, 'POST', `/api/loans/${encodeURIComponent(loan.id)}/return`, {}), 200).loan);
      requireThat(same(returned, { ...loan, status: 'returned' }) && selectBook(await business()).available === 1, '归还记录与库存恢复', returned); loan = returned; addAudit('return', winner, loan.id);
      await unchanged(async () => { status(await request(winner, 'POST', `/api/loans/${encodeURIComponent(loan.id)}/return`, {}), 409); });
    });
    await check(11, [10], async () => {
      secondLoan = loanFields(status(await request(loser, 'POST', '/api/loans', { bookId: 'book-1' }), 201).loan);
      requireThat(secondLoan && typeof secondLoan.id === 'string' && secondLoan.id && secondLoan.id !== loan.id && secondLoan.userId === loser && secondLoan.bookId === 'book-1' && secondLoan.status === 'active', '另一用户新借阅记录', secondLoan); addAudit('borrow', loser, secondLoan.id);
      const returned = loanFields(status(await request('admin', 'POST', `/api/loans/${encodeURIComponent(secondLoan.id)}/return`, {}), 200).loan);
      requireThat(same(returned, { ...secondLoan, status: 'returned' }) && selectBook(await business()).available === 1, '管理员代还恢复库存', returned); secondLoan = returned; addAudit('return', 'admin', secondLoan.id);
    });
    await check(12, [2], async () => {
      const oldCookie = jars.alice.cookie;
      const response = await request('alice', 'POST', '/api/logout', {}); requireThat(status(response, 200).ok === true && !jars.alice.cookie, '退出清除Cookie', 'Cookie未清除');
      status(await request({ cookie: oldCookie }, 'GET', '/api/me'), 401); status(await request('alice', 'GET', '/api/loans'), 401);
    });
    await check(13, [11, 12], async () => { expectedState = await business(); verifyAudit(expectedState.events); });
    await check(14, [1], async () => {
      const response = await request('anonymous', 'GET', '/', undefined, true);
      const html = Buffer.from(response.body).toString('utf8');
      requireThat(response.status === 200 && /^text\/html(?:;|$)/iu.test(response.headers['content-type'] ?? '') && /<form\b/iu.test(html) && /\bname\s*=\s*["']username["']/iu.test(html) && /\bname\s*=\s*["']password["']/iu.test(html), 'HTML登录表单', { status: response.status, form: /<form\b/iu.test(html) });
      requireThat(!/<style\b|\sstyle\s*=|\son[a-z]+\s*=/iu.test(html), '无内联样式或事件', '包含内联代码');
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)];
      requireThat(scripts.length > 0 && scripts.every(match => !match[2].trim()), '仅外置脚本', '缺脚本或存在内联脚本');
      const scriptPaths = scripts.map(match => match[1].match(/\bsrc\s*=\s*["']([^"']+)["']/iu)?.[1]);
      const styles = [...html.matchAll(/<link\b([^>]*)>/giu)].filter(match => /\brel\s*=\s*["']stylesheet["']/iu.test(match[1])).map(match => match[1].match(/\bhref\s*=\s*["']([^"']+)["']/iu)?.[1]);
      requireThat(styles.length > 0, '外置CSS', '缺少CSS');
      for (const [resource, extension, type] of [...scriptPaths.map(value => [value, '.js', /(?:text|application)\/javascript/iu]), ...styles.map(value => [value, '.css', /text\/css/iu])]) {
        requireThat(typeof resource === 'string' && /^\/(?!\/)[A-Za-z0-9_./-]+$/u.test(resource) && !resource.includes('..') && resource.endsWith(extension), '同源静态资源路径', '路径不规范');
        const source = canonicalFiles.find(file => file.path === `public${resource}`);
        const actual = await request('anonymous', 'GET', resource, undefined, true);
        requireThat(source && actual.status === 200 && type.test(actual.headers['content-type'] ?? '') && Buffer.from(actual.body).toString('utf8') === source.content, '静态资源与候选文件一致', { resource, status: actual.status });
      }
    });
    await check(15, [13], async () => {
      await stop(); guard(); databaseState = await observeDatabase();
      await launch(); for (const name of ['admin', 'alice', 'bob']) { jars[name].cookie = ''; await login(name); }
      requireThat(same(stable(await business()), stable(expectedState)), '重启后业务与审计完整保留', '重启丢失或重置数据');
    });
    await check(16, [1], async () => {
      await stop(); databaseState = await observeDatabase();
      requireThat(checks[15]?.passed && expectedState, '完整重启与API预期已建立', '业务或重启未通过，数据库观察不能替代业务通过结论');
      const wantedBooks = expectedState.books.map(({ id, title, copies }) => ({ id, title, copies }));
      requireThat(same(stable(databaseState.books), stable(wantedBooks)) && same(stable(databaseState.loans), stable(expectedState.loans)) && same(stable(databaseState.events), stable(expectedState.events)), 'SQLite实际数据与API结果完全一致', databaseState);
      requireThat(databaseState.books.length === 2 && databaseState.loans.length === 2 && databaseState.loans.every(item => item.status === 'returned'), '两本馆藏和两条已归还记录', '业务记录不符');
      for (const book of expectedState.books) requireThat(book.available === book.copies - databaseState.loans.filter(item => item.bookId === book.id && item.status === 'active').length, '数据库推导库存与API一致', '库存不一致');
    });
  } catch (error) { result.error = error.code === 'cancelled' || error.code === 'timed_out' ? error.message : '验收初始化或运行失败。'; }
  finally {
    try { await stop(); } catch { result.error ??= '进程停止或源码一致性检查失败。'; }
    try {
      if (checks.length === 17) await check(17, [0, 1], async () => {
        requireThat(!controller.signal.aborted, '验收未取消或超时', '验收已停止');
        requireThat(hash(JSON.stringify(await readProjectFiles(result.workspace))) === result.sourceHash, '源码与验收版本一致', '源码被篡改');
        requireThat(processes.length > 0 && processes.every(item => item.terminationConfirmed === true && item.status === 'stopped' && item.sourceUnchanged === true && item.exitCode === 0 && item.stopAcknowledged === true), '全部已启动进程正常确认停止', processes.map(item => ({ status: item.status, confirmed: item.terminationConfirmed, sourceUnchanged: item.sourceUnchanged })));
        requireThat(databaseCommands.length === 2 && databaseCommands.every(command => command.exitCode === 0 && command.terminationConfirmed === true && command.stopReason === null && command.truncated === false && command.runnerHash === databaseObserverHash && command.sourceHash === result.sourceHash), '两次真实数据库观察命令正常结束并绑定版本', databaseCommands.map(command => ({ exitCode: command.exitCode, stopReason: command.stopReason, terminationConfirmed: command.terminationConfirmed })));
      });
    } catch { /* The complete fixed list below remains fail-closed. */ }
    while (checks.length < definitions.length) {
      const [id, name, expected] = definitions[checks.length]; checks.push({ id, name, passed: false, expected, actual: timedOut ? '总预算耗尽，未获得通过结论' : controller.signal.aborted ? '验收取消，未获得通过结论' : '前置执行失败，未获得通过结论' });
    }
    clearTimeout(timer); if (validSignal) signal.removeEventListener('abort', abort);
    const commands = [...processes, ...databaseCommands, ...databasePreflights];
    result.terminationConfirmed = commands.length > 0 && !uncertain && commands.every(item => item.terminationConfirmed === true);
    result.status = uncertain || commands.some(item => item.terminationConfirmed !== true) ? 'reconciliation_required' : timedOut ? 'timed_out' : validSignal && signal.aborted ? 'cancelled' : checks.every(item => item.passed) && !result.error ? 'passed' : checks[0]?.passed && checks[1]?.passed ? 'failed' : 'error';
    if (result.status !== 'passed') result.error ??= '固定Web验收未全部通过，请查看逐项证据。';
  }
  return result;
}
