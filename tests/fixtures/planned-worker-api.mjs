import readline from 'node:readline';
import {randomUUID} from 'node:crypto';
import {createApp} from '../../server.mjs';
import {contentRevision,planningRevision} from '../../lib/planning-review.mjs';
import {validateEngineeringPlan} from '../../lib/engineering-plan.mjs';
import {engineeringTasks} from '../../lib/engineering-planner.mjs';
const lines=readline.createInterface({input:process.stdin});let app;
for await(const line of lines){const input=JSON.parse(line);if(input.close){await app.close();console.log(JSON.stringify({closed:true}));break}
  app=await createApp({loadEnv:false,dataDir:input.directory,stepDelayMs:0,teamEnabled:false});let identity=input.identity;
  if(input.seed){
    const source={filename:'requirements.md',content:'Visitors read the welcome page and health endpoint.'},project=await app.store.create({name:'Persistent API Worker diagnostic',source}),runId=randomUUID();
    const spec={title:'Welcome',summary:source.content,goals:['Read welcome'],roles:[],constraints:[],assumptions:[],questions:[],acceptanceScenarios:['Welcome and health are observable'],stack:{frontend:'HTML/CSS/JavaScript',backend:'Node.js',storage:'SQLite'},requirements:[{id:'R',title:'Welcome',description:source.content,sourceQuote:source.content,acceptance:['Health ok and Welcome text']} ]},specRevision=contentRevision(spec);
    const finalPaths = input.sharedWritablePath ? ['docs/README.md', 'src/app.mjs'] : ['docs/README.md'];
    const engineeringPlan=validateEngineeringPlan({spec,binding:{projectId:project.id,runId,specRevision},proposal:{version:1,title:'Welcome',summary:source.content,entities:[],routes:[{id:'health',method:'GET',path:'/health',roles:[],request:'none',response:'ok boolean',errors:[],requirementIds:['R']}],views:[{id:'home',path:'/',title:'Welcome',requirementIds:['R'],selectors:[{testId:'welcome',role:'heading'}]}],tasks:[{id:'base',title:'Base',description:'Read welcome and health',dependsOn:[],requirementIds:['R'],writePaths:['src/app.mjs'],inputs:['spec'],outputs:['app'],acceptance:['Joint health and welcome']},{id:'final',title:'Final',description:'Full joint integration',dependsOn:['base'],requirementIds:['R'],writePaths:finalPaths,inputs:['base'],outputs:['documentation'],acceptance:['Full approved joint checks']}]}}); 
    const run={id:runId,projectId:project.id,workflowVersion:2,sourceSnapshot:source,sourceRevision:contentRevision(source),sourceGeneration:0,status:'succeeded',stages:[],spec,specRevision,specQuestions:[],engineeringPlan,tasks:engineeringTasks(engineeringPlan),artifacts:[{name:'architecture.md',content:'Welcome page with health endpoint'}],review:{passed:true,issues:[]},approvals:{spec:{revision:specRevision}}};run.planRevision=planningRevision(run);run.approvals.plan={revision:run.planRevision,specRevision};project.runs.push(run);await app.store.save(project);identity={projectId:project.id,runId};
  }
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));console.log(JSON.stringify({ready:true,pid:process.pid,origin:`http://127.0.0.1:${app.server.address().port}`,identity}));
}
lines.close();
