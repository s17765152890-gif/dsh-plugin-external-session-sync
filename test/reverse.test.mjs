import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sessionMessages,cleanUserText,pendingTurns,prefixMatches,turnRecords,openSessionViaPersistence,readSessionAny,readHeaderAny} from '../reverse.js';

const event=(type,data,time=0)=>({type,seq:0,time,data});

test('runtime context is never treated as something the user said',()=>{
  assert.equal(cleanUserText('<system-reminder> skills catalog …'),'');
  assert.equal(cleanUserText('Current runtime context. snapshot …'),'');
  assert.equal(cleanUserText('Time sampled while preparing turn 3, step 1: …'),'');
  assert.equal(cleanUserText('<environment_context><cwd>x</cwd></environment_context>'),'');
  assert.equal(cleanUserText('这些向上的分之是什么意思？'),'这些向上的分之是什么意思？');
  // A real question with an injected reminder appended keeps only the question.
  assert.equal(cleanUserText('真正的问题 <system-reminder>noise'),'真正的问题');
});

test('session messages skip injected blocks and keep real turns',()=>{
  const events=[
    event('turn/start',{turn:1}),
    event('user/message',{role:'user',content:[{type:'text',text:'第一问'}]},1000),
    event('assistant/message',{message:{content:[{type:'text',text:'第一答'}]}},2000),
    event('turn/start',{turn:2}),
    event('user/message',{role:'user',content:[{type:'text',text:'<system-reminder>ctx'}]},3000),
    event('user/message',{role:'user',content:[{type:'text',text:'第二问'}]},4000),
    event('assistant/message',{message:{content:[{type:'text',text:'第二答'}]}},5000),
  ];
  const messages=sessionMessages(events);
  assert.deepEqual(messages.map((m)=>m.role+':'+m.text),['user:第一问','assistant:第一答','user:第二问','assistant:第二答']);
  assert.equal(messages.at(-1).turn,2);
});

test('only messages after the fork boundary become pending turns',()=>{
  const messages=[
    {role:'user',text:'seed question'},{role:'assistant',text:'seed answer'},
    {role:'user',text:'new question'},{role:'assistant',text:'new answer'},
  ];
  const turns=pendingTurns(messages,2);
  assert.equal(turns.length,1);
  assert.equal(turns[0].user.text,'new question');
  assert.equal(turns[0].assistants.length,1);
  // A turn with no assistant reply cannot be written as a completed Codex turn.
  assert.equal(pendingTurns([{role:'user',text:'lonely'}],0).length,0);
});

test('a fork prefix must match its parent before writing back',()=>{
  const parent=[{role:'user',text:'a'},{role:'assistant',text:'b'}];
  assert.equal(prefixMatches([{role:'user',text:'a'},{role:'assistant',text:'b'},{role:'user',text:'c'}],parent),true);
  assert.equal(prefixMatches([{role:'user',text:'a'},{role:'assistant',text:'DIFFERENT'}],parent),false);
  assert.equal(prefixMatches([{role:'user',text:'a'}],parent),false);
});

test('turn records mirror the Codex sequence',()=>{
  const records=turnRecords({threadId:'thread-1',modelContextWindow:123000,ordinal:10,turn:{
    user:{role:'user',text:'hello',time:1700000000000},
    assistants:[{role:'assistant',text:'hi',time:1700000001000}],
  }});
  assert.equal(records.length,6);
  assert.deepEqual(records.map((r)=>r.type+'/'+r.payload.type),[
    'event_msg/task_started','response_item/message','event_msg/item_completed',
    'response_item/message','event_msg/item_completed','event_msg/task_complete',
  ]);
  assert.deepEqual(records.map((r)=>r.ordinal),[10,11,12,13,14,15]);
  assert.equal(records[1].payload.role,'user');
  assert.equal(records[1].payload.content[0].text,'hello');
  assert.equal(records[3].payload.role,'assistant');
  assert.equal(records[5].payload.last_agent_message,'hi');
  assert.equal(records[2].payload.thread_id,'thread-1');
  for(const record of records) assert.ok(!Number.isNaN(Date.parse(record.timestamp)));
});
test('sessions are read through the persistence API when it is available', async () => {
  let closed = 0;
  const events = [{type: 'user/message', data: {content: [{type: 'text', text: 'q'}]}}];
  const ctx = {
    sessionPersistence: {
      async open(id, access) {
        assert.equal(access, 'read');
        assert.equal(id, 'session-x');
        return {header: {id, cwd: 'C:\\p'}, async read() { return {events}; }, async close() { closed += 1; }};
      },
    },
  };
  const viaApi = await openSessionViaPersistence(ctx, 'session-x');
  assert.equal(viaApi.via, 'persistence');
  assert.equal(viaApi.events.length, 1);
  assert.equal(viaApi.meta.cwd, 'C:\\p');
  assert.equal(closed, 1, 'the handle must be closed');
  const read = await readSessionAny(ctx, 'session-x');
  assert.equal(read.via, 'persistence');
});

test('a refusing persistence service falls back instead of throwing', async () => {
  const ctx = {sessionPersistence: {async open() { throw new Error('unsupported format'); }}};
  assert.equal(await readSessionAny(ctx, 'session-does-not-exist'), null);
  assert.equal(await readHeaderAny(ctx, 'session-does-not-exist'), null);
});

test('a service without open() is tolerated', async () => {
  assert.equal(await readSessionAny({sessionPersistence: {}}, 'session-y'), null);
  assert.equal(await readSessionAny(null, 'session-y'), null);
});