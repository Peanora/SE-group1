import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import { currentMeeting, OfflineSpecificationRoles } from '../lib/specification-meeting.mjs';
import { reservationMeetingPlanner, reservationMeetingSource } from '../examples/specification-meeting.mjs';

const until = async check => { for (let i = 0; i < 1000; i++) { if (check()) return; await delay(10); } throw new Error('等待规格评审页面超时'); };
test('Edge实际页面：六节点、业务裁决、新规格重审、刷新联合确认与同版导出', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'spec-meeting-browser-'));
  const roles = new OfflineSpecificationRoles();
  let releaseBaseline;
  let baselineRequested = false;
  const baseline = new Promise(resolve => { releaseBaseline = resolve; });
  const specificationMeetingExecutor = {
    propose: request => roles.propose(request),
    async review(request) {
      if (request.nodeId === 'baseline' && !baselineRequested) {
        baselineRequested = true;
        await baseline;
      }
      return roles.review(request);
    },
  };
  const app = await createApp({ dataDir: directory, stepDelayMs: 0, planner: reservationMeetingPlanner,
    specificationMeetingExecutor, specificationMeetingTimeoutMs: 15000 });
  let browser;
  t.after(async () => { releaseBaseline(); await browser?.close(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  const project = await app.store.create({ name: '规格多 Agent 评审', source: { filename: 'reservation.md', content: reservationMeetingSource } });
  const run = await app.orchestrator.createRun(project.id);
  await until(() => run.status === 'awaiting_spec');
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  const panel = page.locator('#specification-meeting-host');
  const heading = panel.getByRole('heading', { name: '多 Agent 规格评审', exact: true });
  await page.getByRole('button', { name: '处理规格', exact: true }).click();
  assert.equal(await heading.evaluate(node => document.activeElement === node), true);
  await page.locator('#workspace-tab-overview').click();
  await page.locator('[data-delivery-step="spec-approval"]').click();
  assert.equal(await heading.evaluate(node => document.activeElement === node), true);
  const livePhase = panel.locator('[data-phase-live="true"]');
  await page.getByRole('button', { name: '启用本版离线评审', exact: true }).click();
  try {
    await until(() => baselineRequested);
    await livePhase.getByText('等待本次响应', { exact: true }).waitFor();
    assert.equal(await livePhase.count(), 1);
    assert.equal(await livePhase.locator('button').getAttribute('data-node'), 'baseline');
    assert.equal(await panel.getByRole('button', { name: '继续离线评审', exact: true }).isDisabled(), true);
    const marker = livePhase.locator('.sm-map-stop');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    assert.notEqual(await marker.evaluate(node => getComputedStyle(node).animationName), 'none');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await marker.evaluate(node => getComputedStyle(node).animationName), 'none');
  } finally {
    releaseBaseline();
  }
  await page.getByRole('button', { name: '查看问题并裁决', exact: true }).waitFor();
  await livePhase.waitFor({ state: 'detached' });
  assert.equal(currentMeeting(run).status, 'awaiting_decision');
  assert.equal(await page.getByRole('button', { name: '确认规格与阶段清单并继续', exact: true }).isDisabled(), true);
  const topic = currentMeeting(run).discussion.topics.find(item => item.requirementId === 'R-CANCEL');
  await panel.getByRole('button', { name: '议题讨论', exact: true }).click();
  await panel.getByRole('combobox', { name: '业务议题' }).selectOption(topic.id);
  const discussion = panel.getByRole('region', { name: '同议题提案与交叉质疑' });
  assert.equal(await discussion.locator('.sm-discussion-columns > section').count(), 2);
  assert.ok(await discussion.locator('.sm-discussion-columns > section').first().locator('li').count() > 1);
  assert.ok(await discussion.locator('.sm-discussion-columns > section').last().locator('li').count() > 1);
  await panel.getByRole('button', { name: '问题分流', exact: true }).click();
  await panel.getByRole('heading', { name: '由用户裁决', exact: true }).waitFor();
  assert.equal(await panel.locator('[data-route-kind="human_decision"] ul > li').count(), currentMeeting(run).issues.length);
  const original = run.specRevision;
  await page.getByRole('button', { name: '查看问题并裁决', exact: true }).click();
  const choices = currentMeeting(run).issues;
  for (const issue of choices) await page.locator(`[data-issue-answer="${issue.id}"]`).fill(issue.options[0]);
  await page.locator('[data-issue-continue]').click();
  await until(() => run.specRevision !== original);
  await page.getByRole('button', { name: '继续离线评审', exact: true }).click();
  await until(() => currentMeeting(run).status === 'awaiting_confirmation');
  assert.equal(run.stages.find(s => s.id === 'architecture').attempt, 0);
  const bundle = currentMeeting(run).bundleRevision;
  await page.reload();
  await page.getByRole('button', { name: '确认规格与阶段清单并继续', exact: true }).waitFor();
  const meeting = currentMeeting(run);
  assert.equal(meeting.bundleRevision, bundle);
  await panel.getByRole('button', { name: '查看设计规格', exact: true }).waitFor();
  assert.equal(await panel.locator('button[data-meeting="node"]').count(), meeting.nodes.length);
  const confirmationPhase = panel.locator('button[data-node="confirmation"]');
  await confirmationPhase.getByText('待用户确认', { exact: true }).waitFor();
  const specPhase = panel.locator('button[data-node="specification"]');
  await specPhase.click();
  assert.equal(await specPhase.getAttribute('aria-pressed'), 'true');
  assert.equal(await specPhase.evaluate(node => document.activeElement === node), true);
  const specNode = meeting.nodes.find(node => node.id === 'specification');
  await panel.getByRole('heading', { name: specNode.title, exact: true }).waitFor();
  const selfTest = panel.locator('.sm-measure > div').filter({ hasText: '主责自测' });
  assert.equal(await selfTest.locator('dd').textContent(), '通过');
  await panel.getByText(specNode.selfTest.artifactRevision.slice(0, 10), { exact: true }).waitFor();
  const receipts = panel.getByRole('list', { name: '同版本 Review 回执', exact: true });
  assert.equal(await receipts.locator(':scope > li').count(), specNode.reviews.length);
  await panel.getByText('同版本产物、自测及角色 Review 证据', { exact: true }).click();
  const nodeRecord = panel.locator('[data-meeting-detail="node-record"] pre');
  assert.match(await nodeRecord.textContent(), new RegExp(specNode.selfTest.artifactRevision));
  assert.equal(await nodeRecord.isVisible(), true);

  await panel.getByRole('button', { name: '逐条评审', exact: true }).click();
  const featureRecords = panel.locator('[data-meeting-detail^="feature-"]');
  assert.equal(await featureRecords.count(), run.spec.requirements.length);
  assert.equal(await featureRecords.count(), meeting.featureReviews.length);
  for (const [index, definition] of meeting.featureReviews.entries()) {
    const record = featureRecords.nth(index);
    await record.locator('summary').click();
    assert.equal(await record.locator('summary').textContent(), definition.specClause);
    assert.equal(await record.getByText('业务行为', { exact: true }).first().isVisible(), true);
    assert.equal(await record.getByText('格式与规范', { exact: true }).first().isVisible(), true);
    assert.equal(await record.getByText(definition.rework, { exact: false }).isVisible(), true);
  }
  await panel.getByRole('button', { name: '阶段门禁', exact: true }).click();
  await panel.getByRole('heading', { name: '阶段验收与 Review 清单（定义，不代表已执行）', exact: true }).waitFor();
  const gateRecords = panel.locator('[data-meeting-detail^="gate-"]');
  assert.equal(await gateRecords.count(), meeting.checklist.length);
  for (const [index, stage] of meeting.checklist.entries()) {
    const record = gateRecords.nth(index);
    await record.locator('summary').click();
    assert.equal(await record.locator('summary').textContent(), stage.title);
    assert.equal(await record.getByText(stage.requiredEvidence, { exact: false }).isVisible(), true);
    assert.equal(await record.getByText(stage.rework, { exact: false }).isVisible(), true);
  }
  await panel.locator('button[data-node="proposals"]').click();
  assert.equal(await panel.locator('.sm-seats .sm-seat').count(), 6);
  const output = path.resolve('output/specification-meeting-verification'); await mkdir(output, { recursive: true });
  await panel.screenshot({ path: path.join(output, 'review-map-1440.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await panel.evaluate(host => document.documentElement.scrollWidth <= innerWidth + 1 &&
    host.scrollWidth <= host.clientWidth + 1 && host.querySelector('.sm-map').scrollWidth <= host.querySelector('.sm-map').clientWidth + 1), true);
  await panel.screenshot({ path: path.join(output, 'review-map-390.png'),
    style: '.skip-link, .topbar, #workspace-nav { visibility: hidden; }' });
  await page.getByRole('button', { name: '确认规格与阶段清单并继续', exact: true }).click();
  await until(() => run.status === 'awaiting_review');
  await page.getByRole('button', { name: '确认计划并导出', exact: true }).click();
  await until(() => run.status === 'succeeded');
  assert.equal(currentMeeting(run).confirmation.bundleRevision, bundle);
  assert.equal(run.approvals.spec.meetingRevision, bundle);
  await page.getByText('本版规格与阶段清单已联合确认', { exact: true }).waitFor();
  await confirmationPhase.getByText('通过', { exact: true }).waitFor();
  const base = `http://127.0.0.1:${app.server.address().port}/api/projects/${project.id}/runs/${run.id}`;
  const minutes = await (await fetch(`${base}/artifacts/spec-review-minutes.json`)).json();
  const checklist = await (await fetch(`${base}/artifacts/stage-review-checklist.json`)).json();
  assert.equal(minutes.rounds.length, 2); assert.equal(checklist.bundleRevision, bundle);
  assert.equal(checklist.confirmation.bundleRevision, bundle); assert.equal(checklist.definitionOnly, true);
  const zip = await fetch(`${base}/download`); assert.equal(zip.status, 200);
  assert.ok(Buffer.from(await zip.arrayBuffer()).includes(Buffer.from('spec-review-minutes.json')));
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
  assert.deepEqual(errors, []);
});
