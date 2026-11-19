// A small independent benchmark for the general executor, not its default business.
const requirements = '访客可以查看便笺列表。访客可以创建非空且最多100字的便笺。重复名称必须拒绝且列表不变。进程重启后保留便笺。';
const rules = [
  ['R-LIST', '查看列表', '访客可以查看便笺列表。', 'GET /api/notes返回{notes:[{id,name}]}，初始空列表。'],
  ['R-CREATE', '创建便笺', '访客可以创建非空且最多100字的便笺。', 'POST /api/notes接收{name}；有效名称返回201 {note:{id,name}}；空白或超过100字返回400且不修改数据。'],
  ['R-UNIQUE', '名称唯一', '重复名称必须拒绝且列表不变。', '去首尾空格后同名返回409，不能重复创建。'],
  ['R-PERSIST', '重启持久化', '进程重启后保留便笺。', '使用传入databasePath的真实SQLite notes(id,name)表；重启后内容保留。'],
];
const spec = { title: '便笺管理', summary: requirements, goals: ['浏览并创建持久化便笺'], roles: ['访客'], constraints: ['无需登录，不接入外部服务', 'Node.js内置模块、原生前端、SQLite'], assumptions: [], questions: [],
  acceptanceScenarios: rules.map(rule => rule[3]), stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' },
  requirements: rules.map(([id, title, sourceQuote, acceptance]) => ({ id, title, description: sourceQuote, sourceQuote, acceptance: [acceptance] })) };
const task = { title: spec.title, summary: spec.summary, goals: spec.goals, roles: spec.roles, constraints: spec.constraints,
  acceptanceScenarios: [...spec.acceptanceScenarios, 'GET /返回网页，外部同源脚本/样式；data-testid为note-name（标签输入）、note-create（按钮）、note-list（列表，显示纯名称）、note-count（数量文本）、note-error（错误文本）。',
    '页面实际GET/POST API，创建后列表及数量更新；重复名称显示“名称已存在”，保持列表和数量。前端可在已加载列表中先查重，避免产生预期HTTP错误的控制台网络噪声；后端仍必须独立409校验。',
    '桌面和390px均无横向溢出，无console错误，不请求外网，不使用内联脚本/样式或事件属性。'],
  engineeringContract: { entities: [{ id: 'notes', name: '便笺', table: 'notes', fields: [{ name: 'id', type: 'integer', primary: true }, { name: 'name', type: 'string', required: true, unique: true }] }],
    routes: [{ method: 'GET', path: '/api/notes', response: '{notes:[{id,name}]}' }, { method: 'POST', path: '/api/notes', request: '{name}', response: '201 {note:{id,name}}，非法400，同名409' }] },
  tasks: [{ id: 'NOTES', title: '实现便笺页面、API与持久化', description: requirements, requirementIds: rules.map(rule => rule[0]), dependsOn: [],
    inputs: ['确认规格及实体/API约定'], outputs: ['可运行页面、API、真实SQLite数据'], acceptance: rules.map(rule => rule[3]),
    writePaths: ['src/app.mjs', 'public/index.html', 'public/app.js', 'public/styles.css', 'migrations/001.sql', 'docs/usage.md'] }] };
const request = (id, method, path, dependsOn, requirementIds, assertions, body) => ({ id, type: 'request', dependsOn, requirementIds,
  request: { id: `${id}_http`, method, path, assertions, ...(body === undefined ? {} : { body }) } });
const status = (id, value) => ({ id: `${id}_status`, op: 'status', value });
const definition = { version: 1, id: 'notes-behavior', name: '便笺接口与网页业务验收', sessions: [], limits: { timeoutMs: 90000, requestTimeoutMs: 5000 }, steps: [
  request('empty', 'GET', '/api/notes', [], ['R-LIST'], [status('empty', 200), { id: 'empty_notes', op: 'jsonLength', path: '$.notes', value: 0 }]),
  request('create', 'POST', '/api/notes', ['empty'], ['R-CREATE'], [status('create', 201), { id: 'created_name', op: 'jsonEquals', path: '$.note.name', value: '接口便笺' }], { name: '接口便笺' }),
  request('duplicate', 'POST', '/api/notes', ['create'], ['R-UNIQUE'], [status('duplicate', 409)], { name: ' 接口便笺 ' }),
  request('blank', 'POST', '/api/notes', ['duplicate'], ['R-CREATE'], [status('blank', 400)], { name: ' ' }),
  { id: 'restart', type: 'restart', dependsOn: ['blank'], requirementIds: ['R-PERSIST'] },
  request('saved', 'GET', '/api/notes', ['restart'], ['R-LIST', 'R-PERSIST', 'R-UNIQUE'], [status('saved', 200), { id: 'saved_count', op: 'jsonLength', path: '$.notes', value: 1 }, { id: 'saved_name', op: 'jsonEquals', path: '$.notes[0].name', value: '接口便笺' }]),
], browser: { version: 1, sessions: ['visitor'], limits: { timeoutMs: 90000, actionTimeoutMs: 5000 }, steps: [
  { id: 'home', session: 'visitor', requirementIds: ['R-LIST'], op: 'goto', path: '/' },
  { id: 'empty', session: 'visitor', requirementIds: ['R-LIST'], op: 'text', testId: 'note-count', value: '0' },
  { id: 'name', session: 'visitor', requirementIds: ['R-CREATE'], op: 'fill', testId: 'note-name', value: '网页便笺' },
  { id: 'create', session: 'visitor', requirementIds: ['R-CREATE'], op: 'click', testId: 'note-create' },
  { id: 'count', session: 'visitor', requirementIds: ['R-CREATE'], op: 'text', testId: 'note-count', value: '1' },
  { id: 'list', session: 'visitor', requirementIds: ['R-LIST'], op: 'text', testId: 'note-list', value: '网页便笺' },
  { id: 'same_name', session: 'visitor', requirementIds: ['R-UNIQUE'], op: 'fill', testId: 'note-name', value: '网页便笺' },
  { id: 'again', session: 'visitor', requirementIds: ['R-UNIQUE'], op: 'click', testId: 'note-create' },
  { id: 'error', session: 'visitor', requirementIds: ['R-UNIQUE'], op: 'text', testId: 'note-error', value: '名称已存在' },
  { id: 'refresh', session: 'visitor', requirementIds: ['R-PERSIST'], op: 'goto', path: '/' },
  { id: 'kept', session: 'visitor', requirementIds: ['R-PERSIST'], op: 'text', testId: 'note-count', value: '1' },
] } };
const files = [
  { path: 'src/app.mjs', content: `import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
export async function createApp({databasePath}) {
 const db=new DatabaseSync(databasePath); db.exec('CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)');
 const list=()=>db.prepare('SELECT id,name FROM notes ORDER BY id').all();
 const json=(status,value)=>({status,headers:{'content-type':'application/json'},body:JSON.stringify(value)});
 return { async handle(req) {
  const p=new URL(req.path,'http://local').pathname;
  if(req.method==='GET'&&p==='/api/notes')return json(200,{notes:list()});
  if(req.method==='POST'&&p==='/api/notes'){
   let value;try{value=JSON.parse(req.body)}catch{return json(400,{error:'无效输入'})}
   if(!value||typeof value.name!=='string'||Object.keys(value).some(k=>k!=='name'))return json(400,{error:'无效输入'});
   const name=value.name.trim();if(!name||name.length>100)return json(400,{error:'名称长度无效'});
   try{const id=Number(db.prepare('INSERT INTO notes(name) VALUES(?)').run(name).lastInsertRowid);return json(201,{note:{id,name}})}catch{return json(409,{error:'名称已存在'})}
  }
  const staticFiles={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/styles.css':['styles.css','text/css']};
  if(req.method==='GET'&&Object.hasOwn(staticFiles,p)){const [file,type]=staticFiles[p];return {status:200,headers:{'content-type':type},body:await readFile(new URL('../public/'+file,import.meta.url))}}
  return json(404,{error:'不存在'});
 },close(){db.close()}};
}
` },
  { path: 'public/index.html', content: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>便笺</title><link rel="stylesheet" href="/styles.css"><main><h1>便笺</h1><form id="form"><label>名称<input data-testid="note-name" id="name" maxlength="100" required></label><button data-testid="note-create">创建</button></form><p data-testid="note-error" id="error" role="status"></p><p>数量：<span data-testid="note-count" id="count">0</span></p><ul data-testid="note-list" id="list"></ul></main><script src="/app.js" defer></script></html>' },
  { path: 'public/styles.css', content: 'body{margin:0;background:#f5f7fa;color:#243047;font:16px/1.6 system-ui}main{max-width:620px;margin:30px auto;padding:20px}form{display:flex;flex-wrap:wrap;gap:12px;align-items:end}label{display:grid;gap:6px;flex:1}input,button{box-sizing:border-box;max-width:100%;font:inherit;padding:8px}li{overflow-wrap:anywhere}' },
  { path: 'public/app.js', content: `let notes=[];const by=id=>document.getElementById(id);async function load(){const res=await fetch('/api/notes');notes=(await res.json()).notes;by('list').replaceChildren(...notes.map(n=>{const li=document.createElement('li');li.textContent=n.name;return li}));by('count').textContent=String(notes.length)}by('form').addEventListener('submit',async e=>{e.preventDefault();const name=by('name').value.trim();by('error').textContent='';if(notes.some(n=>n.name===name)){by('error').textContent='名称已存在';return}const res=await fetch('/api/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})});if(!res.ok){by('error').textContent=(await res.json()).error;return}by('name').value='';await load()});load();` },
];
export const plannedNotes = { requirements, spec, task, definition, files };
