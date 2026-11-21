import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createProjectCodeModel} from '../lib/project-code-model.mjs';
import {createProjectReviewModel} from '../lib/project-review-model.mjs';
import {getModelRequestEvidence} from '../lib/model-request-evidence.mjs';
import {snapshotModelControls} from '../lib/planner.mjs';
import {normalizeWorkerModelConfig,workerModelConfigRevision,workerHash,createApprovedWorkerJob} from '../lib/planned-worker-contract.mjs';
import {openPlannedWorkerStore} from '../lib/planned-worker-store.mjs';
import {launchPlannedWorker,launchResumedPlannedWorker} from '../lib/planned-worker-client.mjs';
import {createWorkerAuthority,signWorkerAuthorization} from '../lib/planned-worker-seals.mjs';
import {preflightPlannedTasks} from '../scripts/check-planned-tasks.mjs';

async function environment(values,work){const before=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));try{for(const[k,v]of Object.entries(values)){if(v===undefined)delete process.env[k];else process.env[k]=v;}return await work();}finally{for(const[k,v]of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}}
const source=[{path:'src/app.mjs',content:'export async function createApp(){return {handle:async()=>({status:200,body:"ok"})}}\n'}];

test('real localhost HTTP code and Review freeze both explicit and absent request controls without raising token caps',async t=>{
  const requests=[];
  const server=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text),input=JSON.parse(body.messages.at(-1).content);requests.push(body);const value=Object.hasOwn(input,'feedback')?{files:source}:{summary:'Fixed local review transport only',issues:[],resolutions:[]};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}],usage:{prompt_tokens:2,completion_tokens:3}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const config={baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'controls-local',apiKey:'synthetic-controls-key'};
  for(const initial of [{LLM_THINKING:'disabled',LLM_JSON_MODE:'0'},{LLM_THINKING:undefined,LLM_JSON_MODE:undefined},{LLM_THINKING:'',LLM_JSON_MODE:''}])await environment(initial,async()=>{
    const code=createProjectCodeModel({config}),review=createProjectReviewModel({config});process.env.LLM_THINKING='enabled';process.env.LLM_JSON_MODE='1';
    await code({task:'Public fixed code task',files:[]});await review({task:'Public fixed review task',files:source});
    const pair=requests.slice(-2);assert.deepEqual(pair.map(x=>x.max_tokens),[32768,4096]);
    for(const request of pair){if(initial.LLM_THINKING==='disabled'){assert.deepEqual(request.thinking,{type:'disabled'});assert.equal('response_format'in request,false);}else{assert.equal('thinking'in request,false);assert.deepEqual(request.response_format,{type:'json_object'});}}
  });
  await environment({LLM_THINKING:'enabled',LLM_JSON_MODE:'1'},async()=>{
    const supplied={...config,thinking:'disabled',jsonMode:0},code=createProjectCodeModel({config:supplied}),review=createProjectReviewModel({config:supplied});supplied.thinking='enabled';supplied.jsonMode=true;
    await code({task:'Public task',files:[]});await review({task:'Public task',files:source});for(const request of requests.slice(-2)){assert.deepEqual(request.thinking,{type:'disabled'});assert.equal('response_format'in request,false);}
  });
  await environment({LLM_THINKING:'enabled',LLM_JSON_MODE:'0'},async()=>{
    const frozenAbsence={...config,thinking:undefined,jsonMode:undefined};await createProjectCodeModel({config:frozenAbsence})({task:'Public task'});
    assert.equal('thinking'in requests.at(-1),false);assert.deepEqual(requests.at(-1).response_format,{type:'json_object'});
  });
});

test('invalid controls are native pre-dispatch errors and never invoke either adapter fetch',async()=>{
  let calls=0;const config={baseUrl:'http://localhost:1/v1',model:'synthetic-invalid-controls',apiKey:'synthetic-never-send'};
  for(const options of [{thinking:'other'},{thinking:null},{jsonMode:'0'},{jsonMode:'bad'},{jsonMode:null}])for(const factory of [createProjectCodeModel,createProjectReviewModel]){
    const callback=factory({config:{...config,...options},fetchImpl:async()=>{calls++;throw Error('must not send');}});
    await assert.rejects(callback({task:'public',files:source}),error=>{assert.equal(error.message.includes(config.apiKey),false);assert.deepEqual(getModelRequestEvidence(error),{dispatched:false,responseComplete:false});return true;});
  }
  await environment({LLM_THINKING:'disabled',LLM_JSON_MODE:'invalid'},async()=>{await assert.rejects(createProjectCodeModel({config,fetchImpl:async()=>{calls++;}})({task:'public'}));});assert.equal(calls,0);
});

test('wire config revision binds false and thinking while absent controls retain only legacy default compatibility',async()=>{
  const base={baseUrl:'http://localhost:1/v1',model:'public-controls',apiKey:'synthetic-controls'};
  await environment({LLM_THINKING:'enabled',LLM_JSON_MODE:'0'},async()=>{
    assert.deepEqual(normalizeWorkerModelConfig(base),base);assert.equal(workerModelConfigRevision(base),workerHash({baseUrl:base.baseUrl,model:base.model}));
    assert.equal(workerModelConfigRevision({...base,jsonMode:0}),workerModelConfigRevision({...base,jsonMode:false}));
    assert.notEqual(workerModelConfigRevision({...base,jsonMode:false}),workerModelConfigRevision(base));
    assert.notEqual(workerModelConfigRevision({...base,thinking:'disabled'}),workerModelConfigRevision({...base,thinking:'enabled'}));
    assert.deepEqual(normalizeWorkerModelConfig({...base,thinking:undefined,jsonMode:undefined}),base);
    assert.deepEqual(snapshotModelControls({thinking:undefined,jsonMode:undefined}),{});
  });
});

test('invalid or mismatched first/resume settings reject before reserve, markDispatch or generation change',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'worker-controls-')),store=openPlannedWorkerStore({rootDir:root});t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const approved=await preflightPlannedTasks(),config={baseUrl:'http://localhost:1/v1',model:'fake-controls',apiKey:'not-a-real-key',thinking:'disabled',jsonMode:false};
  const job=createApprovedWorkerJob({manifest:approved.manifest,task:approved.task,binding:approved.binding,jobId:'control-job',executionId:'control-execution',proposalId:'control-proposal',revision:'a'.repeat(64),contextHash:'b'.repeat(64),engineeringHash:'c'.repeat(64),sourceRevision:'d'.repeat(64),sourceGeneration:0,rootIdentity:store.identity,configRevision:workerModelConfigRevision(config),deadlineAt:Date.now()+60000,assertCurrent:()=>true});
  for(const invalid of [{...config,jsonMode:'bad'},{...config,thinking:'enabled'},{...config,jsonMode:true},{baseUrl:config.baseUrl,model:config.model,apiKey:config.apiKey}]){
    await assert.rejects(launchPlannedWorker({store,job,config:invalid,executable:process.execPath}),error=>error.code==='worker_model_config_revision');assert.equal(store.get('control-job'),null);
  }
  store.reserve(job,signWorkerAuthorization({authority:createWorkerAuthority({store}),job}));const before=store.get('control-job');
  for(const invalid of [{...config,jsonMode:'bad'},{...config,thinking:'enabled'},{...config,jsonMode:true}])await assert.rejects(launchResumedPlannedWorker({store,jobId:'control-job',permit:{},manifest:approved.manifest,config:invalid,executable:process.execPath}),error=>error.code==='worker_model_config_revision');
  assert.deepEqual(store.get('control-job'),before);
});
