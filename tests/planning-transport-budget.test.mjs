import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,rm} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {ProjectStore} from '../lib/store.mjs';
import {Orchestrator} from '../lib/orchestrator.mjs';
import * as planner from '../lib/planner.mjs';
import {createEngineeringModel} from '../lib/engineering-model.mjs';
import {getModelRequestEvidence} from '../lib/model-request-evidence.mjs';
import {contentRevision} from '../lib/planning-review.mjs';
import {createApp} from '../server.mjs';

const source='用户读取事项。',config={baseUrl:'https://fixture.invalid/v1',model:'planning-transport-fixture',apiKey:'synthetic-planning-key'};
const spec=()=>({title:'事项',summary:source,goals:[],roles:[],constraints:[],assumptions:[],questions:[],acceptanceScenarios:[],stack:{frontend:'HTML',backend:'Node.js',storage:'SQLite'},requirements:[{id:'R-001',title:'读取事项',description:source,sourceQuote:source,acceptance:['显示事项']} ]});
const proposal=()=>({version:1,title:'事项工程',summary:source,entities:[],routes:[{id:'list',method:'GET',path:'/items',roles:[],request:'无',response:'事项',errors:[],requirementIds:['R-001']}],views:[{id:'home',path:'/',title:'事项',requirementIds:['R-001'],selectors:[{testId:'items',role:'list'}]}],tasks:[{id:'whole',title:'事项应用',description:source,dependsOn:[],requirementIds:['R-001'],writePaths:['src/app.mjs'],inputs:['确认规格'],outputs:['事项应用'],acceptance:['显示事项']}]});
const reply=(content,finish='stop')=>new Response(JSON.stringify({choices:[{finish_reason:finish,message:{content:JSON.stringify(content)}}],usage:{prompt_tokens:1,completion_tokens:2}}));
async function until(read,label='planning condition'){const end=Date.now()+5000;for(;;){if(await read())return;assert.ok(Date.now()<end,label);await sleep(5)}}
const idle=(orchestrator,run)=>!orchestrator.state(run).active.size&&!orchestrator.state(run).driving;
async function fixture(t,{engineFetch=async()=>reply(proposal()),specFetch=async()=>reply(spec()),options={}}={}){const directory=await mkdtemp(path.join(os.tmpdir(),'planning-budget-')),store=await new ProjectStore(directory).init();let engineCalls=0,specCalls=0;
 const trusted={...planner,getModelConfig:()=>({configured:true,model:config.model}),analyzeWithModel:(text,name,input)=>planner.analyzeWithModel(text,name,{...input,config,fetchImpl:async(...args)=>{specCalls++;return specFetch(...args)}}),createEngineeringModel:()=>createEngineeringModel({config,fetchImpl:async(...args)=>{engineCalls++;return engineFetch(...args)}})};
 const orchestrator=new Orchestrator(store,trusted,{stepDelayMs:0,...options}),instances=[orchestrator],project=await store.create({name:'预算公开夹具',source:{filename:'r.md',content:source}});t.after(async()=>{await Promise.all(instances.map(instance=>instance.shutdown()));await rm(directory,{recursive:true,force:true})});const run=await orchestrator.createRun(project.id,{mode:'model'});await until(()=>run.status==='awaiting_spec'||run.status==='failed');
 return{directory,store,trusted,orchestrator,project,run,instances,engineCalls:()=>engineCalls,specCalls:()=>specCalls,approve:()=>orchestrator.action(project.id,run.id,{action:'approve_spec',revision:run.specRevision})};}

test('planning calls are unlimited by default and explicit finite configurations are validated', () => {
  for (const engineeringMaxCalls of [0, 21, 1.5]) assert.throws(() => new Orchestrator({}, planner, { engineeringMaxCalls }));
  for (const value of [1, 20, null]) assert.equal(new Orchestrator({}, planner, { engineeringMaxCalls: value }).engineeringMaxCalls, value);
  const ordinary = new Orchestrator({}, planner);
  assert.equal(ordinary.engineeringMaxCalls, null);
  assert.equal(ordinary.specificationMaxCalls, null);
});

test('a provider failure does not automatically request clarification questions', async t => {
  const x = await fixture(t, { specFetch: async () => new Response('unavailable', { status: 503 }) });
  await until(() => idle(x.orchestrator, x.run));
  const { planningIssue: issue } = await x.orchestrator.describeRun(x.project, x.run);
  assert.deepEqual(issue.qa, []);
  assert.equal(issue.autoExplain, false);
  await x.orchestrator.action(x.project.id, x.run.id, { action: 'explain_planning_issue', issueId: issue.id, automatic: true });
  assert.equal(x.specCalls(), 1);
  assert.equal(x.run.planningIssueHistory?.length ?? 0, 0);
});

test('six changing native validation failures exhaust a configured finite budget',async t=>{let calls=0;const x=await fixture(t,{options:{engineeringMaxCalls:6},engineFetch:async()=>{const invalid=proposal();invalid.routes[0].id='bad'+(++calls);invalid.routes[0].path='invalid';return reply(invalid)}});await x.approve();await until(()=>x.run.status==='failed'&&idle(x.orchestrator,x.run));assert.equal(calls,6);assert.equal(x.run.engineeringCalls,6);assert.equal(x.run.engineeringHistory.length,6);assert.ok(x.run.engineeringHistory.every(attempt=>attempt.transport.responseComplete&&attempt.transport.dispatched));assert.deepEqual(x.run.engineeringBudget,{maxCalls:6,timeoutMs:60000,totalTimeoutMs:600000});await assert.rejects(x.orchestrator.action(x.project.id,x.run.id,{action:'retry',stageId:'architecture'}),{status:409});const dto=await x.orchestrator.describeRun(x.project,x.run);assert.equal(dto.engineeringFailure.remaining,0);assert.equal(dto.engineeringFailure.canRetry,false);assert.equal(calls,6);await x.orchestrator.action(x.project.id,x.run.id,{action:'use_local_engineering'});await until(()=>x.run.status==='awaiting_review');assert.equal(calls,6)});

test('unlimited planning resumes a formerly exhausted run without losing history and passes the old engineering cap', async t => {
  let specifications = 0, engineering = 0;
  const x = await fixture(t, { options: { specificationMaxCalls: 1 }, specFetch: async () => reply(++specifications < 5 ? { invalid: true } : spec()), engineFetch: async () => {
    const draft = proposal();
    if (++engineering <= 6) {
      draft.routes[0].id = 'bad' + engineering;
      draft.routes[0].path = 'invalid';
    }
    return reply(draft);
  } });
  await until(() => x.run.status === 'failed' && idle(x.orchestrator, x.run));
  const previous = structuredClone(x.run.specificationHistory[0]);
  await assert.rejects(x.orchestrator.action(x.project.id, x.run.id, { action: 'retry', stageId: 'spec' }), { status: 409 });
  await x.orchestrator.shutdown();
  const store = await new ProjectStore(x.directory).init();
  const next = new Orchestrator(store, x.trusted, { stepDelayMs: 0 });
  x.instances.push(next);
  await next.init();
  const run = store.get(x.project.id).runs[0];
  for (let count = 2; count <= 5; count++) {
    await next.action(x.project.id, run.id, { action: 'retry', stageId: 'spec' });
    await until(() => run.specificationCalls === count && ['failed', 'awaiting_spec'].includes(run.status) && idle(next, run));
  }
  assert.equal(run.status, 'awaiting_spec');
  assert.equal(run.specificationBudget.maxCalls, null);
  assert.deepEqual(run.specificationHistory[0], previous);
  await next.action(x.project.id, run.id, { action: 'approve_spec', revision: run.specRevision });
  await until(() => run.status === 'awaiting_review' && idle(next, run));
  assert.equal(run.engineeringHistory.length, 7);
  assert.equal(run.engineeringBudget.maxCalls, null);
});

test('a rejected spec edit gives the model the exact form issue and preserves the current spec and raw answer', async t => {
  const question = '首版要解决什么问题？';
  const input = '首版让成员查看项目事项和当前状态。';
  const seen = [];
  const x = await fixture(t, { specFetch: async (_url, request) => {
    const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
    seen.push(payload);
    return reply(payload.issue ? { explanation: '需求摘要是空的，需要一句话说明首版功能。', questions: [question] } : spec());
  } });
  await until(() => idle(x.orchestrator, x.run));
  const before = structuredClone(x.run);
  const action = input => x.orchestrator.action(x.project.id, x.run.id, input);
  await assert.rejects(action({ action: 'revise_spec', revision: x.run.specRevision, spec: { ...x.run.spec, summary: '' } }), { status: 400 });
  assert.deepEqual(x.run, before);
  const { planningIssue: issue } = await x.orchestrator.describeRun(x.project, x.run);
  assert.ok(issue.fromInput);
  assert.equal(issue.autoExplain, true);
  assert.match(issue.message, /需求摘要为空/);
  await assert.rejects(action({ action: 'explain_planning_issue', issueId: 'previous' }), { status: 409 });
  assert.equal(seen.length, 1);
  await action({ action: 'explain_planning_issue', issueId: issue.id, automatic: true });
  await action({ action: 'explain_planning_issue', issueId: issue.id, automatic: true });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].issue.message, issue.message);
  const explained = (await x.orchestrator.describeRun(x.project, x.run)).planningIssue;
  assert.deepEqual(explained.explanation.questions, [question]);
  assert.deepEqual(explained.qa, [{ id: 'Q-001', question }]);
  assert.equal(explained.autoExplain, false);
  await assert.rejects(action({ action: 'answer_planning_issue', issueId: issue.id, answers: { 'Q-002': input }, continue: true }), { status: 409 });
  await assert.rejects(action({ action: 'answer_planning_issue', issueId: issue.id, answers: { 'Q-001': ' ' }, continue: true }), { status: 400 });
  await action({ action: 'answer_planning_issue', issueId: issue.id, answer: input, continue: false });
  assert.equal(seen.length, 2);
  assert.equal(x.run.specRevision, before.specRevision);
  await action({ action: 'answer_planning_issue', issueId: issue.id, answer: input, continue: true });
  await until(() => x.run.specificationCalls === 2 && x.run.status === 'awaiting_spec' && idle(x.orchestrator, x.run));
  assert.equal(seen.length, 3);
  assert.ok(seen[2].document.includes(input));
  assert.ok(!seen[2].document.includes(question), 'model questions are not copied into confirmed requirements');
  assert.deepEqual(seen[2].openQuestions, [question]);
  assert.equal(x.run.sourceRevision, before.sourceRevision);
  assert.deepEqual(x.run.approvals, { spec: null, plan: null });
  assert.equal(x.engineCalls(), 0);
});

test('frozen engineering cap/time/count survive retries and restarts; trusted configuration cannot enlarge them',async t=>{const x=await fixture(t,{options:{engineeringMaxCalls:2,engineeringTimeoutMs:2000,engineeringTotalTimeoutMs:20000},engineFetch:async()=>reply(proposal(),'length')});await x.approve();await until(()=>x.run.status==='failed'&&idle(x.orchestrator,x.run));const started=x.run.engineeringStartedAt;await x.orchestrator.action(x.project.id,x.run.id,{action:'retry',stageId:'architecture'});await until(()=>x.run.engineeringCalls===2&&x.run.status==='failed'&&idle(x.orchestrator,x.run));await x.orchestrator.shutdown();const store=await new ProjectStore(x.directory).init(),next=new Orchestrator(store,x.trusted,{stepDelayMs:0,engineeringMaxCalls:20,engineeringTimeoutMs:120000,engineeringTotalTimeoutMs:3600000});x.instances.push(next);await next.init();const run=store.get(x.project.id).runs[0];assert.deepEqual(run.engineeringBudget,{maxCalls:2,timeoutMs:2000,totalTimeoutMs:20000});assert.equal(run.engineeringStartedAt,started);await assert.rejects(next.action(x.project.id,run.id,{action:'retry',stageId:'architecture'}),{status:409});assert.equal(x.engineCalls(),2)});

test('in-run specification revision does not reset engineering deadline, count or frozen budget',async t=>{const x=await fixture(t);await x.approve();await until(()=>x.run.status==='awaiting_review'&&idle(x.orchestrator,x.run));const started=x.run.engineeringStartedAt,budget=structuredClone(x.run.engineeringBudget),revision=x.run.specRevision;const changed=structuredClone(x.run.spec);changed.summary+=' 继续保留原始需求。';await x.orchestrator.action(x.project.id,x.run.id,{action:'revise_spec',revision,spec:changed});assert.equal(x.run.engineeringStartedAt,started);assert.deepEqual(x.run.engineeringBudget,budget);assert.equal(x.run.engineeringCalls,1);await x.approve();await until(()=>x.run.status==='awaiting_review'&&idle(x.orchestrator,x.run));assert.equal(x.run.engineeringStartedAt,started);assert.equal(x.run.engineeringCalls,2)});

test('dispatch intent is persisted before native engineering invocation; preflight rejection proves sent zero',async t=>{const x=await fixture(t);let observed=false;const original=x.store.save.bind(x.store);x.store.save=async project=>{if(x.run.engineeringHistory?.at(-1)?.requestState==='dispatch_intent'){assert.equal(x.engineCalls(),0);observed=true}return original(project)};x.trusted.createEngineeringModel=()=>createEngineeringModel({config:{...config,model:''},fetchImpl:()=>assert.fail('invalid config must not send')});await x.approve();await until(()=>x.run.status==='failed'&&idle(x.orchestrator,x.run));assert.equal(observed,true);const attempt=x.run.engineeringHistory[0];assert.equal(attempt.transport.dispatched,false);assert.equal(attempt.coordinationRequired,false);assert.equal(x.run.engineeringCalls,1);assert.equal(x.engineCalls(),0);assert.equal(await x.orchestrator.withProjectCheckpoint(x.project.id,()=>true),true)});

test('native promises and receipt handles distinguish complete response, preflight and unknown; JSON cannot forge proof',async()=>{const normal=spec(),binding={projectId:'p',runId:'r',specRevision:contentRevision(normal)};let proof;const model=createEngineeringModel({config,fetchImpl:async()=>reply(proposal())}),request=model({spec:normal,binding,onReceipt:(_value,handle)=>{proof=handle;assert.deepEqual(getModelRequestEvidence(handle),{dispatched:true,responseComplete:true});throw new Error('controlled private writer failure')}});await assert.rejects(request,{code:'receipt_failed'});assert.deepEqual(getModelRequestEvidence(request),{dispatched:true,responseComplete:true});assert.deepEqual(getModelRequestEvidence(proof),{dispatched:true,responseComplete:true});assert.equal(getModelRequestEvidence(JSON.parse(JSON.stringify(proof))),null);const malformed=createEngineeringModel({config,fetchImpl:async()=>new Response('{')})({spec:normal,binding});await assert.rejects(malformed);assert.deepEqual(getModelRequestEvidence(malformed),{dispatched:true,responseComplete:true});const reset=createEngineeringModel({config,fetchImpl:async()=>{throw Object.assign(new Error('reset'),{dispatched:false,responseComplete:true})}})({spec:normal,binding});await assert.rejects(reset);assert.deepEqual(getModelRequestEvidence(reset),{dispatched:true,responseComplete:false})});

test('a lower configured cap is persisted on restart even without a new attempt; later higher caps cannot restore it',async t=>{const x=await fixture(t,{engineFetch:async()=>reply(proposal(),'length')});await x.approve();await until(()=>x.run.status==='failed'&&idle(x.orchestrator,x.run));await x.orchestrator.shutdown();let store=await new ProjectStore(x.directory).init(),lower=new Orchestrator(store,x.trusted,{stepDelayMs:0,engineeringMaxCalls:2,specificationMaxCalls:1});x.instances.push(lower);await lower.init();assert.equal(store.get(x.project.id).runs[0].engineeringBudget.maxCalls,2);await lower.shutdown();store=await new ProjectStore(x.directory).init();const higher=new Orchestrator(store,x.trusted,{stepDelayMs:0,engineeringMaxCalls:20,specificationMaxCalls:20});x.instances.push(higher);await higher.init();const run=store.get(x.project.id).runs[0];assert.equal(run.engineeringBudget.maxCalls,2);assert.equal(run.specificationBudget.maxCalls,1)});

test('real localhost specification partial-response reset is unknown and a superseded old run still fences the project after restart',async t=>{let calls=0;const model=http.createServer(async(req,res)=>{for await(const _ of req){}calls++;res.writeHead(200,{'content-type':'application/json'});res.write('{"choices":[');setTimeout(()=>res.destroy(),5)});await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));const x=await fixture(t,{specFetch:async(_url,options)=>fetch('http://127.0.0.1:'+model.address().port+'/v1/chat/completions',options)});t.after(()=>new Promise(resolve=>model.close(resolve)));await until(()=>x.run.status==='failed'&&idle(x.orchestrator,x.run));assert.equal(calls,1);const attempt=x.run.specificationHistory[0];assert.equal(attempt.transport.dispatched,true);assert.equal(attempt.transport.responseComplete,false);assert.equal(attempt.coordinationRequired,true);await x.orchestrator.shutdown();x.run.sourceSuperseded=true;await x.store.save(x.project);const store=await new ProjectStore(x.directory).init(),next=new Orchestrator(store,x.trusted,{stepDelayMs:0});x.instances.push(next);await next.init();await assert.rejects(next.createRun(x.project.id,{mode:'model'}),{status:409});await assert.rejects(next.withProjectCheckpoint(x.project.id,()=>assert.fail('old unknown request must fence')),{status:409});assert.equal(calls,1)});

test('real localhost engineering reset remains unknown across API restart; new run, retry, source apply and delete stay fenced',async t=>{let engineCalls=0;const model=http.createServer(async(req,res)=>{for await(const _ of req){}engineCalls++;req.socket.destroy()});await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));const directory=await mkdtemp(path.join(os.tmpdir(),'planning-http-budget-'));let app;const trusted={...planner,getModelConfig:()=>({configured:true,model:'local-reset-fixture'}),analyzeWithModel:(text,name,input)=>planner.analyzeWithModel(text,name,{...input,config,fetchImpl:async()=>reply(spec())}),createEngineeringModel:()=>createEngineeringModel({config:{...config,baseUrl:'http://127.0.0.1:'+model.address().port+'/v1'}})};
 const open=async()=>{app=await createApp({dataDir:directory,stepDelayMs:0,teamEnabled:false,planner:trusted,engineeringMaxCalls:3});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));return'http://127.0.0.1:'+app.server.address().port};let origin=await open();const api=async(route,body,method=body===undefined?'GET':'POST')=>{const response=await fetch(origin+route,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()}};
 t.after(async()=>{await app?.close();await new Promise(resolve=>model.close(resolve));await rm(directory,{recursive:true,force:true})});assert.equal((await api('/api/health')).body.modelPlanning.engineeringMaxCalls,3);assert.equal((await api('/api/health')).body.modelPlanning.engineeringCallLimit,true);const project=(await api('/api/projects',{name:'未知传输',filename:'r.md',content:source})).body.project,base='/api/projects/'+project.id,run=(await api(base+'/runs',{mode:'model'})).body.run,rpath=base+'/runs/'+run.id;await until(async()=>(await api(rpath)).body.run.status==='awaiting_spec');const current=(await api(rpath)).body.run;await api(rpath+'/action',{action:'approve_spec',revision:current.specRevision});await until(async()=>{const value=(await api(rpath)).body.run;return value.status==='failed'&&idle(app.orchestrator,app.store.getRun(project.id,run.id).run)});assert.equal(engineCalls,1);let state=app.store.getRun(project.id,run.id).run;assert.equal(state.engineeringHistory[0].coordinationRequired,true);assert.equal(state.engineeringHistory[0].transport.responseComplete,false);assert.deepEqual(state.engineeringHistory[0].usage,{inputTokens:null,outputTokens:null});
 const verify=async()=>{assert.equal((await api(base+'/runs',{mode:'model'})).status,409);assert.equal((await api(rpath+'/action',{action:'retry',stageId:'architecture'})).status,409);const input=(await api(base+'/changes')).body.current,changed=await api(base+'/changes',{baseRevision:input.revision,source:{filename:'r.md',content:source+' 新版。'},reason:'保存草稿仍允许',kind:'field',requestKey:'pending-'+engineCalls+'-'+Date.now()});assert.equal(changed.status,201);assert.equal((await api(base+'/changes/'+changed.body.change.id+'/apply',{baseRevision:input.revision,generation:input.generation})).status,409);assert.equal((await api(base,{confirmationName:'未知传输'},'DELETE')).status,409);assert.equal(engineCalls,1)};await verify();await app.close();origin=await open();await verify();state=app.store.getRun(project.id,run.id).run;assert.equal(state.engineeringHistory[0].coordinationRequired,true);assert.equal(state.engineeringCalls,1)});
