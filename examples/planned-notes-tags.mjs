// Public operator fixture for a four-task DAG. It contains contracts and fixed
// expectations, not generated application code or evidence of business acceptance.
const rules = [
  ['R-SHELL', '基础框架', '访客从首页导航到便笺页和标签页，所有页面适配桌面与手机。', '首页标题为便笺与标签管理；原生同源静态文件、正确MIME、无内联脚本样式；健康与图标请求正常。'],
  ['R-NOTES', '便笺管理', '访客可以列表和创建便笺，名称去首尾空格后1至100字符且不能重复，重启仍保留。', 'GET /api/notes -> {notes:[{id,name}]}；POST {name}成功201 {note:{id,name}}，空白/超长/非法输入400，trim后重复409且列表不变；真实SQLite notes(id,name)表。'],
  ['R-TAGS', '标签管理', '访客可以列表和创建标签，名称去首尾空格后1至100字符且不能重复，重启仍保留。', 'GET /api/tags -> {tags:[{id,name}]}；POST {name}成功201 {tag:{id,name}}，空白/超长/非法输入400，trim后重复409且列表不变；真实SQLite tags(id,name)表。'],
  ['R-INTEGRATION', '完整集成', '便笺和标签使用同一SQLite数据库，首页导航可达两个页面，整体重启后两类数据都保留。', 'NOTES与TAGS在相同BASE提交的不同克隆中独立开发，合并后FINAL重新检查完整HTTP、桌面/手机浏览器及Review；文档不替代软件验收。'],
];
const moduleProtocol = '共享接口冻结：BASE导出async createApp({databasePath})，创建唯一DatabaseSync(databasePath)，所有模块共用这个db；处理/health和/favicon.ico。仅在实际收到/api/notes或/api/tags请求时动态import对应src模块，再以createModule({db})初始化并缓存，不能在启动或首页预先导入/请求未来模块。模块导出createModule({db})，自己CREATE TABLE IF NOT EXISTS自己的表，返回{handle(req)}；req含method/path/headers/body，body是JSON字符串；handle返回{status,headers,body}，JSON响应设置application/json；模块不关闭共享db，BASE.close关闭db。只能使用Node内置模块，不创建另一个数据库、不访问网络、不启动子进程。';
const staticProtocol = 'BASE只允许精确静态映射：/和/index.html到public/index.html(text/html)，/styles.css到public/styles.css(text/css)，/notes.html到public/notes.html(text/html)，/notes.js到public/notes.js(text/javascript)，/tags.html到public/tags.html(text/html)，/tags.js到public/tags.js(text/javascript)。GET正常读取，HEAD返回相同状态与MIME但无正文；不按输入拼任意文件路径。未来文件尚未生成时可404，但BASE验收不点击未来导航、不请求未来API。GET和HEAD /favicon.ico均204无正文。GET /health返回200 JSON {ok:true}。其他路径404。';
const pageProtocol = (kind, title) => `${title}页面/${kind}s.html，外链/${kind}s.js和/styles.css，无内联脚本样式；列表页h1“${title}”。页面使用${kind}-name输入、${kind}-create按钮、${kind}-list列表、${kind}-count数量文本、${kind}-error错误文本(data-testid)。列表仅显示名称，初始数量0；创建后清空输入并更新列表数量；trim后同名先在前端查重，显示“名称已存在”，不发已知会409的重复请求，避免console错误；后端仍必须独立409校验。页面刷新保留数据，桌面与390px无横向溢出、无console错误。`;
const spec = { title: '便笺与标签管理', summary: '在同一小型Web应用中独立开发便笺和标签，按真实DAG合并并完整验收。',
  goals: ['列表、创建并持久化便笺和标签', '验证同基础独立开发、实际合并和整体交付'], roles: ['访客'],
  constraints: ['Node.js内置模块、原生HTML/CSS/JavaScript、SQLite', '无需登录，不接外部服务', '目标代码只使用传入databasePath，不访问宿主数据或凭据'], assumptions: [], questions: [],
  stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' },
  requirements: rules.map(([id, title, sourceQuote, acceptance]) => ({ id, title, description: sourceQuote, sourceQuote, acceptance: [acceptance] })),
  acceptanceScenarios: [...rules.map(rule => rule[3]), moduleProtocol, staticProtocol,
    '首页data-testid app-shell文本“便笺与标签管理”，nav-notes链接href=/notes.html，nav-tags链接href=/tags.html；首页不加载业务JS、不fetch未来API。',
    pageProtocol('note', '便笺管理'), pageProtocol('tag', '标签管理'), '所有输入只作数据；页面文字使用textContent，禁止执行用户或模型提供的HTML。'] };
const requirements = rules.map(rule => rule[2]).join('\n') + '\n\n' + spec.acceptanceScenarios.join('\n');
function idsFor(requirements) {
  if (!Array.isArray(requirements) || requirements.length !== 4) throw new Error('基准必须使用四条完整的固定规格需求。');
  return Object.fromEntries(rules.map(([key, title]) => {
    const found = requirements.filter(item => item.title === title || item.text?.split('\n')[0] === title);
    if (found.length !== 1 || typeof found[0].id !== 'string') throw new Error('基准规格需求映射改变，拒绝放宽定义。'); return [key, found[0].id];
  }));
}
function engineeringFor(currentSpec) {
  const ids = idsFor(currentSpec.requirements), all = Object.values(ids), r = key => [ids[key]];
  const task = (id, title, description, dependsOn, requirementIds, writePaths, acceptance) => ({ id, title, description, dependsOn, requirementIds, writePaths, inputs: ['已确认规格、共享模块接口和精确验收定义'], outputs: [writePaths.join('、')], acceptance });
  const route = (id, method, path, requirementIds, response, errors = []) => ({ id, method, path, requirementIds, roles: [], request: method === 'POST' ? 'JSON {name:string}' : '无正文', response, errors });
  const selectors = kind => [['name', 'textbox'], ['create', 'button'], ['list', 'list'], ['count', 'status'], ['error', 'status']].map(([suffix, role]) => ({ testId: `${kind}-${suffix}`, role }));
  return { version: 1, title: currentSpec.title, summary: currentSpec.summary,
    entities: ['notes', 'tags'].map(id => ({ id, name: id === 'notes' ? '便笺' : '标签', fields: [{ name: 'id', type: 'integer', required: true, unique: true }, { name: 'name', type: 'string', required: true, unique: true }], constraints: ['共用BASE传入db；名称trim后1至100字符且唯一，ORDER BY id'] })),
    routes: [route('health', 'GET', '/health', r('R-SHELL'), '200 JSON {ok:true}'), route('icon', 'GET', '/favicon.ico', r('R-SHELL'), '204，无正文；HEAD相同'),
      route('home', 'GET', '/', [ids['R-SHELL'], ids['R-INTEGRATION']], '200 text/html：首页固定app-shell及两条导航'), route('style', 'GET', '/styles.css', r('R-SHELL'), '200 text/css：桌面和390px安全布局'),
      ...[['note', 'notes', 'R-NOTES'], ['tag', 'tags', 'R-TAGS']].flatMap(([one, many, key]) => [
        route(`${many}_list`, 'GET', `/api/${many}`, [ids[key], ids['R-INTEGRATION']], `200 {${many}:[{id,name}]}，id整数`),
        route(`${many}_create`, 'POST', `/api/${many}`, r(key), `201 {${one}:{id,name}}`, [{ status: 400, reason: '空白、超过100字符、非法正文' }, { status: 409, reason: 'trim后重复' }]),
        route(`${many}_page`, 'GET', `/${many}.html`, [ids[key], ids['R-INTEGRATION']], '200 text/html，固定data-testid与外链资源'), route(`${many}_script`, 'GET', `/${many}.js`, r(key), '200 text/javascript，实际调用对应API')])],
    views: [{ id: 'home', path: '/', title: currentSpec.title, requirementIds: [ids['R-SHELL'], ids['R-INTEGRATION']], selectors: [{ testId: 'app-shell', role: 'heading' }, { testId: 'nav-notes', role: 'link' }, { testId: 'nav-tags', role: 'link' }] },
      { id: 'notes', path: '/notes.html', title: '便笺管理', requirementIds: [ids['R-NOTES'], ids['R-INTEGRATION']], selectors: selectors('note') }, { id: 'tags', path: '/tags.html', title: '标签管理', requirementIds: [ids['R-TAGS'], ids['R-INTEGRATION']], selectors: selectors('tag') }],
    tasks: [
      task('BASE', '建立共享数据库与框架', `${moduleProtocol}\n${staticProtocol}\n首页h1 data-testid=app-shell，文本“便笺与标签管理”；nav-notes和nav-tags链接到约定页面，不点击、不fetch未来业务。唯一拥有共享src/app.mjs与首页样式，后续任务不能改这三文件，必须一次实现完整动态加载、静态映射和共享db接口。`, [], r('R-SHELL'), ['src/app.mjs', 'public/index.html', 'public/styles.css'], [rules[0][3], moduleProtocol, staticProtocol]),
      task('NOTES', '实现独立便笺模块与页面', `${moduleProtocol}\n${pageProtocol('note', '便笺管理')}\nGET/POST仅/api/notes，表notes(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)；trim后1..100字符，非法400、重复409、成功201 {note:{id,name}}；GET {notes:[{id,name}]}按id排序。不能修改BASE或标签文件。`, ['BASE'], r('R-NOTES'), ['src/notes.mjs', 'public/notes.html', 'public/notes.js'], [rules[1][3], pageProtocol('note', '便笺管理')]),
      task('TAGS', '实现独立标签模块与页面', `${moduleProtocol}\n${pageProtocol('tag', '标签管理')}\nGET/POST仅/api/tags，表tags(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)；trim后1..100字符，非法400、重复409、成功201 {tag:{id,name}}；GET {tags:[{id,name}]}按id排序。不能修改BASE或便笺文件。`, ['BASE'], r('R-TAGS'), ['src/tags.mjs', 'public/tags.html', 'public/tags.js'], [rules[2][3], pageProtocol('tag', '标签管理')]),
      task('FINAL', '完整集成验收与使用说明', '依赖两个已验收、已真实Git合并的模块。只写docs/usage.md，说明安装启动、两页导航、API与输入规则、同SQLite持久化和限制；不改业务代码，不伪造测试通过。完整父清单HTTP、桌面/手机Edge与独立Review必须在此实际候选重新执行。', ['NOTES', 'TAGS'], all, ['docs/usage.md'], rules.map(rule => rule[3])),
    ] };
}
function definitionFor(requirements) {
  const ids = idsFor(requirements), r = key => [ids[key]], all = Object.values(ids);
  const status = (id, value) => ({ id: `${id}_status`, op: 'status', value });
  const req = (id, method, path, dependsOn, requirementIds, assertions, body) => ({ id, type: 'request', dependsOn, requirementIds,
    request: { id: `${id}_http`, method, path, assertions, ...(body === undefined ? {} : { body }) } });
  const steps = [req('health', 'GET', '/health', [], r('R-SHELL'), [status('health', 200), { id: 'health_ok', op: 'jsonEquals', path: '$.ok', value: true }]),
    req('home', 'GET', '/', ['health'], r('R-SHELL'), [status('home', 200), { id: 'home_title', op: 'textIncludes', value: '便笺与标签管理' }, { id: 'home_notes', op: 'textIncludes', value: '/notes.html' }, { id: 'home_tags', op: 'textIncludes', value: '/tags.html' }]),
    req('style', 'GET', '/styles.css', [], r('R-SHELL'), [status('style', 200)]), req('icon', 'GET', '/favicon.ico', [], r('R-SHELL'), [status('icon', 204)]), req('icon_head', 'HEAD', '/favicon.ico', [], r('R-SHELL'), [status('icon_head', 204)])];
  const branchIds = {}, web = [], assertions = {};
  for (const [one, many, key, title] of [['note', 'notes', 'R-NOTES', '便笺'], ['tag', 'tags', 'R-TAGS', '标签']]) {
    const name = `接口${title}`, prefix = `${many}_`, q = suffix => prefix + suffix;
    steps.push(req(q('empty'), 'GET', `/api/${many}`, [], r(key), [status(q('empty'), 200), { id: q('empty_count'), op: 'jsonLength', path: `$.${many}`, value: 0 }]),
      req(q('create'), 'POST', `/api/${many}`, [q('empty')], r(key), [status(q('create'), 201), { id: q('created_name'), op: 'jsonEquals', path: `$.${one}.name`, value: name }], { name: ` ${name} ` }),
      req(q('duplicate'), 'POST', `/api/${many}`, [q('create')], r(key), [status(q('duplicate'), 409)], { name }),
      req(q('blank'), 'POST', `/api/${many}`, [q('duplicate')], r(key), [status(q('blank'), 400)], { name: ' ' }),
      req(q('long'), 'POST', `/api/${many}`, [q('blank')], r(key), [status(q('long'), 400)], { name: 'x'.repeat(101) }),
      req(q('invalid'), 'POST', `/api/${many}`, [q('long')], r(key), [status(q('invalid'), 400)], { name: 42 }),
      { id: q('restart'), type: 'restart', dependsOn: [q('invalid')], requirementIds: r(key) },
      req(q('saved'), 'GET', `/api/${many}`, [q('restart')], r(key), [status(q('saved'), 200), { id: q('saved_count'), op: 'jsonLength', path: `$.${many}`, value: 1 }, { id: q('saved_name'), op: 'jsonEquals', path: `$.${many}[0].name`, value: name }]));
    branchIds[key] = steps.filter(step => step.id.startsWith(prefix)).map(step => step.id);
    const b = (id, op, value, testId) => ({ id: q(id), session: many, requirementIds: r(key), op, ...(op === 'goto' ? { path: value } : { testId: `${one}-${testId}`, value }) });
    web.push(b('open', 'goto', `/${many}.html`), b('initial', 'text', '0', 'count'), b('name', 'fill', `网页${title}`, 'name'), b('submit', 'click', undefined, 'create'),
      b('created_count', 'text', '1', 'count'), b('created_list', 'text', `网页${title}`, 'list'), b('repeat', 'fill', ` 网页${title} `, 'name'), b('again', 'click', undefined, 'create'),
      b('error', 'text', '名称已存在', 'error'), b('unchanged', 'text', '1', 'count'), b('reload', 'goto', `/${many}.html`), b('kept_count', 'text', '1', 'count'), b('kept_list', 'text', `网页${title}`, 'list'));
    assertions[key] = web.filter(step => step.session === many && ['visible', 'text', 'value', 'count'].includes(step.op)).map(step => step.id);
  }
  steps.push({ id: 'joint_restart', type: 'restart', dependsOn: ['notes_saved', 'tags_saved'], requirementIds: r('R-INTEGRATION') },
    ...[['note', 'notes', '便笺', 'R-NOTES'], ['tag', 'tags', '标签', 'R-TAGS']].map(([one, many, title, key]) => req(`joint_${many}`, 'GET', `/api/${many}`, ['joint_restart'], [ids['R-INTEGRATION'], ids[key]], [status(`joint_${many}`, 200), { id: `joint_${many}_count`, op: 'jsonLength', path: `$.${many}`, value: 1 }, { id: `joint_${many}_name`, op: 'jsonEquals', path: `$.${many}[0].name`, value: `接口${title}` }])));
  const browser = { version: 1, sessions: ['shell', 'notes', 'tags', 'integration'], limits: { timeoutMs: 120000, actionTimeoutMs: 8000 }, steps: [
    { id: 'shell_open', session: 'shell', requirementIds: r('R-SHELL'), op: 'goto', path: '/' }, { id: 'shell_title', session: 'shell', requirementIds: r('R-SHELL'), op: 'text', testId: 'app-shell', value: '便笺与标签管理' },
    { id: 'shell_notes', session: 'shell', requirementIds: r('R-SHELL'), op: 'visible', testId: 'nav-notes', value: true }, { id: 'shell_tags', session: 'shell', requirementIds: r('R-SHELL'), op: 'visible', testId: 'nav-tags', value: true }, ...web,
    { id: 'joint_home', session: 'integration', requirementIds: r('R-INTEGRATION'), op: 'goto', path: '/' },
    { id: 'joint_nav_notes', session: 'integration', requirementIds: r('R-INTEGRATION'), op: 'click', testId: 'nav-notes' },
    { id: 'joint_note_count', session: 'integration', requirementIds: r('R-INTEGRATION'), op: 'text', testId: 'note-count', value: '1' },
    { id: 'joint_note_list', session: 'integration', requirementIds: r('R-INTEGRATION'), op: 'text', testId: 'note-list', value: '网页便笺' },
    { id: 'joint_home_again', session: 'integration', requirementIds: r('R-INTEGRATION'), op: 'goto', path: '/' },
    { id: 'joint_nav_tags', session: 'integration', requirementIds: r('R-INTEGRATION'), op: 'click', testId: 'nav-tags' },
    { id: 'joint_tag_count', session: 'integration', requirementIds: r('R-INTEGRATION'), op: 'text', testId: 'tag-count', value: '1' },
    { id: 'joint_tag_list', session: 'integration', requirementIds: r('R-INTEGRATION'), op: 'text', testId: 'tag-list', value: '网页标签' },
  ] };
  // click has no value field in the browser contract.
  for (const step of browser.steps) if (step.op === 'click') delete step.value;
  const taskScopes = [{ taskId: 'BASE', httpStepIds: ['health', 'home', 'style', 'icon', 'icon_head'], browserStepIds: ['shell_title', 'shell_notes', 'shell_tags'] },
    { taskId: 'NOTES', httpStepIds: branchIds['R-NOTES'].filter(id => !id.endsWith('_restart')), browserStepIds: assertions['R-NOTES'] },
    { taskId: 'TAGS', httpStepIds: branchIds['R-TAGS'].filter(id => !id.endsWith('_restart')), browserStepIds: assertions['R-TAGS'] },
    { taskId: 'FINAL', httpStepIds: steps.map(step => step.id), browserStepIds: browser.steps.filter(step => ['visible', 'text', 'value', 'count'].includes(step.op)).map(step => step.id) }];
  return { version: 1, id: 'notes-tags-dag', name: '便笺与标签四任务联合验收', sessions: [], limits: { timeoutMs: 120000, requestTimeoutMs: 5000 }, steps, browser, taskScopes };
}
export const plannedNotesTags = Object.freeze({ requirements, spec, engineeringFor, definitionFor });
