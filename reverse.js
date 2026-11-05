// Reverse sync: append the turns that only exist in a DSH session back into the Codex
// conversation that was imported ("fork" -> "main").
//
// Safety rules this module keeps:
//  - Codex rollout files are append-only. Nothing is rewritten or reordered.
//  - A turn is only written when the conversation still has a rollout file on disk; a
//    thread that exists only in Codex's index cannot be recovered by writing a new file.
//  - Every append is preceded by a byte copy of the target file and followed by a
//    re-read that must show the new messages.
//  - Dry run is the default: it returns the exact records that would be appended.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import zlib from 'node:zlib';
import { codexFilesForThread } from './readers.js';

const BACKUP_SUFFIX = '.reverse-sync-backup';

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((part) => part && (part.type === 'text' || part.type === 'output_text' || part.type === 'input_text'))
    .map((part) => part.text || '')
    .join('');

// DSH stores runtime context as user/message events: workspace reminders, the runtime
// snapshot, the skill catalog and the turn timestamp. They are not something the user
// said, so they must never be written back into another tool's history.
const INJECTED_HEAD = /^(<system-reminder|Current runtime context\.|Time sampled while preparing|<environment_context|<user_instructions)/;

export function cleanUserText(text) {
  let value = String(text || '');
  const cut = value.indexOf('<system-reminder');
  if (cut > 0) value = value.slice(0, cut);
  if (INJECTED_HEAD.test(value.trimStart())) return '';
  return value.trim();
}

/** Ordered visible messages of a DSH session, each tagged with the turn it belongs to. */
export function sessionMessages(events) {
  const messages = [];
  let turn = 0;
  for (const event of events) {
    if (event.type === 'turn/start') {
      turn = event.data?.turn ?? turn + 1;
      continue;
    }
    if (event.type === 'user/message') {
      const text = cleanUserText(textOf(event.data?.content));
      if (text) messages.push({ role: 'user', text, time: event.time, turn });
      continue;
    }
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content).trim();
      if (text) messages.push({ role: 'assistant', text, time: event.time, turn });
    }
  }
  return messages;
}

/** Group messages into writable turns: user message plus the assistant replies that follow it. */
export function pendingTurns(messages, importedCount) {
  const pending = messages.slice(Math.max(0, importedCount));
  const turns = [];
  for (const message of pending) {
    if (message.role === 'user') {
      turns.push({ user: message, assistants: [] });
      continue;
    }
    if (!turns.length) {
      // An assistant message with no preceding user message cannot start a Codex turn.
      continue;
    }
    turns.at(-1).assistants.push(message);
  }
  return turns.filter((turn) => turn.assistants.length);
}

export function readRolloutFacts(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((line) => line.trim());
  let threadId = null;
  let modelContextWindow = 258400;
  let lastOrdinal = -1;
  let lastTimestamp = null;
  let contextTemplate = null;
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type === 'session_meta') {
      threadId = record.payload?.session_id || record.payload?.id || null;
      modelContextWindow = record.payload?.context_window || modelContextWindow;
    }
    if (record.payload?.type === 'task_started' && record.payload.model_context_window) {
      modelContextWindow = record.payload.model_context_window;
    }
    // Codex writes one turn_context per turn; reuse the previous one so an appended turn
    // carries the same model, cwd and sandbox policy instead of looking foreign.
    if (record.type === 'turn_context' && record.payload) contextTemplate = record.payload;
    if (Number.isInteger(record.ordinal)) lastOrdinal = Math.max(lastOrdinal, record.ordinal);
    if (record.timestamp) lastTimestamp = record.timestamp;
  }
  return { threadId, modelContextWindow, lastOrdinal, lastTimestamp, contextTemplate, recordCount: lines.length };
}

/** Build the Codex records for one DSH turn, mirroring what Codex itself writes. */
export function turnRecords({ threadId, turn, ordinal, modelContextWindow, contextTemplate }) {
  const startedMs = Number(turn.user.time) || Date.now();
  const completedMs = Number(turn.assistants.at(-1)?.time) || startedMs;
  const turnId = crypto.randomUUID();
  const userId = 'msg_' + crypto.randomUUID();
  const assistantId = 'msg_' + crypto.randomUUID();
  const assistantText = turn.assistants.map((message) => message.text).join('\n\n');
  const records = [];
  const push = (type, payload, metadata) => {
    const record = { timestamp: new Date(startedMs + records.length).toISOString(), ordinal: ordinal + records.length, type, payload };
    if (metadata !== undefined) record.metadata = metadata;
    records.push(record);
  };

  push('event_msg', {
    type: 'task_started',
    turn_id: turnId,
    root_turn_id: turnId,
    started_at: Math.floor(startedMs / 1000),
    model_context_window: modelContextWindow,
    collaboration_mode_kind: 'default',
  });
  if (contextTemplate) {
    push('turn_context', { ...contextTemplate, turn_id: turnId, root_turn_id: turnId });
  }
  push(
    'response_item',
    {
      type: 'message',
      id: userId,
      role: 'user',
      content: [{ type: 'input_text', text: turn.user.text }],
      internal_chat_message_metadata_passthrough: {
        turn_id: turnId,
        create_time: startedMs / 1000,
        content_item_kinds: ['user.text'],
      },
    },
    { client_authored: false, user_input_order: 0, mcp_attribution: { status: 'attribution_error' } },
  );
  push('event_msg', {
    type: 'item_completed',
    thread_id: threadId,
    turn_id: turnId,
    item: {
      type: 'UserMessage',
      id: 'item_' + crypto.randomUUID(),
      client_id: crypto.randomUUID(),
      content: [{ type: 'text', text: turn.user.text, text_elements: [] }],
    },
    started_at_ms: startedMs,
    completed_at_ms: startedMs,
  });
  push(
    'response_item',
    {
      type: 'message',
      id: assistantId,
      role: 'assistant',
      content: [{ type: 'output_text', text: assistantText }],
    },
    { client_authored: true, user_input_order: 0 },
  );
  push('event_msg', {
    type: 'item_completed',
    thread_id: threadId,
    turn_id: turnId,
    item: { type: 'AgentMessage', id: assistantId, content: [{ type: 'Text', text: assistantText }] },
    started_at_ms: completedMs,
    completed_at_ms: completedMs,
  });
  push('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: assistantText });
  return records;
}

export function targetRollout(threadId) {
  let files = [];
  try { files = codexFilesForThread(threadId) || []; } catch { files = []; }
  const existing = files.filter((file) => fs.existsSync(file));
  if (!existing.length) return null;
  const withStats = existing.map((file) => ({ file, stat: fs.statSync(file) }));
  withStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return withStats[0].file;
}

/** Describe what a reverse sync would do for one imported session. */
export function planReverse({ sessionId, events, entry }) {
  const messages = sessionMessages(events);
  const importedCount = Number(entry?.messages) || 0;
  const alreadyReversed = Number(entry?.reverseThrough) || 0;
  const turns = pendingTurns(messages, importedCount + alreadyReversed);
  // An imported mapping is keyed `source:externalId`; the thread id is the external id.
  const key = String(entry?.key || '');
  const threadId = entry?.externalId || (key ? key.slice(key.indexOf(':') + 1) : null);
  const target = threadId ? targetRollout(threadId) : null;
  return { sessionId, messages: messages.length, importedCount, alreadyReversed, turns, threadId, target };
}

export function appendTurns(target, records) {
  const backup = `${target}${BACKUP_SUFFIX}-${Date.now()}`;
  fs.copyFileSync(target, backup);
  const text = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  fs.appendFileSync(target, text, 'utf8');
  // Re-read the tail so a malformed write is caught immediately.
  const tail = fs.readFileSync(target, 'utf8').split('\n').filter((line) => line.trim());
  const parsed = tail.slice(-records.length).map((line) => JSON.parse(line));
  const ok = parsed.length === records.length && parsed.every((record, index) => record.ordinal === records[index].ordinal);
  return { backup, appended: records.length, verified: ok };
}
/* ------------------------------------------------------------------ *
 * Fork resolution: DSH "fork conversation" copies an imported session  *
 * into a new session whose header names `parentSession`. The copy is    *
 * the seeded prefix, so the fork's own turns are everything after the   *
 * parent's messages. The Codex thread to write back to is the one the   *
 * imported ancestor was mapped to.                                      *
 * ------------------------------------------------------------------ */
const SESSIONS_ROOT = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');

export function sessionLogFile(sessionId) {
  let slugs = [];
  try {
    slugs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const dir = path.join(SESSIONS_ROOT, slug.name, sessionId);
    if (!fs.existsSync(dir)) continue;
    for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd', 'session.jsonl']) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

/** First record of a session log, decoded from the first zstd frame when needed. */
export function readSessionHeader(sessionId) {
  const file = sessionLogFile(sessionId);
  if (!file) return null;
  const buf = fs.readFileSync(file);
  let text;
  if (file.endsWith('.zstd')) {
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    const frames = [];
    for (let i = 0; i + 3 < buf.length; i++) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) frames.push(i);
    }
    frames.push(buf.length);
    const chunks = [];
    for (let f = 0; f + 1 < frames.length; f++) {
      const slice = buf.subarray(frames[f], frames[f + 1]);
      if (slice.length < 8) continue;
      try { chunks.push(zlib.zstdDecompressSync(slice).toString('utf8')); } catch { continue; }
      if (chunks.join('').includes('\n')) break;
    }
    text = chunks.join('');
  } else {
    text = buf.toString('utf8');
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.type === 'session') return { file, header: record };
    } catch {
      continue;
    }
  }
  return { file, header: null };
}

/** `sessionMessages` comparison used to prove a fork prefix really copies its parent. */
export function prefixMatches(child, parent) {
  if (parent.length > child.length) return false;
  return parent.every((message, index) => child[index] && child[index].role === message.role && child[index].text === message.text);
}
/* ------------------------------------------------------------------ *
 * Export mode: a session with no external origin (or a fork whose      *
 * ancestor was never imported) has no "main" to append to, so the      *
 * whole conversation becomes a new Codex thread.                       *
 * ------------------------------------------------------------------ */
export function newRolloutPath(threadId, startedAtMs = Date.now()) {
  const date = new Date(startedAtMs);
  const pad = (value) => String(value).padStart(2, '0');
  const dir = path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    'sessions',
    String(date.getFullYear()),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  );
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return path.join(dir, `rollout-${stamp}-${threadId}.jsonl`);
}

/** session_meta plus one record sequence per turn, in Codex's own shape. */
export function exportRecords({ threadId, cwd, startedAtMs, turns, contextTemplate, modelContextWindow }) {
  const records = [];
  const header = {
    timestamp: new Date(startedAtMs).toISOString(),
    ordinal: 0,
    type: 'session_meta',
    payload: {
      session_id: threadId,
      id: threadId,
      timestamp: new Date(startedAtMs).toISOString(),
      cwd,
      runtime_workspace_roots: [cwd],
      originator: 'Codex Desktop',
      cli_version: '0.166.0',
      source: 'vscode',
      thread_source: 'user',
      model_provider: 'custom',
      history_mode: 'full',
      context_window: modelContextWindow || 475000,
    },
  };
  records.push(header);
  for (const turn of turns) {
    records.push(
      ...turnRecords({
        threadId,
        turn,
        ordinal: records.length,
        modelContextWindow: modelContextWindow || 475000,
        contextTemplate,
      }),
    );
  }
  return records;
}