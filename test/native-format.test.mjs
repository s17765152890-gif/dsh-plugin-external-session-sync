// Mirrors the V4 relations keeper from @deepseek-ai/dsh-session-format-v3-to-v4 so the
// importer's event shape can be checked without a running DSH:
//   requireStep  : a STEP_EVENT_TYPES event must match the open turn and step
//   foldSurface  : a system/message may only open the surface; a later one without a
//                  recorded protected head is "requires a protected first surface head"
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nativeEvents} from '../native.js';

const SURFACE_TYPES = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result']);
const STEP_EVENT_TYPES = new Set(['system/message', 'developer/message', 'assistant/attempt']);

export function checkRelations(events) {
  let turn = null;
  let step = null;
  let stepHasAssistant = false;
  const surface = [];
  let protectedHead;
  const fail = (message) => { throw new Error(message); };
  const requireStep = (event) => {
    if (turn === null || step === null || event.data.turn !== turn || event.data.step !== step) {
      fail(`${event.type} does not match an open turn and step`);
    }
  };
  const foldSurface = (event) => {
    if (!SURFACE_TYPES.has(event.type)) return;
    if (event.type === 'system/message' && surface.length > 0 && protectedHead === undefined) {
      fail('system/message requires a protected first surface head');
    }
    if (event.surfaceOp === 'append') {
      if (event.type === 'system/message' && surface.length === 0) protectedHead = event.seq;
      surface.push(event.seq);
      return;
    }
    fail(`${event.type} uses an unsupported surfaceOp in this check`);
  };

  events.forEach((event, index) => {
    if (event.seq !== index) fail(`event ${index} has non-dense seq ${event.seq}`);
    if (event.type === 'turn/start') {
      if (turn !== null) fail('turn/start nests inside an open turn');
      turn = event.data.turn;
      step = null;
      return;
    }
    if (event.type === 'step/start') {
      if (turn === null) fail('step/start is outside an open turn');
      if (event.data.turn !== turn) fail('step/start names another turn');
      step = event.data.step;
      stepHasAssistant = false;
      return;
    }
    if (event.type === 'step/end') {
      requireStep(event);
      step = null;
      return;
    }
    if (event.type === 'turn/end') {
      if (event.data.turn !== turn) fail('turn/end names another turn');
      turn = null;
      step = null;
      return;
    }
    if (event.type === 'user/message') {
      if (turn === null) fail('user/message is outside an open turn');
      foldSurface(event);
      return;
    }
    if (event.type === 'assistant/message') {
      requireStep(event);
      foldSurface(event);
      stepHasAssistant = true;
      return;
    }
    if (STEP_EVENT_TYPES.has(event.type)) {
      requireStep(event);
      foldSurface(event);
      return;
    }
    // session/title and friends: seq references must point backwards at a real event.
    if (event.type === 'session/title' && Array.isArray(event.data.messageSeqs)) {
      for (const seq of event.data.messageSeqs) {
        if (!(seq >= 0 && seq < index)) fail('session/title references a later event');
      }
    }
  });
  if (turn !== null) fail('the log ends inside an open turn');
  return {surface, protectedHead};
}

/** What the runtime appends when the user continues an imported conversation. */
function continuation(events) {
  const start = events.length;
  const out = [...events];
  const turn = Math.max(0, ...events.filter((e) => e.type === 'turn/start').map((e) => e.data.turn)) + 1;
  const push = (type, data, surface = false) => {
    const event = {type, seq: out.length, time: 0, data};
    if (surface) event.surfaceOp = 'append';
    out.push(event);
  };
  push('turn/start', {turn});
  push('step/start', {turn, step: 1});
  push('system/message', {turn, step: 1, message: {role: 'system', content: [{type: 'text', text: 'live prompt'}]}}, true);
  push('user/message', {role: 'user', id: 'u-next', source: {kind: 'user'}, content: [{type: 'text', text: '继续'}]}, true);
  push('assistant/message', {turn, step: 1, stream: [], message: {id: 'a-next', role: 'assistant', source: {kind: 'model', provider: 'x', model: 'y'}, content: [{type: 'text', text: 'ok'}]}}, true);
  push('step/end', {turn, step: 1});
  push('turn/end', {turn, reason: {kind: 'completed'}});
  return {events: out, appendedAt: start};
}

const conversation = {
  title: 'imported chat',
  startedAt: 1793330839911,
  messages: [
    {role: 'user', text: '第一问', timestamp: 1793330839911},
    {role: 'assistant', text: '第一答', timestamp: 1793330845000},
    {role: 'assistant', text: '补充', timestamp: 1793330850000},
    {role: 'user', text: '第二问', timestamp: 1793330855000},
    {role: 'assistant', text: '第二答', timestamp: 1793330860000},
  ],
};

test('imported events open the surface with a protected system head inside a step', () => {
  const events = nativeEvents(conversation, 'codex');
  const {surface, protectedHead} = checkRelations(events);
  const first = events.find((event) => event.seq === surface[0]);
  assert.equal(first.type, 'system/message');
  assert.equal(protectedHead, surface[0]);
  // DSH's seed validator rejects a system message that is not an identified message.
  assert.equal(typeof first.data.message.id, 'string');
  assert.equal(first.data.message.source.kind, 'system-prompt');
  assert.ok(events.some((event) => event.type === 'user/message'));
});

test('continuing an imported conversation keeps the log valid', () => {
  const events = nativeEvents(conversation, 'codex');
  const {events: continued} = continuation(events);
  // Reproduce the reported failure: the runtime appends its own system message.
  assert.doesNotThrow(() => checkRelations(continued));
  assert.ok(continued.filter((event) => event.type === 'system/message').length >= 2);
});

test('the previous shape without a head fails exactly on the continued turn', () => {
  // The shape the importer used to write: turn/start, user/message, then steps.
  const legacy = [
    {type: 'turn/start', seq: 0, time: 0, data: {turn: 1}},
    {type: 'user/message', seq: 1, time: 0, surfaceOp: 'append', data: {role: 'user', id: 'u1', source: {kind: 'user'}, content: [{type: 'text', text: '第一问'}]}},
    {type: 'step/start', seq: 2, time: 0, data: {turn: 1, step: 1}},
    {type: 'assistant/message', seq: 3, time: 0, surfaceOp: 'append', data: {turn: 1, step: 1, stream: [], message: {id: 'a1', role: 'assistant', source: {kind: 'model', provider: 'codex', model: 'external-history'}, content: [{type: 'text', text: '第一答'}]}}},
    {type: 'step/end', seq: 4, time: 0, data: {turn: 1, step: 1}},
    {type: 'turn/end', seq: 5, time: 0, data: {turn: 1, reason: {kind: 'completed'}}},
  ];
  checkRelations(legacy); // readable on its own, which is why the import looked fine
  const {events: continued} = continuation(legacy);
  assert.throws(() => checkRelations(continued), /protected first surface head/);
});

test('assistant-first history still produces a usable protected head', () => {
  const assistantFirst = {title: null, startedAt: 1, messages: [{role: 'assistant', text: '只有回答'}]};
  const {surface, protectedHead} = checkRelations(nativeEvents(assistantFirst, 'codex'));
  assert.equal(protectedHead, surface[0]);
});

test('an empty conversation yields no events at all', () => {
  assert.deepEqual(nativeEvents({messages: []}, 'codex'), []);
});

test('a custom head text is honoured', () => {
  const events = nativeEvents(conversation, 'codex', {systemHead: 'custom head'});
  const head = events.find((event) => event.type === 'system/message');
  assert.equal(head.data.message.content[0].text, 'custom head');
});
