import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test,after} from 'node:test';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-sync-refresh-'));
process.env.CODEX_HOME=root;
const {DatabaseSync}=process.getBuiltinModule('node:sqlite');
const db=new DatabaseSync(path.join(root,'state_5.sqlite'));
db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,name TEXT,cwd TEXT,created_at_ms INTEGER,updated_at_ms INTEGER,rollout_path TEXT,archived INTEGER,thread_source TEXT,agent_path TEXT,model TEXT)');
const add=db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?)');
const oldId='00000000-0000-4000-8000-000000000001',freshId='00000000-0000-4000-8000-000000000002';
const sessions=path.join(root,'sessions');fs.mkdirSync(sessions);
const fileFor=(id,suffix='')=>path.join(sessions,`rollout-2026-10-15T18-00-00-${id}${suffix}.jsonl`);
const writeRollout=(id,suffix='')=>{const file=fileFor(id,suffix);fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id,cwd:root,timestamp:'2026-10-15T10:00:00Z'}})+'\n');return file;};
const oldFile=writeRollout(oldId);
add.run(oldId,'existing',null,root,100,200,oldFile,0,'user',null,null);
const {discoverCodexThreads}=await import('../discovery.js');

test('a second refresh discovers a new rollout before SQLite indexes it, then updates its title without duplication',()=>{
  assert.equal(discoverCodexThreads().length,1);
  const freshFile=writeRollout(freshId);
  let catalog=discoverCodexThreads();assert.equal(catalog.length,2);assert.ok(catalog.find(row=>row.id===freshId));
  add.run(freshId,'newly discovered chat',null,root,300,400,freshFile,0,'user',null,null);
  catalog=discoverCodexThreads();assert.equal(catalog.length,2);assert.equal(catalog.find(row=>row.id===freshId).title,'newly discovered chat');
});
test('continued rollout segments share one row and growing text invalidates its revision',()=>{
  const before=discoverCodexThreads().find(row=>row.id===oldId);
  const continued=writeRollout(oldId,'_00000000-0000-4000-8000-000000000003');
  let item=discoverCodexThreads().find(row=>row.id===oldId);
  assert.equal(item.rolloutCount,2);assert.notEqual(item.revision,before.revision);
  const revision=item.revision;fs.appendFileSync(continued,JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'new turn'}]}})+'\n');
  item=discoverCodexThreads().find(row=>row.id===oldId);assert.notEqual(item.revision,revision);
});
test('unchanged history keeps stable native snapshot revisions',()=>{
  assert.deepEqual(discoverCodexThreads().map(row=>[row.id,row.revision]),discoverCodexThreads().map(row=>[row.id,row.revision]));
});
after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
