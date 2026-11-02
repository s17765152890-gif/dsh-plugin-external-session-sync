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

/**
 * The system message every imported session starts with.
 *
 * DSH treats the first surface event of a session as the protected head:
 * `session-format`'s relations keeper records `protectedHead` only when a
 * `system/message` is the first surface node, and it throws
 * "system/message requires a protected first surface head" for any later
 * `system/message` when no head was recorded. Continuing an imported chat makes
 * the runtime append its own system message, so an import that starts with a
 * user message corrupts the log on the first continued turn.
 *
 * The text states provenance instead of pretending to be the live prompt: the
 * runtime appends the real prompt when the conversation continues.
 */
export const IMPORT_SYSTEM_HEAD = [
  'This session continues a conversation that was imported from an external agent history by the DSH external session sync plugin.',
  'Earlier turns are a faithful text transcript: tool calls, hidden reasoning and binary attachments were not replayed.',
  'Rely on the files and tools available in this workspace, and verify anything taken from the transcript before acting on it.',
].join('\n\n');

const TITLE_FALLBACK = '外部会话';

// Foreign tool execution is never replayed. One assistant reply occupies one model
// step, and the first step of a turn also carries that turn's user message.
export function nativeEvents(conversation, source, options = {}) {
  const events = [];
  const messages = (conversation.messages || []).filter(
    (message) => (message.role === 'user' || message.role === 'assistant') && message.text?.trim(),
  );
  if (!messages.length) return events;

  const headText = options.systemHead ?? conversation.systemHead ?? IMPORT_SYSTEM_HEAD;
  let clock = Number(conversation.startedAt) || Date.now();
  let turn = 0;
  let step = 0;
  let turnOpen = false;
  let stepOpen = false;
  let stepHasAssistant = false;
  let headSeq;
  let firstUserSeq;

  const append = (type, data, surface = false) => {
    const event = { type, seq: events.length, time: clock, data };
    if (surface) event.surfaceOp = 'append';
    events.push(event);
    return event.seq;
  };
  const openTurn = () => {
    turn += 1;
    step = 0;
    turnOpen = true;
    append('turn/start', { turn });
  };
  const openStep = () => {
    step += 1;
    stepOpen = true;
    stepHasAssistant = false;
    append('step/start', { turn, step });
  };
  const closeStep = () => {
    if (!stepOpen) return;
    append('step/end', { turn, step });
    stepOpen = false;
    stepHasAssistant = false;
  };
  const closeTurn = () => {
    closeStep();
    if (!turnOpen) return;
    append('turn/end', { turn, reason: { kind: 'completed' } });
    turnOpen = false;
  };
  // Emitted only while a step is open: the relations keeper requires it to match
  // the open turn and step, and only the first one becomes the protected head.
  // A seed message also has to be identifiable, so it carries an id and a source.
  const emitHead = () => {
    if (headSeq !== undefined) return headSeq;
    headSeq = append(
      'system/message',
      {
        turn,
        step,
        message: {
          role: 'system',
          id: crypto.randomUUID(),
          source: { kind: 'system-prompt' },
          content: [{ type: 'text', text: headText }],
        },
      },
      true,
    );
    return headSeq;
  };

  for (const message of messages) {
    const time = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(message.timestamp);
    if (Number.isFinite(time)) clock = Math.max(clock, time);

    if (message.role === 'user') {
      closeTurn();
      openTurn();
      openStep();
      emitHead();
      const seq = append(
        'user/message',
        { role: 'user', id: crypto.randomUUID(), source: { kind: 'user' }, content: [{ type: 'text', text: message.text }] },
        true,
      );
      if (firstUserSeq === undefined) firstUserSeq = seq;
      continue;
    }

    // Assistant reply: the first one joins the turn's opening step, later ones open
    // their own step so every model turn stays reconstructable.
    if (!turnOpen) openTurn();
    if (!stepOpen) openStep();
    else if (stepHasAssistant) {
      closeStep();
      openStep();
    }
    emitHead();
    append(
      'assistant/message',
      {
        turn,
        step,
        stream: [],
        message: {
          id: crypto.randomUUID(),
          role: 'assistant',
          source: { kind: 'model', provider: source, model: 'external-history' },
          content: [{ type: 'text', text: message.text }],
        },
      },
      true,
    );
    stepHasAssistant = true;
  }
  closeTurn();

  // A non-user title must cite at least one message sequence; without an anchor the
  // event is omitted and DSH derives the title from the history instead.
  if (firstUserSeq !== undefined) {
    append('session/title', {
      title: conversation.title || TITLE_FALLBACK,
      messageSeqs: [firstUserSeq],
      source: { kind: 'fallback' },
    });
  }
  return events;
}
