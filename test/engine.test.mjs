import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SyncEngine} from '../engine.js';

function fixture(t,{stored=true,member=false,failAttach=false}={}) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-sync-membership-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const id='session-existing',external='external-thread',revision='unchanged',key='codex:'+external;
  const calls={append:0,create:0,prepare:0,resolve:0,attach:0};
  const events=[{type:'user/message',data:{content:[{type:'text',text:'question'}]}},{type:'assistant/message',data:{message:{content:[{type:'text',text:'answer'}]}}}];
  const workspace={id:'workspace-1',title:'project',path:home,sessionIds:member?[id]:[],async attachSession(target){calls.attach++;if(failAttach)throw new Error('attach denied');if(!this.sessionIds.includes(target))this.sessionIds.push(target);}};
  const inspected={meta:{id,cwd:home},events};
  const ctx={sessionPersistence:{async stat(){return stored?{header:inspected.meta}:undefined;},async open(){return {header:inspected.meta,async read(){return {events};},async close(){}};},async create(){calls.create++;stored=true;return {async append(){calls.append++;},async flush(){},async close(){}};}},
    sessions:{prepare(){calls.prepare++;return {header:inspected.meta};},get(){return {deriveMessages:()=>[{role:'user'},{role:'assistant'}]};}},
    sessionController:{async inspect(){return inspected;},async resolveAgent(target){calls.resolve++;return {agent:{id:target}};},async create(){throw new Error('must never create a blank conversation');}},
    workspaceRegistry:{async create(){return workspace;},list(){return [workspace];}}};
  const engine=new SyncEngine(ctx,home);
  engine.discover=async()=>[{source:'codex',id:external,revision,title:'imported',cwd:home}];
  engine.state.entries[key]={sessionId:id,revision,workspaceId:workspace.id,importedAt:123,archive:'unchanged'};
  engine.readSource=async()=>({title:'imported',cwd:home,messages:[{role:'user',text:'question'},{role:'assistant',text:'answer'}]});
  return {engine,ctx,workspace,calls,id,key};
}

test('unchanged snapshot repairs missing workspace membership using the original session id',async t=>{
  const f=fixture(t);const r=await f.engine.run({source:'codex'});
  assert.equal(r.failed.length,0);assert.equal(r.repaired.length,1);assert.equal(r.skipped[0].id,f.id);
  assert.ok(f.workspace.sessionIds.includes(f.id));assert.equal(f.calls.append,0);assert.equal(f.calls.create,0);assert.equal(f.calls.resolve,1);
  assert.equal(f.engine.state.entries[f.key].workspaceAttached,true);assert.equal(f.engine.state.entries[f.key].importedAt,123);
});
test('resynchronizing an associated conversation neither rewrites history nor duplicates membership',async t=>{
  const f=fixture(t,{member:true});const r=await f.engine.run({source:'codex'});
  assert.equal(r.repaired.length,0);assert.equal(r.failed.length,0);assert.equal(f.workspace.sessionIds.length,1);assert.equal(f.calls.append,0);
});
test('dry run leaves membership and mapping untouched',async t=>{
  const f=fixture(t);const before=JSON.stringify(f.engine.state);await f.engine.run({source:'codex',dryRun:true});
  assert.equal(f.calls.attach,0);assert.equal(f.calls.resolve,0);assert.equal(JSON.stringify(f.engine.state),before);
});
test('failed workspace registration is surfaced rather than reported as already synced',async t=>{
  const f=fixture(t,{failAttach:true});const before=JSON.stringify(f.engine.state);const r=await f.engine.run({source:'codex'});
  assert.equal(r.failed.length,1);assert.match(r.failed[0].error,/attach denied/);assert.equal(r.skipped.length,0);assert.equal(JSON.stringify(f.engine.state),before);
});
test('new native imports resume the persisted original identity instead of calling the blank-chat controller',async t=>{
  const f=fixture(t,{stored:false});f.engine.state.entries={};const r=await f.engine.run({source:'codex'});
  assert.equal(r.failed.length,0);assert.equal(r.imported.length,1);assert.equal(f.calls.create,1);assert.equal(f.calls.resolve,1);assert.ok(f.workspace.sessionIds.includes(r.imported[0].id));
});
