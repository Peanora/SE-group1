import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../server.mjs';import * as planner from '../lib/planner.mjs';
import {ProjectStore} from '../lib/store.mjs';
import {DEFAULT_STACK,applyPlatformDefaults} from '../lib/platform-defaults.mjs';
import {contentRevision} from '../lib/planning-review.mjs';
import {createEngineeringModel} from '../lib/engineering-model.mjs';
import {chromium} from 'playwright-core';
const source='用户可以查看消息。';
const raw=()=>({title:'消息工具',summary:source,goals:[],roles:[],constraints:[],assumptions:[],questions:['前端框架和数据库选型是什么？'],acceptanceScenarios:[],requirements:[{title:'查看消息',description:source,sourceQuote:source,acceptance:['展示消息列表']}],stack:{frontend:'待确认',backend:'待确认',storage:'待确认'}});
const proposal=()=>({version:1,title:'消息工程',summary:'消息页面和接口',entities:[],routes:[{id:'LIST',method:'GET',path:'/api/messages',roles:[],request:'无',response:'消息列表',errors:[],requirementIds:['R-001']}],views:[{id:'HOME',path:'/',title:'消息',requirementIds:['R-001'],selectors:[{testId:'messages',role:'list'}]}],tasks:[{id:'IMPLEMENT',title:'消息页面',description:'实现消息列表',requirementIds:['R-001'],dependsOn:[],writePaths:['src/app.mjs','public/app.js'],inputs:['确认规格'],outputs:['接口和页面'],acceptance:['展示消息列表']}]});
const reply=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
async function until(check){for(let n=0;!check();n++){if(n>1000)throw Error('等待状态超时');await delay(5);}}
async function fixture(t,options={}){
 const directory=await mkdtemp(path.join(os.tmpdir(),'taskflow-default-delete-'));let calls=0;
 const app=await createApp({dataDir:directory,stepDelayMs:0,...options,planner:{...planner,getModelConfig:()=>({configured:true,model:'mock'}),analyzeWithModel:(text,name,opts)=>planner.analyzeWithModel(text,name,{...opts,config:{baseUrl:'http://localhost',model:'mock',apiKey:''},fetchImpl:async()=>reply(raw())}),createEngineeringModel:()=>createEngineeringModel({config:{baseUrl:'http://localhost',model:'mock',apiKey:''},fetchImpl:async()=>{calls++;return reply(proposal());}})}});
 t.after(async()=>{await app.close();assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));await rm(directory,{recursive:true,force:true});});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${app.server.address().port}`;
 const request=(route,method='GET',body)=>fetch(url+route,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const create=async(name='消息工具')=>app.store.create({name,source:{filename:'requirements.md',content:source}});
 return {app,directory,url,request,create,calls:()=>calls};
}
async function waiting(x,p){const r=await x.app.orchestrator.createRun(p.id,{mode:'model'});await until(()=>r.status==='awaiting_spec'&&!x.app.orchestrator.state(r).driving&&!x.app.orchestrator.state(r).active.size);return r;}
async function legacy(x,p){const r=await waiting(x,p);delete r.spec.platformDefaults;r.spec.stack={frontend:'待确认',backend:'待确认',storage:'待确认'};r.specRevision=contentRevision(r.spec);r.approvals.spec={revision:r.specRevision};r.status='failed';for(const s of r.stages)if(['architecture','tasks'].includes(s.id)){s.status='failed';s.error='old invalid_input';}await x.app.store.save(p);return r;}
test('服务端统一默认方案，技术问题无需用户填写，客户端不能覆盖技术配置；完整双确认导出',async t=>{
 const x=await fixture(t),p=await x.create(),r=await waiting(x,p);
 assert.deepEqual(r.spec.stack,DEFAULT_STACK);assert.equal(r.specQuestions.length,0);assert.equal(r.spec.platformDefaults.version,'web-v1');
 const changed=structuredClone(r.spec);changed.stack={frontend:'React',backend:'Python',storage:'MongoDB'};changed.summary+=' 已修订';
 await x.app.orchestrator.action(p.id,r.id,{action:'revise_spec',revision:r.specRevision,spec:changed});assert.deepEqual(r.spec.stack,DEFAULT_STACK);
 await x.app.orchestrator.action(p.id,r.id,{action:'approve_spec',revision:r.specRevision});await until(()=>r.status==='awaiting_review');
 assert.equal(x.calls(),1);await x.app.orchestrator.action(p.id,r.id,{action:'approve_plan',revision:r.planRevision,specRevision:r.specRevision});await until(()=>r.status==='succeeded');
 assert.ok(r.artifacts.find(a=>a.name==='spec.md').content.includes('不生成原生桌面安装包'));assert.ok(r.artifacts.find(a=>a.name==='plan.json'));assert.equal(r.approvals.plan.specRevision,r.specRevision);
});
test('旧失败免费采用默认方案，保留原文/回答/失败/旧审批依据，新版本需重新确认；保存失败回滚',async t=>{
 const x=await fixture(t),p=await x.create(),r=await legacy(x,p),before=structuredClone(r);
 const save=x.app.store.save;x.app.store.save=async()=>{throw Error('controlled');};
 await assert.rejects(x.app.orchestrator.action(p.id,r.id,{action:'use_platform_defaults',revision:r.specRevision}),/保存失败/);x.app.store.save=save;assert.deepEqual(r,before);
 await x.app.orchestrator.action(p.id,r.id,{action:'use_platform_defaults',revision:r.specRevision});
 assert.equal(r.status,'awaiting_spec');assert.equal(r.approvals.spec,null);assert.deepEqual(r.sourceSnapshot,before.sourceSnapshot);assert.deepEqual(r.specQuestions,before.specQuestions);assert.deepEqual(r.spec.requirements,before.spec.requirements);assert.equal(x.calls(),0);
 assert.deepEqual(r.revisionHistory.spec.at(-1).approvals,before.approvals);assert.deepEqual(r.spec.stack,DEFAULT_STACK);
 await assert.rejects(x.app.orchestrator.action(p.id,r.id,{action:'approve_spec',revision:before.specRevision}),{status:409});
 await x.app.orchestrator.action(p.id,r.id,{action:'approve_spec',revision:r.specRevision});await until(()=>r.status==='awaiting_review');assert.equal(x.calls(),1);
});
test('删除确认、活动规划拦截、重启仍删除、旧保存不能复活；保留本机恢复记录',async t=>{
 const x=await fixture(t,{stepDelayMs:200}),p=await x.create('待删除'),held=p;
 assert.equal((await x.request(`/api/projects/${p.id}`,'DELETE',{confirmationName:'错名'})).status,409);
 const running=await x.app.orchestrator.createRun(p.id,{mode:'model'});await until(()=>x.app.orchestrator.state(running).active.size>0);
 assert.equal((await x.request(`/api/projects/${p.id}`,'DELETE',{confirmationName:p.name})).status,409);await until(()=>running.status==='awaiting_spec'&&!x.app.orchestrator.state(running).driving&&!x.app.orchestrator.state(running).active.size);
 const response=await x.request(`/api/projects/${p.id}`,'DELETE',{confirmationName:p.name});assert.equal(response.status,200);
 assert.equal((await x.request(`/api/projects/${p.id}`)).status,404);assert.equal(x.app.store.list().length,0);
 await assert.rejects(x.app.store.save(held),{status:409});const disk=JSON.parse(await readFile(path.join(x.directory,p.id+'.json'),'utf8'));assert.ok(disk.deletedAt);assert.deepEqual(disk.source,p.source);
 const restarted=await new ProjectStore(x.directory).init();assert.equal(restarted.list().length,0);assert.throws(()=>restarted.get(p.id),{status:404});await assert.rejects(restarted.save(held),{status:409});
});
for(const width of [1440,390])test(`Edge ${width}px默认方案恢复→计划导出→取消/删除项目/空工作台`,{timeout:60000},async t=>{
 const x=await fixture(t),p=await x.create('旧方案消息项目'),r=await legacy(x,p);await x.create('保留项目');
 const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(x.url + '/?view=details');await page.locator(`[data-project="${p.id}"]`).click();
 await page.getByRole('button',{name:'采用默认方案并重新确认',exact:true}).click();
 await page.getByRole('heading',{name:'先确认规格，再生成开发计划',exact:true}).waitFor();assert.equal(await page.locator('[data-review-field^="stack."]').count(),0);assert.match(await page.locator('#review-banner').innerText(),/无需填写/);
 await page.getByRole('button',{name:'确认规格并继续',exact:true}).click();await page.getByRole('button',{name:'确认计划并导出',exact:true}).waitFor();
 await page.getByRole('button',{name:'确认计划并导出',exact:true}).click();await until(()=>r.status==='succeeded');assert.equal(x.calls(),1);
 page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'删除项目：旧方案消息项目',exact:true}).click();assert.equal(x.app.store.list().length,2);
 if(width===390)await page.evaluate(()=>Object.defineProperty(window,'sessionStorage',{configurable:true,get(){throw new DOMException('blocked','SecurityError');}}));
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'删除项目：旧方案消息项目',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#project-count').textContent==='1');
 assert.equal(await page.locator('#project-title').textContent(),'保留项目');await page.reload();await page.getByRole('button',{name:'删除项目：保留项目',exact:true}).waitFor();
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'删除项目：保留项目',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#project-count').textContent==='0');
 assert.equal(await page.locator('#onboarding').isVisible(),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.equal(await page.locator('#error-banner').isHidden(),true);assert.deepEqual(errors,[]);
});

test('固定方案由控制器提供，模型缺少stack也能整理业务规格，旧适配器默认校验不放宽',async()=>{
 const missing=raw();delete missing.stack;
 const options={config:{baseUrl:'http://localhost',model:'mock',apiKey:''},fetchImpl:async()=>reply(missing)};
 await assert.rejects(planner.analyzeWithModel(source,'消息',options),/技术边界/);
 const spec=await planner.analyzeWithModel(source,'消息',{...options,usePlatformDefaults:true});assert.deepEqual(spec.stack,DEFAULT_STACK);
 assert.deepEqual(applyPlatformDefaults({...spec,questions:['前端采用什么技术？','数据库保存多久？','后端是否需要审计日志？','数据库是否需要加密？','数据库选型是否要求加密？']}).questions,['数据库保存多久？','后端是否需要审计日志？','数据库是否需要加密？','数据库选型是否要求加密？']);
});

test('确认前预检说明超长业务字段，不错误要求用户重新选择方案',async t=>{
 const x=await fixture(t),p=await x.create(),r=await waiting(x,p);const changed=structuredClone(r.spec);changed.title='长'.repeat(201);
 await x.app.orchestrator.action(p.id,r.id,{action:'revise_spec',revision:r.specRevision,spec:changed});
 await assert.rejects(x.app.orchestrator.action(p.id,r.id,{action:'approve_spec',revision:r.specRevision}),/标题最多200字/);
 assert.equal(x.calls(),0);assert.equal(r.approvals.spec,null);assert.equal(r.status,'awaiting_spec');
});
