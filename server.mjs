import http from 'node:http';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { ProjectStore } from './lib/store.mjs';
import { Orchestrator } from './lib/orchestrator.mjs';
import { HttpError, parseDocument } from './lib/documents.mjs';
import { createZip } from './lib/zip.mjs';
import { SimulatedTaskService } from './lib/simulated-tasks.mjs';
import { createLocalExecutionSubject, restoreLocalExecutionSubject } from './lib/team-access.mjs';
import { createVerificationRecovery } from './lib/verification-recovery.mjs';
import { loginContinuationDraft, loginRevisionNote, loginRevisionTask, previousLoginPlan } from './lib/verification-login-continuation.mjs';
import { reconcileEndedPreviews } from './lib/preview-output-recovery.mjs';
import { AGENT_ROLES, createAgentSettings } from './lib/agent-settings.mjs';
import { createAgentPlanner } from './lib/agent-planner.mjs';
import { AUTOMATIC_BUDGET, createAutomaticDelivery } from './lib/automatic-delivery.mjs';
import { repeatedCounterSteps } from './public/verification-draft.js';

import { DEFAULT_STACK, PLATFORM_DEFAULTS } from './lib/platform-defaults.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_REQUEST = 6 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const requestBodies = new WeakMap();
const requestChecks = new WeakMap();
const responseRedactors = new WeakMap();

async function verificationContinuation(service, identity, base) {
  const budget = base.capabilities?.budget;
  if (budget?.remainingAttempts !== 0 || !Number.isInteger(budget.maxAttempts)) return null;
  const models = base.proposals.filter(row => row.origin === 'model');
  const previous = models.at(-1), stage = previous?.nextGenerationStage;
  if (!previous?.current || previous.status !== 'draft' || previous.receiptState !== 'saved'
    || !previous.proposal?.steps?.length || !['http', 'http-supplement'].includes(previous.generationStage)
    || !['http-supplement', 'browser'].includes(stage)) return null;
  const extra = models.slice(budget.maxAttempts);
  if (extra.length && (extra.length !== 1 || extra[0].generationStage !== 'http-supplement' || stage !== 'browser')) return null;

  const additionalAttempts = stage === 'http-supplement' || extra.length ? 2 : 1;
  const continued = await service.list(identity, { additionalAttempts });
  const latest = continued.proposals.findLast(row => row.origin === 'model');
  const cap = continued.capabilities;
  if (!cap?.canPropose || !latest?.current || latest.id !== previous.id || latest.revision !== previous.revision
    || latest.nextGenerationStage !== stage) return null;
  const contractRevision = createHash('sha256').update(JSON.stringify([identity, cap.contractRevision, previous.id, previous.revision, stage])).digest('hex');
  return {
    capability: { canPropose: true, stage, contractRevision, budget: cap.budget, model: cap.model },
    serviceContractRevision: cap.contractRevision,
    options: { additionalAttempts, previousProposalId: previous.id },
  };
}

async function readJson(request) {
  requestChecks.get(request)?.();
  if (requestBodies.has(request)) return requestBodies.get(request);
  if (!/^application\/json(?:;|$)/iu.test(request.headers['content-type'] ?? '')) throw new HttpError(400, '请使用 application/json 提交数据。');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST) throw new HttpError(400, '上传请求不能超过 6 MB。');
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    requestChecks.get(request)?.(); requestBodies.set(request, parsed); return parsed;
  } catch (error) { if (Number.isInteger(error.status)) throw error; throw new HttpError(400, '请求不是有效的 JSON 对象。'); }
}

function respond(response, status, body, contentType = 'application/json; charset=utf-8', headers = {}) {
  if (contentType.startsWith('application/json') && body && typeof body === 'object' && !Buffer.isBuffer(body)) body = responseRedactors.get(response)?.(body) ?? body;
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  response.writeHead(status, { 'Content-Type': contentType, 'Content-Length': bytes.length, 'Cache-Control': 'no-store', ...headers });
  response.end(bytes);
}

// Costly execution and its private records are local-workbench capabilities.
// Bind Host to the listening port as well as loopback to reject DNS rebinding.
function requireLocalExecutionRequest(request, server) {
  let target;
  try { target = new URL(`http://${request.headers.host}`); } catch { throw new HttpError(403, '请从本机工作台查看或操作代码执行。'); }
  const address = server.address();
  if (!address || typeof address !== 'object' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    || target.username || target.password || target.pathname !== '/' || target.search || target.hash
    || Number(target.port || 80) !== address.port || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) {
    throw new HttpError(403, '请从本机工作台查看或操作代码执行。');
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '请从本机工作台发起代码执行操作。');
}

function exactFields(body, fields) {
  if (Object.keys(body).length !== fields.length || fields.some(field => typeof body[field] !== 'string' || !body[field])) throw new HttpError(400, '执行请求字段无效，请刷新范围与状态后重试。');
  return body;
}

function dataFields(body, fields) {
  if (Object.keys(body).length !== fields.length || fields.some(field => !Object.hasOwn(body, field))) throw new HttpError(400, '变更请求字段无效，请刷新当前输入版本后重试。');
  return body;
}

/** Load local dotenv values without dependencies, never overriding process variables. */
export async function loadEnv(filename = path.join(ROOT, '.env')) {
  let contents;
  try { contents = await readFile(filename, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/u, '').trim();
    process.env[match[1]] = value;
  }
}

export async function createApp(options = {}) {
  const store = options.store ?? await new ProjectStore(options.dataDir ?? process.env.DATA_DIR ?? path.join(ROOT, 'data')).init();
  let agentSettings;
  try { agentSettings = await createAgentSettings({ directory: path.join(store.directory, 'agent-settings'), ...(options.agentEnvironment === undefined ? {} : { environment: options.agentEnvironment }) }); }
  catch (cause) { try { await options.executionService?.shutdown(); } catch { cause.executionCleanupFailed = true; } throw cause; }
  const planner = options.planner ?? createAgentPlanner(await import('./lib/planner.mjs'), agentSettings);
  const orchestrator = new Orchestrator(store, planner, { stepDelayMs: options.stepDelayMs ?? process.env.WORKFLOW_STEP_DELAY_MS ?? 350,
    ...Object.fromEntries(['engineeringMaxCalls', 'engineeringTimeoutMs', 'engineeringTotalTimeoutMs'].filter(key => options[key] !== undefined).map(key => [key, options[key]])),
    ...(options.specificationMaxCalls === undefined ? {} : { specificationMaxCalls: options.specificationMaxCalls }),
    ...(options.specificationTimeoutMs === undefined ? {} : { specificationTimeoutMs: options.specificationTimeoutMs }) });
  const executionService = options.executionService === null ? null : options.executionService ?? await (await import('./lib/web-execution-service.mjs')).createWebExecutionService({
    rootDir: path.resolve(options.executionRootDir ?? path.join(store.directory, 'executions')),
    getPlanning: async (projectId, runId) => store.getPersistedRun(projectId, runId),
    getConfig: () => agentSettings.resolve('coding'), getReviewConfig: () => agentSettings.resolve('review'),
  });
  try { await orchestrator.init(); }
  catch (cause) { try { await executionService?.shutdown(); } catch { cause.executionCleanupFailed = true; } throw cause; }
  const simulationService = new SimulatedTaskService(store, { executor: options.simulatedExecutor,
    assertControlAvailable: projectId => {
      if (orchestrator.closed || orchestrator.projectActions.has(projectId) || orchestrator.projectAdmissions.has(projectId) || orchestrator.projectCheckpoints.has(projectId)) throw new HttpError(409, '项目规划或需求变更正在保存，请稍后操作模拟运行。');
    },
    withCheckpoint: (projectId, work) => orchestrator.withProjectCheckpoint(projectId, work) });
  try { await simulationService.init(); }
  catch (cause) { await Promise.allSettled([orchestrator.shutdown(), executionService?.shutdown()]); throw cause; }
  orchestrator.assertSimulationIdle = projectId => simulationService.assertIdle(projectId);
  const verificationRoot = path.resolve(options.verificationPlanningRootDir ?? path.join(store.directory, 'verification-planning'));
  const plannedRoot = path.resolve(options.plannedExecutionRootDir ?? path.join(store.directory, 'planned-executions'));
  const verificationRecovery = createVerificationRecovery({ root: verificationRoot, getPlanning: (projectId, runId) => store.getPersistedRun(projectId, runId) });
  let sourceChangeService, verificationPlanningService, plannedExecutionService, teamAccess, localReleasesService, plannedDatasetService, evolutionService, automaticDelivery;
  try {
    verificationPlanningService = options.verificationPlanningService === null ? null : options.verificationPlanningService ?? await (await import('./lib/verification-planning-service.mjs')).createVerificationPlanningService({
      rootDir: verificationRoot,
      getPlanning: async (projectId, runId) => store.getPersistedRun(projectId, runId),
      getPlanningSync: (projectId, runId) => store.getPersistedRun(projectId, runId),
      getConfig: () => agentSettings.resolve('verification'),
    });
    if (options.plannedExecutionService === undefined) await reconcileEndedPreviews(path.join(plannedRoot, 'previews'));
    plannedExecutionService = options.plannedExecutionService === null ? null : options.plannedExecutionService ?? await (await import('./lib/planned-execution-service.mjs')).createPlannedExecutionService({
      rootDir: plannedRoot, verificationService: verificationPlanningService,
      getPlanningSync: (projectId, runId) => store.getPersistedRun(projectId, runId),
      getConfig: () => agentSettings.resolve('coding'), getReviewConfig: () => agentSettings.resolve('review'),
      timeoutMs: options.plannedExecutionTimeoutMs,
      dependencies: {
        // Interactive browsing transfers more approved assets than one scripted acceptance.
        startPreviewRuntime: async input => (await import('./lib/web-runtime.mjs')).startWebRuntime({ ...input, maxOutputBytes: 4 * 1024 * 1024 }),
        hasExternalActivity: projectId => !!localReleasesService?.hasActivity(projectId) || !!evolutionService?.hasActivity(projectId) || !!plannedDatasetService?.hasActivity(projectId),
        requiresExecutionSubject: () => !!teamAccess },
      withCheckpoint: (projectId, work) => orchestrator.withProjectCheckpoint(projectId, () => {
        if (typeof executionService?.withProjectCheckpoint !== 'function') throw new HttpError(409, '无法核对已有代码执行状态，暂不能开始研发。');
        return executionService.withProjectCheckpoint(projectId, work);
      }),
    });
    const localLifecycleEnabled = options.localLifecycleEnabled ?? (typeof plannedExecutionService?.authorizeAcceptedSource === 'function' && typeof verificationPlanningService?.assertApprovedDefinition === 'function');
    if (localLifecycleEnabled) {
      const lifecycleCheckpoint = (projectId, work) => orchestrator.withProjectCheckpoint(projectId, () => {
        if (![executionService, verificationPlanningService, plannedExecutionService].every(service => typeof service?.withProjectCheckpoint === 'function')) throw new HttpError(409, '当前服务无法核对本机业务版本的安全检查点。');
        return executionService.withProjectCheckpoint(projectId, () => verificationPlanningService.withProjectCheckpoint(projectId, () => plannedExecutionService.withProjectCheckpoint(projectId, work)));
      });
      localReleasesService = options.localReleasesService ?? await (await import('./lib/planned-local-releases.mjs')).createPlannedLocalReleases({
        rootDir: path.join(plannedRoot, 'local-releases'), authorizeExecution: (input, context) => plannedExecutionService.authorizeAcceptedSource(input, context),
        withCheckpoint: lifecycleCheckpoint, assertIdle: () => true,
      });
      plannedDatasetService = options.plannedDatasetService ?? await (await import('./lib/planned-dataset.mjs')).createPlannedDatasetService({
        rootDir: path.join(plannedRoot, 'datasets'), sourceRootDir: plannedRoot, authorizeStoppedDataset: runtimeRef => localReleasesService.authorizeStoppedDataset(runtimeRef),
      });
      evolutionService = options.evolutionService ?? await (await import('./lib/planned-evolution.mjs')).createPlannedEvolutionService({
        rootDir: path.join(plannedRoot, 'evolutions'), sourceRootDir: plannedRoot, getPlanningSync: (projectId, runId) => store.getPersistedRun(projectId, runId),
        verificationService: verificationPlanningService, plannedService: plannedExecutionService, releaseService: localReleasesService, datasetService: plannedDatasetService, withCheckpoint: lifecycleCheckpoint,
      });
    }
    sourceChangeService = options.sourceChangeService === null ? null : options.sourceChangeService ?? await (await import('./lib/source-change-service.mjs')).createSourceChangeService({
      rootDir: path.resolve(options.sourceChangeRootDir ?? path.join(store.directory, 'source-changes')), store,
      withCheckpoint: (projectId, work) => orchestrator.withProjectCheckpoint(projectId, () => {
        if (typeof executionService?.withProjectCheckpoint !== 'function' || typeof verificationPlanningService?.withProjectCheckpoint !== 'function' || typeof plannedExecutionService?.withProjectCheckpoint !== 'function') throw new HttpError(409, '执行或测试提案服务无法确认项目安全检查点，变更仍可保存为待应用。');
        return executionService.withProjectCheckpoint(projectId, () => verificationPlanningService.withProjectCheckpoint(projectId, () => plannedExecutionService.withProjectCheckpoint(projectId, work)));
      }),
    });
    if (options.teamEnabled ?? process.env.TASKFLOW_TEAM_MODE === '1') teamAccess = await (await import('./lib/team-access.mjs')).createTeamAccess({ rootDir: path.resolve(options.teamRootDir ?? path.join(store.directory, 'team-access')) });
    automaticDelivery = createAutomaticDelivery({
      store, orchestrator, verification: verificationPlanningService, planned: plannedExecutionService, recovery: verificationRecovery,
      getSettingsRevision: () => agentSettings.view().revision,
      getSettingsFingerprint: authorizationId => createHmac('sha256', authorizationId)
        .update(JSON.stringify(AGENT_ROLES.map(({ id }) => agentSettings.resolve(id)))).digest('hex'),
      restoreSubject: value => teamAccess ? teamAccess.restoreExecutionSubject(value) : restoreLocalExecutionSubject(value),
      checkProject: projectId => orchestrator.withProjectCheckpoint(projectId, () => {
        const services = [executionService, verificationPlanningService, plannedExecutionService].filter(Boolean);
        const check = index => index === services.length ? undefined : services[index].withProjectCheckpoint(projectId, () => check(index + 1));
        return check(0);
      }),
      preflight: () => {
        if (!planner.getModelConfig().configured) throw new HttpError(409, '请在 Agent 角色中配置需求分析模型。');
        try {
          for (const role of ['engineering', 'verification', 'coding', 'review']) agentSettings.resolve(role);
        } catch { throw new HttpError(409, '请在 Agent 角色中配置工程规划、测试设计、编码和代码审查后再启动。'); }
        if (plannedExecutionService.canPrepare?.() === false) throw new HttpError(409, '代码隔离执行或交付凭据尚不可用。请检查本机执行配置后再启动。');
      },
    });
    orchestrator.assertAutomaticDispatch = automaticDelivery.assertDispatch;
    await automaticDelivery.init();
  } catch (cause) { await automaticDelivery?.shutdown(); await Promise.allSettled([evolutionService?.shutdown(), localReleasesService?.shutdown(), plannedDatasetService?.close(), simulationService.shutdown(), orchestrator.shutdown(), executionService?.shutdown(), verificationPlanningService?.shutdown(), plannedExecutionService?.shutdown(), teamAccess?.close()]); throw cause; }
  const fixedAdmission = (projectId, work) => {
    if (typeof verificationPlanningService?.withProjectCheckpoint !== 'function' || typeof plannedExecutionService?.withProjectCheckpoint !== 'function') throw new HttpError(409, '尚不能核对测试提案和研发执行状态。');
    return verificationPlanningService.withProjectCheckpoint(projectId, () => plannedExecutionService.withProjectCheckpoint(projectId, work));
  };
  const atPlanRevisionCheckpoint = (projectId, work) => {
    const services = [executionService, verificationPlanningService, plannedExecutionService].filter(Boolean);
    if (services.some(service => typeof service.withProjectCheckpoint !== 'function')) {
      throw new HttpError(409, '无法核对项目是否有开发、验收准备或预览在途，修改草稿仍可保留。');
    }
    return services.reduceRight((next, service) => () => service.withProjectCheckpoint(projectId, next), work)();
  };
  let closing;
  const publicDir = path.resolve(options.publicDir ?? path.join(ROOT, 'public'));
  function beginTeamAudit(request, response, actor, target) {
    const requestId = randomUUID(); teamAccess.audit({ requestId, actor, action: `request.${request.method}`, target, status: 0 });
    response.setHeader('X-Request-Id', requestId);
    response.once('finish', () => { try { teamAccess.audit({ requestId, actor, action: 'request.finished', target, status: response.statusCode }); } catch { console.error('[team] 操作结果审计未能写入，请核对已有请求记录。'); } });
    return { requestId };
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const url = new URL(request.url, 'http://localhost');
      let segments;
      try { segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
      catch { throw new HttpError(400, '网址编码无效。'); }
      const method = request.method;
      if (segments[0] === 'api') {
        responseRedactors.set(response, value => agentSettings.redact(value));
        if (closing) throw new HttpError(503, '工作台正在停止，请稍后重新连接。');
        // No cross-site mutations to a local workspace. The app uses same-origin JSON.
        if (method !== 'GET' && method !== 'HEAD' && request.headers.origin) {
          let origin;
          try { origin = new URL(request.headers.origin); } catch { throw new HttpError(403, '请求来源无效。'); }
          if (origin.host !== request.headers.host || !['http:', 'https:'].includes(origin.protocol)) throw new HttpError(403, '请从本地工作台发起操作。');
        }
        if (segments[1] === 'team') {
          requireLocalExecutionRequest(request, server);
          const auditContext = teamAccess && !['GET', 'HEAD'].includes(method) ? beginTeamAudit(request, response, teamAccess.identity(request.headers.cookie), url.pathname.slice(0, 1000)) : {};
          if (segments.length === 3 && segments[2] === 'session' && method === 'GET') return respond(response, 200, { enabled: !!teamAccess, setupRequired: teamAccess?.setupRequired() ?? false, user: teamAccess?.identity(request.headers.cookie) ?? null });
          if (!teamAccess) throw new HttpError(404, '团队登录尚未启用。');
          if (segments.length === 3 && ['setup', 'login'].includes(segments[2]) && method === 'POST') {
            const result = await teamAccess[segments[2]](await readJson(request), auditContext);
            if (result.rejected) throw new HttpError(401, '账号或密码无效。');
            return respond(response, segments[2] === 'setup' ? 201 : 200, { user: result.user }, undefined, { 'Set-Cookie': result.cookie });
          }
          if (segments.length === 3 && segments[2] === 'logout' && method === 'POST') {
            dataFields(await readJson(request), []); const result = teamAccess.logout(request.headers.cookie, auditContext); return respond(response, 200, { loggedOut: true }, undefined, { 'Set-Cookie': result.cookie });
          }
          if (segments.length === 3 && segments[2] === 'members') {
            if (method === 'GET') return respond(response, 200, { members: teamAccess.listMembers(request.headers.cookie) });
            if (method === 'POST') return respond(response, 201, { member: await teamAccess.createMember(request.headers.cookie, await readJson(request), auditContext) });
          }
          if (segments.length === 4 && segments[2] === 'members' && method === 'PATCH') return respond(response, 200, { member: teamAccess.updateMember(request.headers.cookie, segments[3], await readJson(request), auditContext) });
          if (segments.length === 3 && segments[2] === 'audit' && method === 'GET') return respond(response, 200, teamAccess.events(request.headers.cookie, Number(url.searchParams.get('after') ?? '0')));
          throw new HttpError(404, '未找到该账号接口。');
        }
        if (method === 'GET' && segments.length === 2 && segments[1] === 'health') {
          const config = planner.getModelConfig();
          return respond(response, 200, { ok: true, teamAccess: { enabled: !!teamAccess }, verificationPlanning: { available: !!verificationPlanningService, phase: 'definition_only', failureRecovery: !!verificationPlanningService }, plannedExecution: { available: !!plannedExecutionService && !!verificationPlanningService, profile: 'planned-web-v1' }, localEvolution: { available: !!localReleasesService && !!evolutionService && !!plannedDatasetService }, platformDefaults: { ...PLATFORM_DEFAULTS, stack: { ...DEFAULT_STACK } }, model: { configured: config.configured, model: config.model ?? '' },
            engineeringRoleRevision: { available: true, version: 1 },
            agentSettings: { available: true, version: 1 },
            engineeringRouteContractRevision: { available: true, version: 1 },
            planningIssueConversation: { available: true, version: 3 },
            automaticDelivery: { available: automaticDelivery.available, ...automaticDelivery.readiness(), ...AUTOMATIC_BUDGET,
              developmentTimeoutMs: plannedExecutionService?.timeoutMs },
            modelPlanning: { engineeringMaxCalls: orchestrator.engineeringMaxCalls, engineeringCallLimit: orchestrator.engineeringMaxCalls !== null, engineeringTimeoutMs: orchestrator.engineeringTimeoutMs,
              engineeringTotalTimeoutMs: orchestrator.engineeringTotalTimeoutMs,
              specificationMaxCalls: orchestrator.specificationMaxCalls, specificationCallLimit: orchestrator.specificationMaxCalls !== null, specificationTimeoutMs: orchestrator.specificationTimeoutMs },
            supportedFormats: ['.md', '.txt', '.docx'] });
        }
        if (teamAccess) {
          requireLocalExecutionRequest(request, server); const actor = teamAccess.requireRole(request.headers.cookie, ['owner', 'reviewer', 'observer']);
          requestChecks.set(request, () => teamAccess.requireRole(request.headers.cookie, [actor.role]));
          if (!['GET', 'HEAD'].includes(method)) {
            const { requestId } = beginTeamAudit(request, response, actor, url.pathname.slice(0, 1000));
            let permitted = actor.role === 'owner', action = method;
            if (actor.role === 'reviewer' && method === 'POST') {
              if (segments.length === 6 && segments[1] === 'projects' && segments[3] === 'runs' && segments[5] === 'action') {
                const body = await readJson(request); action = typeof body.action === 'string' ? body.action : method;
                permitted = ['approve_spec', 'reject_spec', 'approve_plan', 'reject_plan'].includes(action);
              } else permitted = segments.length === 8 && segments[1] === 'projects' && segments[3] === 'runs' && ['verification-plans', 'evolutions'].includes(segments[5]) && ['approve', 'reject'].includes(segments[7]);
            }
            if (!permitted) teamAccess.audit({ requestId, actor, action: 'request.denied', target: url.pathname.slice(0, 1000), status: 403 });
            if (!permitted) throw new HttpError(403, '当前角色只可查看；评审者可确认或驳回规格、计划、测试定义及迁移描述，开发和需求变更由负责人执行。');
          }
        }
        if (segments[1] === 'agent-settings' && segments.length === 2) {
          requireLocalExecutionRequest(request, server);
          if (teamAccess) teamAccess.requireRole(request.headers.cookie, ['owner']);
          if (method === 'GET') return respond(response, 200, agentSettings.view());
          if (method === 'PUT') return respond(response, 200, await agentSettings.save(await readJson(request)));
          throw new HttpError(405, '该接口仅支持读取和保存配置。');
        }
        if (segments[1] !== 'projects') throw new HttpError(404, '未找到该接口。');
        if (segments.length === 2) {
          if (method === 'GET') return respond(response, 200, { projects: store.list() });
          if (method === 'POST') return respond(response, 201, { project: await store.create(parseDocument(await readJson(request))) });
          throw new HttpError(405, '该接口不支持此请求方法。');
        }
        const projectId = segments[2];
        if (!['GET', 'HEAD'].includes(method) && automaticDelivery.ownsProject(projectId)) {
          const savingInput = segments[3] === 'changes' && (segments.length === 4 || segments.length === 5 && segments[4] === 'parse');
          const stoppingExecution = segments[3] === 'runs' && segments[5] === 'development-executions' && segments.length === 8 && segments[7] === 'cancel';
          const planningAction = segments[3] === 'runs' && segments.length === 6 && segments[5] === 'action' && method === 'POST';
          if (!savingInput && !stoppingExecution && !planningAction) throw new HttpError(409, '当前项目正在自动交付，操作将在本次运行结束后开放。');
        }
        if (segments[3] === 'local-releases') {
          requireLocalExecutionRequest(request, server); store.get(projectId);
          if (!localReleasesService) throw new HttpError(404, '当前服务尚未开放本机业务版本。');
          const assertAccess = () => { requireLocalExecutionRequest(request, server); requestChecks.get(request)?.(); if (teamAccess) teamAccess.requireRole(request.headers.cookie, method === 'GET' ? ['owner', 'reviewer', 'observer'] : ['owner']); return true; };
          if (segments.length === 4 && method === 'GET') {
            const result = await localReleasesService.list({ projectId }, { assertAccess }); assertAccess(); const owner = !teamAccess || teamAccess.identity(request.headers.cookie)?.role === 'owner';
            return respond(response, 200, { ...result, capabilities: { canActivate: owner }, releases: result.releases.map(row => ({ ...row, actions: Object.fromEntries(Object.entries(row.actions ?? {}).map(([key, value]) => [key, owner && value === true])) })) });
          }
          if (segments.length === 5 && segments[4] === 'activate' && method === 'POST') {
            const body = dataFields(await readJson(request), ['runId', 'executionId', 'expectedReleaseId', 'expectedDataGeneration']); assertAccess(); store.getRun(projectId, body.runId);
            return respond(response, 200, await localReleasesService.activate({ projectId, ...body }, { assertAccess }));
          }
          if (segments.length === 6 && ['start', 'stop', 'rollback'].includes(segments[5]) && method === 'POST') {
            const action = segments[5], body = dataFields(await readJson(request), action === 'stop' ? [] : action === 'start' ? ['expectedDataGeneration'] : ['expectedDataGeneration', 'reason']); assertAccess();
            return respond(response, 200, await localReleasesService[action]({ projectId, releaseId: segments[4], ...body }, { assertAccess }));
          }
          throw new HttpError(404, '未找到该本机业务版本操作。');
        }
        if (segments.length === 3 && method === 'DELETE') {
          requireLocalExecutionRequest(request, server);
          const body = exactFields(await readJson(request), ['confirmationName']);
          const result = await orchestrator.withProjectCheckpoint(projectId, async () => {
            if (store.get(projectId).runs.some(run => run.status === 'running')) throw new HttpError(409, '项目仍在运行，请等待阶段结束后再删除。');
            const remove = () => {
              const publish = () => {
                if (typeof plannedExecutionService?.withProjectCheckpoint !== 'function') throw new HttpError(409, '无法核对研发执行状态，暂不能删除项目。');
                return plannedExecutionService.withProjectCheckpoint(projectId, () => store.remove(projectId, body.confirmationName));
              };
              if (verificationPlanningService === null) return publish();
              if (typeof verificationPlanningService?.withProjectCheckpoint !== 'function') throw new HttpError(409, '无法确认测试提案状态，暂不能删除项目。');
              return verificationPlanningService.withProjectCheckpoint(projectId, publish);
            };
            if (executionService === null) return remove();
            if (typeof executionService?.withProjectCheckpoint !== 'function') throw new HttpError(409, '无法确认代码执行和预览状态，暂不能删除项目。');
            return executionService.withProjectCheckpoint(projectId, remove);
          });
          return respond(response, 200, result);
        }
        if (segments.length === 3 && method === 'GET') return respond(response, 200, { project: { ...store.get(projectId), runs: await Promise.all(store.get(projectId).runs.map(run => orchestrator.describeRun(store.get(projectId), run))) } });
        if (segments[3] === 'changes') {
          requireLocalExecutionRequest(request, server); store.get(projectId);
          if (!sourceChangeService) throw new HttpError(404, '当前服务尚未开放需求输入变更。');
          if (segments.length === 4 && method === 'GET') {
            const changes = await sourceChangeService.list({ projectId });
            const current = store.getSourceVersion(projectId), project = store.getPersistedProject(projectId);
            return respond(response, 200, { current, versions: project.sourceVersions ?? [{ ...current, at: project.createdAt, changeId: null }],
              changes, capabilities: { canApply: typeof executionService?.withProjectCheckpoint === 'function' && typeof verificationPlanningService?.withProjectCheckpoint === 'function' && typeof plannedExecutionService?.withProjectCheckpoint === 'function',
                ...(typeof executionService?.withProjectCheckpoint === 'function' && typeof verificationPlanningService?.withProjectCheckpoint === 'function' && typeof plannedExecutionService?.withProjectCheckpoint === 'function' ? {} : { reason: '执行或测试提案服务无法确认安全检查点，暂时只允许保存待应用变更。' }) } });
          }
          if (segments.length === 4 && method === 'POST') {
            const body = dataFields(await readJson(request), ['baseRevision', 'source', 'reason', 'kind', 'requestKey']);
            return respond(response, 201, { change: await sourceChangeService.request({ ...body, projectId }) });
          }
          if (segments.length === 5 && segments[4] === 'parse' && method === 'POST') {
            const input = await readJson(request), body = dataFields(input, Object.hasOwn(input, 'fileBase64') ? ['filename', 'fileBase64'] : ['filename', 'content']);
            return respond(response, 200, { source: parseDocument(body).source });
          }
          if (segments.length === 6 && segments[5] === 'apply' && method === 'POST') {
            const body = dataFields(await readJson(request), ['baseRevision', 'generation']);
            return respond(response, 200, { change: await sourceChangeService.apply({ ...body, projectId, changeId: segments[4] }) });
          }
          throw new HttpError(['GET', 'POST'].includes(method) ? 404 : 405, '未找到该变更接口或请求方法不受支持。');
        }
        if (segments[3] !== 'runs') throw new HttpError(404, '未找到该接口。');
        if (segments.length === 4 && method === 'POST') {
          const input = await readJson(request);
          if (!Object.hasOwn(input, 'automaticDelivery')) return respond(response, 201, { run: await orchestrator.createRun(projectId, input) });
          requireLocalExecutionRequest(request, server);
          const subject = teamAccess ? teamAccess.executionSubject(request.headers.cookie) : createLocalExecutionSubject();
          return respond(response, 201, { run: await automaticDelivery.start(projectId, input, subject) });
        }
        const runId = segments[4];
        const { project, run } = store.getRun(projectId, runId);
        if (segments.length === 5 && method === 'GET') return respond(response, 200, { run: await orchestrator.describeRun(project, run) });
        if (segments.length === 6 && segments[5] === 'automatic-delivery' && method === 'GET') {
          requireLocalExecutionRequest(request, server);
          return respond(response, 200, await automaticDelivery.status(project, run));
        }
        if (segments.length === 7 && segments[5] === 'automatic-delivery' && segments[6] === 'retry-verification' && method === 'POST') {
          requireLocalExecutionRequest(request, server);
          const input = dataFields(await readJson(request), ['modelUsageConfirmed', 'planRevision', 'updatedAt']);
          const subject = teamAccess ? teamAccess.executionSubject(request.headers.cookie) : createLocalExecutionSubject();
          return respond(response, 202, await automaticDelivery.retryVerification(projectId, runId, input, subject));
        }
        if (segments[5] === 'simulations') {
          requireLocalExecutionRequest(request, server);
          if (segments.length === 6 && method === 'GET') {
            let reason = '';
            try { simulationService.binding(projectId, runId); simulationService.assertIdle(projectId); }
            catch (error) { reason = error.message; }
            return respond(response, 200, { runs: simulationService.list(projectId, runId), canStart: !reason, reason });
          }
          if (segments.length === 6 && method === 'POST') return respond(response, 202, { simulation: await simulationService.start(projectId, runId, await readJson(request)) });
          if (segments.length === 8 && segments[7] === 'action' && method === 'POST') return respond(response, 200, {
            simulation: await simulationService.action(projectId, runId, segments[6], await readJson(request)),
          });
          if (segments.length === 8 && segments[7] === 'download' && method === 'GET') {
            const simulation = simulationService.list(projectId, runId).find(item => item.id === segments[6]);
            if (!simulation) throw new HttpError(404, '未找到模拟记录。');
            return respond(response, 200, { kind: 'simulation', realAcceptance: false, simulation }, 'application/json; charset=utf-8', {
              'Content-Disposition': 'attachment; filename="simulated-task-history.json"',
            });
          }
          throw new HttpError(404, '未找到该模拟编排接口。');
        }
        if (segments[5] === 'evolutions') {
          requireLocalExecutionRequest(request, server);
          if (!evolutionService) throw new HttpError(404, '当前服务尚未开放已有数据演进。');
          const assertAccess = () => { requireLocalExecutionRequest(request, server); requestChecks.get(request)?.(); if (teamAccess) teamAccess.requireRole(request.headers.cookie, method === 'GET' ? ['owner', 'reviewer', 'observer'] : ['approve', 'reject'].includes(segments[7]) ? ['owner', 'reviewer'] : ['owner']); return true; };
          const identity = { projectId, runId };
          if (segments.length === 6 && method === 'GET') {
            assertAccess(); const result = await evolutionService.list(identity); assertAccess(); const role = teamAccess?.identity(request.headers.cookie)?.role ?? 'owner';
            return respond(response, 200, { ...result, capabilities: { canPrepare: role === 'owner' }, evolutions: result.evolutions.map(row => ({ ...row,
              actions: Object.fromEntries(Object.entries(row.actions ?? {}).map(([key, value]) => [key, value === true && (key === 'canApprove' ? ['owner', 'reviewer'].includes(role) : role === 'owner')])) })) });
          }
          if (segments.length === 6 && method === 'POST') {
            const body = dataFields(await readJson(request), ['releaseId', 'proposalId', 'definitionRevision', 'expectedSourceRevision', 'expectedSourceGeneration', 'requestKey', 'reason']); assertAccess();
            return respond(response, 200, await evolutionService.prepare({ ...identity, ...body }, { assertAccess }));
          }
          if (segments.length === 8 && method === 'POST') {
            const action = segments[7], fields = { revise: ['revision', 'migration', 'reason'], approve: ['revision', 'feedback'], reject: ['revision', 'feedback'], start: ['revision', 'contractRevision'], activate: ['revision'] }[action];
            if (!fields || typeof evolutionService[action] !== 'function') throw new HttpError(404, '未找到该演进操作。');
            const body = dataFields(await readJson(request), fields); assertAccess();
            return respond(response, action === 'start' ? 202 : 200, await evolutionService[action]({ ...identity, evolutionId: segments[6], ...body }, { assertAccess,
              ...(action === 'start' ? { subject: teamAccess ? teamAccess.executionSubject(request.headers.cookie) : createLocalExecutionSubject() } : {}) }));
          }
          throw new HttpError(404, '未找到该演进接口。');
        }
        if (segments[5] === 'development-executions') {
          requireLocalExecutionRequest(request, server);
          if (!plannedExecutionService) throw new HttpError(404, '当前服务尚未开放按规划研发。');
          const identity = { projectId, runId };
          if (segments.length === 6 && method === 'GET') return respond(response, 200, await plannedExecutionService.list(identity));
          if (segments.length === 7 && segments[6] === 'start' && method === 'POST') {
            const body = exactFields(await readJson(request), ['proposalId', 'revision', 'contractRevision']);
            return respond(response, 202, await plannedExecutionService.start({ ...identity, ...body }, { subject: teamAccess ? teamAccess.executionSubject(request.headers.cookie) : createLocalExecutionSubject() }));
          }
          if (segments.length === 8 && segments[7] === 'cancel' && method === 'POST') {
            dataFields(await readJson(request), []);
            return respond(response, 200, await plannedExecutionService.cancel({ ...identity, executionId: segments[6] }, { assertAccess: () => { requestChecks.get(request)?.(); return true; } }));
          }
          if (segments.length === 8 && ['pause', 'resume', 'recover'].includes(segments[7]) && method === 'POST') {
            dataFields(await readJson(request), []);
            if (typeof plannedExecutionService[segments[7]] !== 'function') throw new HttpError(409, '当前执行器不支持任务图暂停或继续。');
            return respond(response, segments[7] === 'recover' ? 202 : 200, await plannedExecutionService[segments[7]]({ ...identity, executionId: segments[6] }));
          }
          if (segments.length === 8 && ['preview', 'stop-preview'].includes(segments[7]) && method === 'POST') {
            dataFields(await readJson(request), []);
            const action = segments[7] === 'preview' ? 'preview' : 'stopPreview';
            if (typeof plannedExecutionService[action] !== 'function') throw new HttpError(409, '当前执行器尚不支持运行预览。');
            const assertAccess = () => { requestChecks.get(request)?.(); return true; };
            assertAccess();
            return respond(response, 200, await plannedExecutionService[action]({ ...identity, executionId: segments[6] }, { assertAccess }));
          }
          if (segments.length === 8 && segments[7] === 'revise-checklist' && method === 'POST') {
            dataFields(await readJson(request), []);
            const { executions } = await plannedExecutionService.list(identity);
            const failure = executions.findLast(item => item.current);
            if (!failure || failure.id !== segments[6] || failure.active || failure.status !== 'failed' || failure.failureHelp?.action !== 'review_checklist'
              || failure.binding?.planRevision !== run.planRevision || run.status !== 'succeeded') {
              throw new HttpError(409, '当前执行已经变化，或没有需要修订的登录检查。请刷新进度。');
            }
            const tasks = structuredClone(run.tasks);
            const pageTask = loginRevisionTask(tasks);
            if (!pageTask) throw new HttpError(409, '当前计划没有可保存验收调整的开发任务。');
            const setup = loginRevisionNote((run.planVersion ?? 1) + 1, failure.failureHelp.detail);
            if (pageTask.description.length + setup.length + 2 > 5000) throw new HttpError(409, '这项开发任务的说明已达上限。请在开发任务中整理说明后重试。');
            pageTask.description += `\n\n${setup}`;
            const updated = await atPlanRevisionCheckpoint(projectId, () => orchestrator.action(projectId, runId, {
              action: 'revise_plan', revision: run.planRevision, tasks, feedback: setup,
            }, { assertAccess: () => { requestChecks.get(request)?.(); } }));
            return respond(response, 200, { run: updated });
          }
          if (segments.length === 8 && segments[7] === 'repair' && method === 'POST') {
            const input = await readJson(request);
            const body = exactFields(input, Object.hasOwn(input, 'repairNote') ? ['contractRevision', 'repairNote'] : ['contractRevision']);
            return respond(response, 202, await plannedExecutionService.repair({ ...identity, executionId: segments[6], ...body }, { subject: teamAccess ? teamAccess.executionSubject(request.headers.cookie) : createLocalExecutionSubject() }));
          }
          if (segments.length === 8 && segments[7] === 'download' && method === 'GET') {
            const file = await plannedExecutionService.download({ ...identity, executionId: segments[6] });
            return respond(response, 200, file.buffer, file.contentType, { 'Content-Disposition': `attachment; filename="${file.filename}"` });
          }
          throw new HttpError(['GET', 'POST'].includes(method) ? 404 : 405, '未找到该研发执行接口或方法不支持。');
        }
        if (segments[5] === 'verification-plans') {
          requireLocalExecutionRequest(request, server);
          if (!verificationPlanningService) throw new HttpError(404, '当前服务尚未开放独立测试提案。');
          const identity = { projectId, runId };
          const currentDefinition = result => result.proposals?.findLast(item => item.current && ['draft', 'approved', 'rejected'].includes(item.status));
          if (segments.length === 6 && method === 'GET') {
            const result = await verificationPlanningService.list(identity);
            if (!result.capabilities) return respond(response, 200, result);
            const canRecoverLogin = Boolean(plannedExecutionService && result.capabilities.canImportDefinition && !currentDefinition(result)
              && (!teamAccess || teamAccess.identity(request.headers.cookie)?.role === 'owner') && previousLoginPlan(run));
            const continuation = !run.automaticDelivery && (!teamAccess || teamAccess.identity(request.headers.cookie)?.role === 'owner')
              ? await verificationContinuation(verificationPlanningService, identity, result) : null;
            requestChecks.get(request)?.();
            return respond(response, 200, { ...result, capabilities: { ...result.capabilities, canRecoverLogin, ...(continuation ? { continuation: continuation.capability } : {}) } });
          }
          if (segments.length === 7 && segments[6] === 'recover-login' && method === 'POST') {
            const { contractRevision, planRevision } = exactFields(await readJson(request), ['contractRevision', 'planRevision']);
            const fallback = { proposal: null, reason: '未能从旧清单确认所需的登录步骤。请检查或导入当前计划的验收清单。' };
            const recovery = await orchestrator.withProjectCheckpoint(projectId, async () => {
              const { run: current } = store.getRun(projectId, runId);
              const result = await verificationPlanningService.list(identity);
              requestChecks.get(request)?.();
              if (current.planRevision !== planRevision || result.capabilities?.contractRevision !== contractRevision) {
                throw new HttpError(409, '计划或验收规则已变化，请刷新工作区。');
              }
              const previous = previousLoginPlan(current);
              if (!plannedExecutionService || !previous) return { status: 200, body: fallback };
              const existing = currentDefinition(result);
              if (existing) return { status: 200, body: { proposal: existing } };
              if (!result.capabilities.canImportDefinition) throw new HttpError(409, result.capabilities.manualReason);
              const { executions } = await plannedExecutionService.list(identity);
              const draft = loginContinuationDraft({ run: current, previous, proposals: result.proposals, executions });
              if (!draft) return { status: 200, body: fallback };
              requestChecks.get(request)?.();
              try {
                const imported = await verificationPlanningService.importDefinition({ ...identity, contractRevision, ...draft });
                return { status: 201, body: imported };
              } catch (error) {
                if (error.code === 'invalid_proposal') return { status: 200, body: fallback };
                throw error;
              }
            });
            return respond(response, recovery.status, recovery.body);
          }
          if (segments.length === 7 && segments[6] === 'propose' && method === 'POST') {
            const body = exactFields(await readJson(request), ['contractRevision']);
            if (!run.automaticDelivery) {
              const base = await verificationPlanningService.list(identity);
              const continuation = body.contractRevision !== base.capabilities?.contractRevision
                ? await verificationContinuation(verificationPlanningService, identity, base) : null;
              requestChecks.get(request)?.();
              if (continuation?.capability.contractRevision === body.contractRevision) {
                return respond(response, 202, await verificationPlanningService.propose({ ...identity, contractRevision: continuation.serviceContractRevision }, continuation.options));
              }
            }
            return respond(response, 202, await verificationPlanningService.propose({ ...identity, ...body }));
          }
          if (segments.length === 7 && segments[6] === 'import' && method === 'POST') {
            const body = dataFields(await readJson(request), ['contractRevision', 'proposal', 'feedback']);
            const imported = await orchestrator.withProjectCheckpoint(projectId, () => {
              requestChecks.get(request)?.();
              return verificationPlanningService.importDefinition({ ...identity, ...body });
            });
            return respond(response, 201, imported);
          }
          if (segments.length === 8 && segments[7] === 'repair-draft') {
            const source = { ...identity, proposalId: segments[6] }, checkAccess = () => requestChecks.get(request)?.();
            if (method === 'GET') {
              const editable = url.searchParams.get('edit') === '1';
              if (editable && teamAccess) teamAccess.requireRole(request.headers.cookie, ['owner']);
              const result = await verificationRecovery.read(source, { editable });
              checkAccess();
              return respond(response, 200, result);
            }
            if (method === 'POST') {
              const input = await readJson(request);
              const body = dataFields(input, Object.hasOwn(input, 'proposal') ? ['contractRevision', 'proposal', 'feedback'] : ['contractRevision']);
              const result = await orchestrator.withProjectCheckpoint(projectId, () => verificationRecovery.save(source, body,
                { checkAccess, importDefinition: value => verificationPlanningService.importDefinition(value), list: value => verificationPlanningService.list(value) }));
              return respond(response, 201, result);
            }
          }
          if (segments.length === 8 && ['revise', 'approve', 'reject', 'cancel'].includes(segments[7]) && method === 'POST') {
            const action = segments[7], allowed = action === 'cancel' ? [] : action === 'revise' ? ['revision', 'proposal', 'feedback'] : ['revision', 'feedback'];
            const body = dataFields(await readJson(request), allowed);
            if (action === 'approve') {
              const { proposals } = await verificationPlanningService.list(identity);
              const draft = proposals.find(row => row.id === segments[6] && row.revision === body.revision && row.current && row.status === 'draft');
              if (repeatedCounterSteps(draft?.proposal).length) {
                const { diagnostic } = await verificationRecovery.read({ ...identity, proposalId: draft.id });
                if (diagnostic.suggestedRepair) throw new HttpError(409, '清单中列表条目和总数用了同一个检查位置。请先修复清单，再确认。');
              }
              requestChecks.get(request)?.();
            }
            return respond(response, 200, await verificationPlanningService[action]({ ...identity, proposalId: segments[6], ...body }));
          }
          throw new HttpError(['GET', 'POST'].includes(method) ? 404 : 405, '未找到该测试提案接口或请求方法不受支持。');
        }
        if (segments[5] === 'executions') {
          requireLocalExecutionRequest(request, server);
          if (!executionService) throw new HttpError(404, '当前服务尚未开放网页代码执行。');
          const identity = { projectId, runId };
          if (segments.length === 6) {
            if (method !== 'GET') throw new HttpError(405, '执行记录仅支持读取。');
            return respond(response, 200, await executionService.list(identity));
          }
          if (segments.length === 7 && segments[6] === 'start') {
            if (method !== 'POST') throw new HttpError(405, '启动执行请使用POST请求。');
            const body = exactFields(await readJson(request), ['profileId', 'contractRevision']);
            return respond(response, 202, await fixedAdmission(projectId, () => executionService.start({ ...identity, ...body })));
          }
          if (segments.length === 8 && segments[7] === 'action') {
            if (method !== 'POST') throw new HttpError(405, '执行动作请使用POST请求。');
            const input = await readJson(request);
            const body = exactFields(input, ['retry', 'recheck', 'repair'].includes(input?.action) ? ['action', 'profileId', 'contractRevision'] : ['action']);
            if (!['cancel', 'retry', 'recheck', 'repair', 'preview', 'stop_preview'].includes(body.action)) throw new HttpError(400, '执行动作无效，请刷新后使用页面提供的操作。');
            const action = () => executionService.action({ ...identity, executionId: segments[6], ...body });
            return respond(response, 200, await (['retry', 'recheck', 'repair', 'preview'].includes(body.action) ? fixedAdmission(projectId, action) : action()));
          }
          if (segments.length === 8 && segments[7] === 'download') {
            if (method !== 'GET') throw new HttpError(405, '源码下载仅支持读取。');
            const file = await executionService.download({ ...identity, executionId: segments[6] });
            return respond(response, 200, file.buffer, file.contentType, {
              'Content-Disposition': `attachment; filename="verified-source.zip"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
            });
          }
          throw new HttpError(404, '未找到该执行接口。');
        }
        if (segments.length === 6 && segments[5] === 'action' && method === 'POST') {
          const input = await readJson(request);
          if (automaticDelivery.ownsProject(projectId)) {
            const clarification = automaticDelivery.ownsRun(projectId, runId) && run.automaticDelivery?.status === 'needs_clarification';
            if (!clarification || !['answer_planning_issue', 'clarify_spec', 'revise_spec', 'supplement_spec'].includes(input.action)) {
              throw new HttpError(409, '当前项目由自动流程推进。有待澄清的业务问题时，可提交答复。');
            }
            automaticDelivery.assertDispatch(run);
          }
          const apply = () => orchestrator.action(projectId, runId, input, { assertAccess: () => { requestChecks.get(request)?.(); } });
          let updated;
          if (input.action === 'revise_plan' && run.status === 'succeeded') {
            updated = await atPlanRevisionCheckpoint(projectId, apply);
          } else updated = await apply();
          const issueAction = input.action === 'explain_planning_issue' || input.action === 'answer_planning_issue';
          return respond(response, 200, { run: issueAction ? await orchestrator.describeRun(project, updated) : updated });
        }
        if (segments.length === 7 && segments[5] === 'artifacts' && method === 'GET') {
          const artifact = run.artifacts.find(item => item.name === segments[6]);
          if (!artifact) throw new HttpError(404, '产物尚未生成或不存在。');
          const headers = url.searchParams.get('download') === '1' ? { 'Content-Disposition': `attachment; filename="${artifact.name}"` } : {};
          return respond(response, 200, artifact.content, artifact.name.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8', headers);
        }
        if (segments.length === 6 && segments[5] === 'download' && method === 'GET') {
          if (run.status !== 'succeeded') throw new HttpError(409, '请先完成审阅并确认导出。');
          const files = [{ name: 'requirements.md', content: (run.sourceSnapshot ?? project.source).content }, ...run.artifacts.map(({ name, content }) => ({ name, content }))];
          return respond(response, 200, createZip(files), 'application/zip', { 'Content-Disposition': `attachment; filename="project-documents.zip"; filename*=UTF-8''${encodeURIComponent(project.name)}.zip` });
        }
        throw new HttpError(404, '未找到该接口。');
      }
      if (!['GET', 'HEAD'].includes(method)) throw new HttpError(405, '静态文件仅支持读取。');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, '网址编码无效。'); }
      if (pathname.includes('\0')) throw new HttpError(400, '文件路径无效。');
      const file = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
      const relative = path.relative(publicDir, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new HttpError(403, '不可访问此文件。');
      let info;
      try { info = await stat(file); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new HttpError(404, '未找到该页面。'); throw error; }
      if (!info.isFile()) throw new HttpError(404, '未找到该页面。');
      const body = await readFile(file);
      if (method === 'HEAD') { response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': body.length }); return response.end(); }
      respond(response, 200, body, MIME[path.extname(file)] ?? 'application/octet-stream');
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) console.error('[server]', error.message);
      respond(response, status, { error: status >= 500 ? '服务处理失败，请查看服务端终端后重试。' : error.message });
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  const close = () => {
    if (!closing) closing = (async () => {
      await automaticDelivery.shutdown();
      const lifecycle = await Promise.allSettled([evolutionService?.shutdown(), localReleasesService?.shutdown(), plannedDatasetService?.close()]);
      const results = [...lifecycle, ...await Promise.allSettled([simulationService.shutdown(), orchestrator.shutdown(), executionService?.shutdown(), sourceChangeService?.shutdown(), verificationPlanningService?.shutdown(), plannedExecutionService?.shutdown()])];
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      teamAccess?.close();
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    })();
    return closing;
  };
  return { server, store, orchestrator, simulationService, executionService, sourceChangeService, verificationPlanningService, plannedExecutionService, localReleasesService, plannedDatasetService, evolutionService, teamAccess, agentSettings, close };
}

export async function startServer(options = {}) {
  if (options.loadEnv !== false) await loadEnv();
  const app = await createApp(options);
  const port = options.port ?? Number(process.env.PORT || 4317);
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  try { await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, host, resolve); }); }
  catch (cause) { try { await app.close(); } catch { cause.executionCleanupFailed = true; } throw cause; }
  const address = app.server.address();
  return { ...app, url: `http://${host}:${address.port}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer().then(app => {
    console.log(`\n  需求编排工作台  ${app.url}\n  本地数据保存在 data/；按 Ctrl+C 停止。\n`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch(error => { console.error(`启动失败：${error.code === 'EADDRINUSE' ? '端口已被占用，请调整 .env 中的 PORT。' : error.message}`); process.exitCode = 1; });
}
