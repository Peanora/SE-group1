import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  analyzeRequirements,
  analyzeWithModel,
  generateTasks,
  getModelConfig,
  renderSpec,
  renderArchitecture,
  renderTasks,
  renderReview,
  renderHandoff,
  reviewPlan,
  validateTaskGraph,
} from '../lib/planner.mjs';

test('项目标题包含验收等词时，仍按具体章节识别功能和验收', () => {
  const spec = analyzeRequirements('# 工作流验收需求\n\n## 项目目标\n通过网页创建和查询任务。\n\n## 功能需求\n- 用户可以创建任务，标题必填。\n- 用户可以查询任务列表。\n\n## 验收场景\n空标题被拒绝。');
  assert.equal(spec.requirements.length, 2);
  assert.match(spec.requirements[0].description, /创建任务/u);
  assert.deepEqual(spec.acceptanceScenarios, ['空标题被拒绝。']);
  assert.deepEqual(spec.goals, ['通过网页创建和查询任务。']);
});

const issueSource = await readFile(new URL('../examples/issue-tracker.md', import.meta.url), 'utf8');
const librarySource = await readFile(new URL('../examples/library-system.md', import.meta.url), 'utf8');

test('不同软件需求生成不同的规格与可追溯开发任务', () => {
  const issueSpec = analyzeRequirements(issueSource, '工单协作系统');
  const librarySpec = analyzeRequirements(librarySource, '校园图书借阅系统');
  const issueTasks = generateTasks(issueSpec);
  const libraryTasks = generateTasks(librarySpec);

  assert.ok(issueSpec.requirements.length > 0);
  assert.ok(librarySpec.requirements.length > 0);
  assert.match(JSON.stringify(issueTasks), /工单/);
  assert.match(JSON.stringify(libraryTasks), /借阅/);
  assert.notDeepEqual(issueTasks, libraryTasks);
  assert.equal(issueSpec.sourceMode, 'local');
  assert.equal(librarySpec.sourceMode, 'local');

  for (const [source, spec, tasks] of [[issueSource, issueSpec, issueTasks], [librarySource, librarySpec, libraryTasks]]) {
    assert.doesNotThrow(() => validateTaskGraph(tasks));
    const ids = spec.requirements.map(item => item.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const requirement of spec.requirements) {
      assert.ok(requirement.sourceQuote.trim());
      assert.ok(source.includes(requirement.sourceQuote), `原文中应存在 ${requirement.id} 的引用`);
      assert.ok(tasks.some(task => task.requirementIds.includes(requirement.id)), `${requirement.id} 应被开发任务覆盖`);
    }
  }
});

test('未决范围留在待确认问题，不生成承诺实现的开发任务', () => {
  const spec = analyzeRequirements(issueSource, '工单协作系统');
  const tasks = generateTasks(spec);
  assert.ok(spec.questions.some(question => question.includes('邮件通知') && question.includes('找回密码')));
  assert.doesNotMatch(JSON.stringify(spec.requirements), /邮件通知|找回密码|外部协作者/);
  assert.doesNotMatch(JSON.stringify(tasks), /邮件通知|找回密码|外部协作者/);
  assert.match(renderSpec(spec), /邮件通知/);

  const nested = analyzeRequirements('# 通知系统\n\n## 功能需求\n\n用户可以查看站内通知。\n\n## 待确认事项\n\n### 推送渠道\n\n- 是否需要短信通知。');
  assert.ok(nested.questions.some(question => question.includes('短信通知')));
  assert.doesNotMatch(JSON.stringify(nested.requirements), /短信通知/);
});

test('目标和角色单独保存，明确功能存在时角色不重复生成任务', () => {
  const spec = analyzeRequirements(issueSource, '工单协作系统');
  const role = '成员可以创建工单、查看自己提交或参与的工单，并追加评论。';
  assert.ok(Array.isArray(spec.roles));
  assert.ok(spec.roles.includes(role));
  assert.ok(spec.roles.some(item => item.includes('测试人员')));
  assert.ok(spec.goals.some(goal => goal.includes('5 至 20 人')));
  assert.ok(spec.requirements.every(requirement => requirement.description !== role));
  assert.ok(spec.requirements.every(requirement => !requirement.description.includes('为一个 5 至 20 人')));
});

test('全局验收场景保留，并进入规格文档或集成任务验收', () => {
  const spec = analyzeRequirements(issueSource, '工单协作系统');
  const tasks = generateTasks(spec);
  const firstScenario = '成员登录，创建一个高优先级工单，并在列表中搜索到该工单。';
  assert.ok(Array.isArray(spec.acceptanceScenarios));
  assert.ok(spec.acceptanceScenarios.includes(firstScenario));
  assert.ok(spec.acceptanceScenarios.every(scenario => issueSource.includes(scenario)));
  assert.ok(spec.requirements.every(requirement => !spec.acceptanceScenarios.includes(requirement.description)));
  const specMarkdown = renderSpec(spec);
  for (const scenario of spec.acceptanceScenarios) {
    assert.ok(
      specMarkdown.includes(scenario) || tasks.some(task => task.acceptance.includes(scenario)),
      `应在交付文档中保留验收场景：${scenario}`,
    );
  }
});

test('生成的 task 文档包含每项任务和可检查的依赖与验收', () => {
  const spec = analyzeRequirements(issueSource, '工单协作系统');
  const tasks = generateTasks(spec);
  const markdown = renderTasks(spec, tasks);
  assert.match(markdown, /前置依赖|依赖|dependsOn/);
  assert.match(markdown, /验收/);
  assert.match(markdown, /待开发/);
  for (const task of tasks) {
    assert.ok(markdown.includes(task.id), `应展示任务 ${task.id}`);
    assert.ok(markdown.includes(task.title), `应展示 ${task.id} 的任务名`);
    assert.ok(task.acceptance.length > 0, `${task.id} 应有验收条件`);
    assert.ok(task.acceptance.every(item => item.trim()));
    for (const dependency of task.dependsOn) assert.ok(markdown.includes(dependency));
    for (const requirementId of task.requirementIds) assert.ok(markdown.includes(requirementId));
  }
});

test('结构审查覆盖全部需求，删除需求映射会被检出', () => {
  const spec = analyzeRequirements(librarySource, '校园图书借阅系统');
  const tasks = generateTasks(spec);
  const review = reviewPlan(spec, tasks);
  assert.equal(review.passed, true);
  assert.equal(review.coverage.length, spec.requirements.length);
  assert.ok(review.coverage.every(item => item.taskIds.length > 0));
  assert.match(renderReview(review), /需求覆盖/);

  const broken = structuredClone(tasks);
  const requirementId = spec.requirements[0].id;
  for (const task of broken) task.requirementIds = task.requirementIds.filter(id => id !== requirementId);
  const brokenReview = reviewPlan(spec, broken);
  assert.equal(brokenReview.passed, false);
  assert.ok(brokenReview.issues.some(issue => issue.includes(requirementId)));
});

test('任务图拒绝重复编号、未知依赖、自环和循环依赖', () => {
  assert.throws(() => validateTaskGraph([]));
  assert.throws(() => validateTaskGraph([{ id: 'A', dependsOn: [] }, { id: 'A', dependsOn: [] }]));
  assert.throws(() => validateTaskGraph([{ id: 'A', dependsOn: ['MISSING'] }]));
  assert.throws(() => validateTaskGraph([{ id: 'A', dependsOn: ['A'] }]));
  assert.throws(() => validateTaskGraph([{ id: 'A', dependsOn: ['B'] }, { id: 'B', dependsOn: ['A'] }]));
  assert.doesNotThrow(() => validateTaskGraph([
    { id: 'A', dependsOn: [] },
    { id: 'B', dependsOn: ['A'] },
    { id: 'C', dependsOn: ['A'] },
    { id: 'D', dependsOn: ['B', 'C'] },
  ]));
});

test('空白文档和只有标题的文档不能伪装成有效需求', () => {
  for (const source of ['', '  \n\t ', '# 空白项目\n\n## 功能需求\n']) {
    assert.throws(() => analyzeRequirements(source));
  }
  assert.throws(() => analyzeRequirements('需求'.repeat(50_001)));
});

test('需求中的 HTML 和审阅意见以文本写入 Markdown', () => {
  const malicious = '评论需要显示 <img src=x onerror="alert(1)"> 和 <script>alert(2)</script>，不得执行标签。';
  const spec = analyzeRequirements(`# 评论系统\n\n## 评论展示\n\n${malicious}`);
  const tasks = generateTasks(spec);
  const review = reviewPlan(spec, tasks);
  const documents = [renderSpec(spec), renderArchitecture(spec), renderTasks(spec, tasks), renderReview(review), renderHandoff(spec, tasks, review, malicious)];
  for (const markdown of documents) {
    assert.doesNotMatch(markdown, /<script\b|<img\b/i);
  }
  assert.ok(renderSpec(spec).includes('&lt;script&gt;'));
  assert.ok(renderTasks(spec, tasks).includes('&lt;img'));
  assert.ok(renderHandoff(spec, tasks, review, malicious).includes('&lt;script&gt;'));
});

test('模型适配器使用注入的服务并保留可校验的原文引用', async () => {
  const source = '用户可以按书名查询图书。';
  const fakeSpec = {
    title: '图书查询', summary: '提供馆藏检索。', goals: ['查询馆藏'],
    requirements: [{ title: '按书名查询', description: source, acceptance: ['输入已知书名可找到对应图书。'], sourceQuote: source, kind: 'functional' }],
    constraints: [], assumptions: [], questions: ['确认搜索匹配方式。'],
    stack: { frontend: '待确认', backend: '待确认', storage: '待确认' },
  };
  let request;
  const secret = 'test-secret-never-publish';
  const spec = await analyzeWithModel(source, '图书查询', {
    config: { baseUrl: 'https://model.invalid/v1', model: 'test-model', apiKey: secret },
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fakeSpec) } }] }), { status: 200 });
    },
  });
  assert.equal(spec.sourceMode, 'model');
  assert.equal(spec.requirements[0].sourceQuote, source);
  assert.equal(request.url, 'https://model.invalid/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, `Bearer ${secret}`);
  const requestBody = JSON.parse(request.options.body);
  assert.equal(requestBody.model, 'test-model');
  assert.ok(requestBody.messages.some(message => message.role === 'user' && message.content.includes(source)));
  const tasks = generateTasks(spec);
  assert.equal(reviewPlan(spec, tasks).passed, true);
  assert.ok(!JSON.stringify(spec).includes(secret));
  assert.ok(!renderTasks(spec, tasks).includes(secret));
  assert.ok(!('apiKey' in getModelConfig()));
});

test('模型凭空生成的原文引用会被拒绝', async () => {
  const fakeSpec = {
    title: '图书查询', summary: '测试不可追溯引用。', goals: ['检索'],
    requirements: [{ title: '检索', description: '搜索图书', acceptance: ['查到图书'], sourceQuote: '这是原文中不存在的内容', kind: 'functional' }],
    constraints: [], assumptions: [], questions: [], stack: { frontend: '待确认', backend: '待确认', storage: '待确认' },
  };
  await assert.rejects(analyzeWithModel('用户可以按书名查询图书。', '图书查询', {
    config: { baseUrl: 'https://model.invalid/v1', model: 'test-model' },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fakeSpec) } }] }), { status: 200 }),
  }), /原文引用|需求文档/);
});

test('模型服务错误不回显服务响应中的密钥或敏感内容', async () => {
  const secret = 'test-private-response-content';
  await assert.rejects(analyzeWithModel('用户可以查询工单。', '工单系统', {
    config: { baseUrl: 'https://model.invalid/v1', model: 'test-model', apiKey: secret },
    fetchImpl: async () => new Response(`upstream diagnostic: ${secret}`, { status: 401 }),
  }), error => {
    assert.match(error.message, /HTTP 401/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
});
