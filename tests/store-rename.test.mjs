import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { replaceFileAtomically } from '../lib/store.mjs';
async function files(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'atomic-store-')),source=path.join(root,'new.tmp'),target=path.join(root,'project.json');
  await writeFile(source,'new');await writeFile(target,'old');t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await rm(root,{recursive:true,force:true})});return{source,target};
}
test('temporary Windows sharing error retains old bytes until the atomic rename succeeds',async t=>{
  const {source,target}=await files(t);let calls=0;await replaceFileAtomically(source,target,{platform:'win32',renameFile:async(a,b)=>{calls++;assert.equal(await readFile(target,'utf8'),'old');if(calls<3)throw Object.assign(new Error('sharing'),{code:'EPERM'});await rename(a,b)}});
  assert.equal(await readFile(target,'utf8'),'new');await assert.rejects(readFile(source),{code:'ENOENT'});
});
test('permanent sharing failure remains visible and preserves both files',async t=>{
  const {source,target}=await files(t),error=Object.assign(new Error('denied'),{code:'EACCES'});let calls=0;
  await assert.rejects(replaceFileAtomically(source,target,{platform:'win32',renameFile:async()=>{calls++;throw error}}),value=>value===error);assert.ok(calls>1&&calls<=5);assert.equal(await readFile(source,'utf8'),'new');assert.equal(await readFile(target,'utf8'),'old');
});
test('unrelated errors and other platforms fail immediately',async t=>{
  const {source,target}=await files(t);for(const [platform,code]of[['win32','ENOENT'],['linux','EPERM']]){let calls=0;await assert.rejects(replaceFileAtomically(source,target,{platform,renameFile:async()=>{calls++;throw Object.assign(new Error('failure'),{code})}}),{code});assert.equal(calls,1)}
});
