import crypto from 'node:crypto';

export function canonicalCwd(value) {
  if (!value) return undefined;
  let cwd = String(value);
  if (cwd.startsWith('\\\\?\\UNC\\')) cwd = '\\\\' + cwd.slice(8);
  else if (cwd.startsWith('\\\\?\\')) cwd = cwd.slice(4);
  return cwd;
}

export function nativeId(source, id, revision) {
  const bytes = crypto.createHash('sha256').update(`dsh-sync-native-1:${source}:${id}:${revision}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const s = bytes.toString('hex');
  return `session-${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}

// Foreign tool execution is never replayed. Each assistant occupies one closed step.
export function nativeEvents(conversation, source) {
  const events = [];
  const messages = (conversation.messages || []).filter(m => ['user','assistant'].includes(m.role) && m.text?.trim());
  let turn = 0, step = 0, turnOpen = false, stepOpen = false, userAnchor;
  let clock = Number(conversation.startedAt) || Date.now();
  const append = (type, data, surface = false) => {
    const event = { type, seq: events.length, time: clock, data };
    if (surface) event.surfaceOp = 'append';
    events.push(event);
    return event.seq;
  };
  const endStep = () => { if (stepOpen) append('step/end', {turn, step}); stepOpen = false; };
  const endTurn = () => { endStep(); if (turnOpen) append('turn/end', {turn, reason:{kind:'completed'}}); turnOpen = false; };
  for (const m of messages) {
    const time = typeof m.timestamp === 'number' ? m.timestamp : Date.parse(m.timestamp);
    if (Number.isFinite(time)) clock = Math.max(clock, time);
    if (m.role === 'user') {
      endTurn(); turn++; step = 0; turnOpen = true;
      append('turn/start', {turn});
      const seq = append('user/message', {role:'user', id:crypto.randomUUID(), source:{kind:'user'}, content:[{type:'text', text:m.text}]}, true);
      if (userAnchor === undefined) userAnchor = seq;
    } else {
      if (!turnOpen) { turn++; turnOpen = true; step = 0; append('turn/start',{turn}); }
      endStep(); step++; stepOpen = true;
      append('step/start', {turn, step});
      append('assistant/message', {turn, step, stream:[], message:{id:crypto.randomUUID(), role:'assistant', source:{kind:'model',provider:source,model:'external-history'}, content:[{type:'text',text:m.text}]}}, true);
      endStep();
    }
  }
  endTurn();
  // DSH requires messageSeqs to be non-empty for every non-user title. With no user
  // message to anchor, emit no title event at all: DSH derives one from the history.
  if (userAnchor !== undefined) {
    append('session/title', {title:conversation.title || '外部会话', messageSeqs:[userAnchor], source:{kind:'fallback'}});
  }
  return events;
}
