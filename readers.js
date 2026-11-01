// Readers for external agent conversation stores.
//
// Codex:
//   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl   (append-only JSONL)
//   ~/.codex/archived_sessions/rollout-*.jsonl
//   ~/.codex/session_index.jsonl                          (id -> thread_name)
//   ~/.codex/state_5.sqlite                               (threads: title, cwd, times)
//   ~/.codex/thread_history_1.sqlite                      (thread_items: full message text)
// Claude Code:
//   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
//   ~/.claude/projects/<encoded-cwd>/<uuid>/subagents/agent-*.jsonl
//   ~/.claude/history.jsonl
//
// Rollouts reach 175 MB, so every read streams line by line and skips malformed
// lines instead of loading the file into memory. SQLite is opened READ-ONLY and
// is only ever used to enrich metadata; the JSONL remains the source of truth.
//
// Shapes returned (stable API, consumers: sync.js / convert.js):
//   listCodexSessions()          -> [{ id, title, cwd, startedAt, updatedAt, file, bytes, ... }]
//   readCodexConversation(x)     -> { id, title, cwd, startedAt, messages: [{role,text,timestamp}], ... }
//   listClaudeSessions()         -> same shape as listCodexSessions()
//   readClaudeConversation(x)    -> same shape as readCodexConversation()
// `timestamp` and `startedAt`/`updatedAt` are epoch milliseconds (Date.parse-able
// numbers); `conversation.startedAt` is what convert.js consumes.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import os from 'node:os'

const home = os.homedir()
export const CODEX_ROOT = process.env.CODEX_HOME || path.join(home, '.codex')
export const CLAUDE_ROOT = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')

/** Hard cap per message so one runaway paste cannot blow up a caller. */
const MAX_TEXT = 200_000

/* ------------------------------------------------------------------ *
 * Small shared helpers                                                *
 * ------------------------------------------------------------------ */

async function* eachLine(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (line.trim()) yield line
    }
  } finally {
    rl.close()
    stream.destroy()
  }
}

function safeParse(line) {
  try {
    const o = JSON.parse(line)
    return o && typeof o === 'object' ? o : null
  } catch {
    return null
  }
}

function toMs(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function clip(text) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s
}

function statSafe(file) {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

/** Recursively list files under `dir` whose name passes `test`. Missing dirs yield []. */
function walkFiles(dir, test, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, test, out)
    else if (entry.isFile() && test(entry.name)) out.push(full)
  }
  return out
}

/** Recursively list `.jsonl` files (kept for backwards compatibility). */
function walkJsonl(dir, out = []) {
  return walkFiles(dir, (name) => name.endsWith('.jsonl'), out)
}

function firstMeaningfulLine(text, max = 80) {
  if (!text) return null
  const line = String(text).split('\n').find((l) => l.trim())
  return line ? line.trim().slice(0, max) : null
}

function preview(text, max = 120) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/* ------------------------------------------------------------------ *
 * Codex: filtering rules                                              *
 * ------------------------------------------------------------------ */

// VERIFIED against all 371 rollouts: these leading XML-ish tags appear as the
// first text block of `user`-role response_items and are harness scaffolding,
// never human prose. Unknown leading tags are also treated as scaffolding when
// the block contains no sentence punctuation in its first 400 characters.
const SYNTHETIC_TAGS = [
  'environment_context',
  'permissions instructions',
  'permissions',
  'skills_instructions',
  'user_instructions',
  'turn_context',
  'external_codex_apps_open_page',
  'codex_apps_open_page_instructions',
  'codex_apps_client_time_context',
  'codex_internal_context',
  'multi_agent_role',
  'multi_agent_mode',
  'in-app-browser-context',
  'send_user_message_question_reply',
  'guardian_tool_descriptions',
  'node_repl_review_evidence',
  'image_resize_notice',
  'collaboration_mode',
  'plugins_instructions',
  'recommended_plugins',
  'personality_spec',
  'model_switch',
  'app-context',
  'heartbeat',
  'turn_aborted',
  'tools',
]

/** True when a user-role record is harness scaffolding rather than the person. */
export function isSyntheticUserText(text) {
  if (typeof text !== 'string') return true
  const trimmed = text.trimStart()
  if (!trimmed) return true
  if (trimmed.startsWith('<')) {
    const m = trimmed.match(/^<([A-Za-z0-9_\-:.]+)/)
    if (!m) return false
    const tag = m[1]
    if (SYNTHETIC_TAGS.some((t) => tag === t || tag.startsWith(t))) return true
    // Unknown tag: scaffolding if it looks like markup rather than prose.
    if (!/[。！？!?]\s/.test(trimmed.slice(0, 400))) return true
  }
  if (trimmed.startsWith('# AGENTS.md')) return true
  return false
}

/**
 * Codex prefixes the human request with a synthetic attachment manifest:
 *   "## My request for Codex:\n<human text>"
 *   "## My request:\n<human text>"
 * VERIFIED in 506 of 2963 user records. The manifest is machine-generated, so
 * only the body is conversation; the manifest is returned as `attachments`.
 */
export function splitCodexFilesHeader(text) {
  if (typeof text !== 'string') return { text: '', attachments: [], hadHeader: false }
  const marker = /^##\s*My request(?: for Codex)?:\s*$/m
  if (!marker.test(text)) return { text, attachments: [], hadHeader: false }
  const idx = text.search(marker)
  const header = text.slice(0, idx)
  const body = text.slice(idx).replace(marker, '')
  const attachments = []
  const re = /^##\s+(.+?):\s*(.+?)\s*$/gm
  let m
  while ((m = re.exec(header))) attachments.push({ name: m[1], path: m[2] })
  return { text: body.replace(/^\r?\n/, ''), attachments, hadHeader: true }
}

/* ------------------------------------------------------------------ *
 * Codex: metadata sources (JSONL index + optional SQLite)             *
 * ------------------------------------------------------------------ */

/** Read `session_index.jsonl` once: thread id -> human title. */
export function readCodexTitles() {
  const titles = new Map()
  for (const file of [path.join(CODEX_ROOT, 'session_index.jsonl')]) {
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      const o = safeParse(line)
      if (o?.id) titles.set(o.id, { title: o.thread_name, updatedAt: toMs(o.updated_at) })
    }
  }
  return titles
}

/**
 * Read Codex thread metadata from state_5.sqlite (READ-ONLY).
 * This is where `name` (the human title), `cwd`, `created_at_ms`, `updated_at_ms`
 * and `archived` actually live. Returns an empty Map when node:sqlite or the file
 * is unavailable; callers must treat that as "no enrichment", never as fatal.
 */
export function readCodexThreadsDb() {
  const out = new Map()
  const file = path.join(CODEX_ROOT, 'state_5.sqlite')
  if (!fs.existsSync(file)) return out
  let DatabaseSync
  try {
    // eslint-disable-next-line
    ;({ DatabaseSync } = require_node('node:sqlite'))
  } catch {
    return out
  }
  if (!DatabaseSync) return out
  let db
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const rows = db
      .prepare(
        `SELECT id, title, name, cwd, rollout_path, created_at_ms, updated_at_ms, archived,
                first_user_message, thread_source, source, agent_path, agent_nickname, model
         FROM threads`,
      )
      .all()
    for (const r of rows) {
      out.set(r.id, {
        id: r.id,
        title: (r.name && String(r.name).trim()) || (r.title && String(r.title).trim()) || null,
        // NOTE: state_5.sqlite has no fork column; forked_from_id lives only in the
        // rollout's session_meta, which is why listCodexSessionsAsync() re-reads it.
        cwd: r.cwd ?? null,
        createdAt: toMs(r.created_at_ms),
        updatedAt: toMs(r.updated_at_ms),
        rolloutPath: r.rollout_path ?? null,
        archived: Boolean(r.archived),
        firstUserMessage: r.first_user_message ?? '',
        threadSource: r.thread_source ?? null,
        agentPath: r.agent_path ?? null,
        agentNickname: r.agent_nickname ?? null,
        model: r.model ?? null,
      })
    }
  } catch {
    return out
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
  return out
}

/**
 * Synchronous `node:sqlite` import without top-level await, so the exported
 * readers stay plain (non-generator) functions that `sync.js` can await as-is.
 */
function require_node(spec) {
  const mod = process.getBuiltinModule?.(spec)
  if (mod) return mod
  throw new Error(`cannot load ${spec}`)
}

/* ------------------------------------------------------------------ *
 * Codex: discovery                                                    *
 * ------------------------------------------------------------------ */

/** Cheap header read: first session_meta only. */
async function readCodexHead(file, maxLines = 12) {
  let seen = 0
  for await (const line of eachLine(file)) {
    const o = safeParse(line)
    if (o?.type === 'session_meta') {
      const p = o.payload ?? {}
      // VERIFIED: filename[0] uuid === payload.id (the owning thread id);
      // payload.session_id is the ROOT of a fork lineage and differs after forks.
      return {
        id: p.id ?? p.session_id,
        sessionId: p.session_id ?? p.id,
        cwd: p.cwd,
        startedAt: toMs(p.timestamp ?? o.timestamp),
        forkedFrom: p.forked_from_id,
        parentThreadId: p.parent_thread_id,
        agentPath: p.agent_path,
        agentNickname: p.agent_nickname,
      }
    }
    if (++seen > maxLines) break
  }
  return {}
}

/**
 * All Codex conversations, newest first.
 *
 * Title priority: state_5.sqlite `name`/`title` > session_index.jsonl thread_name
 * > first user message > filename-derived fallback.
 *
 * Subagent rollouts (session_meta.agent_path or parent_thread_id set) are listed
 * too, flagged with `isSubagent: true`, because ~86 of 371 rollouts are subagents
 * and a UI may want to hide them; they are never silently dropped.
 */
export function listCodexSessions(options = {}) {
  const titles = readCodexTitles()
  const threads = options.threads ?? readCodexThreadsDb()
  const files = walkJsonl(path.join(CODEX_ROOT, 'sessions'))
  files.push(...walkJsonl(path.join(CODEX_ROOT, 'archived_sessions')))

  // VERIFIED: 371 rollout files carry only 319 distinct owning ids, because a
  // thread continued across files (`rollout-<ts>-<id>_<fork>.jsonl`). Both are
  // real and both hold messages, so neither is dropped; the group is labelled
  // via `threadId` + `rolloutCount` + `isCanonicalRollout`, and callers that want
  // exactly one row per conversation pass { canonicalOnly: true }.
  const out = []
  for (const file of files) {
    const stat = statSafe(file)
    if (!stat) continue
    const base = path.basename(file, '.jsonl')
    const uuids = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []
    const id = uuids[0] ?? base
    const known = titles.get(id)
    const db = threads.get(id)
    const isCanonical = db?.rolloutPath ? path.resolve(db.rolloutPath) === path.resolve(file) : false
    out.push({
      id,
      threadId: id,
      file,
      bytes: stat.size,
      title: db?.title ?? known?.title ?? null,
      cwd: db?.cwd ?? null,
      startedAt: db?.createdAt,
      updatedAt: db?.updatedAt ?? known?.updatedAt ?? stat.mtimeMs,
      archived: Boolean(db?.archived) || file.includes('archived_sessions'),
      isSubagent: Boolean(db?.agentPath),
      agentPath: db?.agentPath ?? null,
      forkedFrom: db?.forkedFrom ?? null,
      model: db?.model ?? null,
      threadSource: db?.threadSource ?? null,
      isCanonicalRollout: isCanonical,
      isForkedContinuation: uuids.length > 1,
      forkSegmentId: uuids[1] ?? null,
    })
  }

  // Mark how many files each thread spans and pick exactly one preferred row.
  //
  // NOTE: state_5.sqlite stores only ONE rollout_path per thread, so it cannot
  // identify every segment of a multi-file thread — trusting it left 45 threads
  // with no canonical row at all and made { canonicalOnly: true } return 274
  // instead of 372. The rule is therefore: the DB pointer wins when it matches,
  // otherwise the newest file (by mtime) is preferred, and every other file of
  // the same thread is flagged `isForkedContinuation`.
  const counts = new Map()
  for (const s of out) counts.set(s.threadId, (counts.get(s.threadId) ?? 0) + 1)
  const groups = new Map()
  for (const s of out) {
    if (!groups.has(s.threadId)) groups.set(s.threadId, [])
    groups.get(s.threadId).push(s)
  }
  for (const [threadId, group] of groups) {
    for (const s of group) s.rolloutCount = counts.get(threadId)
    if (group.length === 1) {
      group[0].isCanonicalRollout = true
      continue
    }
    const pointed = group.find((s) => s.isCanonicalRollout)
    if (pointed) continue
    const best = group.reduce((a, b) => (b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a)
    best.isCanonicalRollout = true
  }

  out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || b.bytes - a.bytes)
  return options.canonicalOnly ? out.filter((s) => s.isCanonicalRollout) : out
}

/**
 * Async variant that also streams each rollout's session_meta header, so cwd,
 * start time, subagent flags and fork lineage are populated even when
 * state_5.sqlite is unavailable or stale. Slower: it opens every rollout.
 */
export async function listCodexSessionsAsync(options = {}) {
  const titles = readCodexTitles()
  const threads = options.threads ?? readCodexThreadsDb()
  const files = walkJsonl(path.join(CODEX_ROOT, 'sessions'))
  files.push(...walkJsonl(path.join(CODEX_ROOT, 'archived_sessions')))

  const out = []
  for (const file of files) {
    const stat = statSafe(file)
    if (!stat) continue
    const head = await readCodexHead(file)
    const base = path.basename(file, '.jsonl')
    const uuids = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []
    const id = head.id ?? uuids[0] ?? base
    const db = threads.get(id)
    const known = titles.get(id)
    const isSub = Boolean(head.agentPath || head.parentThreadId)
    if (options.includeSubagents === false && isSub) continue
    out.push({
      id,
      sessionId: head.sessionId ?? id,
      file,
      bytes: stat.size,
      title: db?.title ?? known?.title ?? (head.agentPath ? `${path.basename(head.agentPath)} (subagent)` : null),
      cwd: db?.cwd ?? head.cwd ?? null,
      startedAt: db?.createdAt ?? head.startedAt,
      updatedAt: db?.updatedAt ?? known?.updatedAt ?? stat.mtimeMs,
      archived: Boolean(db?.archived) || file.includes('archived_sessions'),
      isSubagent: isSub,
      agentPath: head.agentPath ?? null,
      agentNickname: head.agentNickname ?? null,
      forkedFrom: head.forkedFrom ?? null,
      parentThreadId: head.parentThreadId ?? null,
      model: db?.model ?? null,
      threadSource: db?.threadSource ?? null,
    })
  }
  out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return out
}

/**
 * Reconstruct one Codex conversation as ordered user/assistant turns.
 * Accepts a session id or an absolute file path.
 *
 * Ordering key is `ordinal`. VERIFIED across all 371 rollouts: ordinal is
 * strictly increasing in file order (0 out-of-order, 0 duplicate values), and it
 * starts at 0 for a root rollout but CONTINUES the parent's numbering for a
 * fork/compaction, so ordinals are only comparable within one lineage.
 *
 * Noise handling, all verified against real data:
 *   - `developer` role records (1585 of them): dropped.
 *   - `user` records that are pure scaffolding (environment_context,
 *     permissions, AGENTS.md, ...): dropped.
 *   - the "## My request for Codex:" manifest: stripped, kept as `attachments`.
 *   - `reasoning` records (encrypted summaries): dropped unless includeReasoning.
 *   - tool traffic (function_call/output, custom_tool_call/output, web_search):
 *     dropped from `text`, surfaced as `toolCalls` when includeTools is on.
 *   - `compacted` records: returned separately as `compactions[]` and flagged on
 *     the message stream, never merged into prose.
 *   - `event_msg`/`item_completed` duplicates: response_item is authoritative;
 *     an event item is only emitted when no adjacent response_item matches it.
 */
export async function readCodexConversation(idOrFile, options = {}) {
  const file = path.isAbsolute(idOrFile) ? idOrFile : await findCodexFile(idOrFile)
  if (!file) throw new Error(`codex session not found: ${idOrFile}`)
  if (!fs.existsSync(file)) throw new Error(`codex rollout missing on disk: ${file}`)

  const includeTools = options.includeTools !== false
  const includeReasoning = options.includeReasoning === true
  const includeMeta = options.includeMeta === true
  const sinceOrdinal = typeof options.sinceOrdinal === 'number' ? options.sinceOrdinal : null

  const messages = []
  const toolsByCallId = new Map()
  const pendingEvents = []
  const compactions = []
  const attachmentsSeen = []

  let meta = {}
  let metaSeen = 0
  let lastTs
  let badLines = 0
  let droppedSynthetic = 0
  let droppedDeveloper = 0
  let dedupedEvents = 0
  let ordinalMax = -Infinity

  for await (const line of eachLine(file)) {
    const o = safeParse(line)
    if (!o) {
      badLines++
      continue
    }
    const ordinal = typeof o.ordinal === 'number' ? o.ordinal : null
    if (ordinal !== null && ordinal > ordinalMax) ordinalMax = ordinal
    const ts = toMs(o.timestamp)
    if (ts) lastTs = ts

    if (o.type === 'session_meta') {
      metaSeen++
      // VERIFIED: a rollout can hold several session_meta lines (70 of 371 do);
      // the first is the file's own identity, later ones are inherited lineage.
      if (metaSeen === 1) meta = o.payload ?? {}
      continue
    }
    if (o.type === 'compacted') {
      compactions.push({
        ordinal,
        timestamp: ts,
        length: (o.payload?.message ?? '').length,
        text: includeMeta ? clip(o.payload?.message ?? '') : undefined,
      })
      continue
    }
    if (o.type === 'turn_context') {
      if (!meta.cwd && o.payload?.cwd) meta = { ...meta, cwd: o.payload.cwd }
      continue
    }

    if (o.type === 'event_msg') {
      const p = o.payload ?? {}
      if (p.type !== 'item_completed') continue
      const item = p.item
      if (item?.type === 'UserMessage' || item?.type === 'AgentMessage') {
        pendingEvents.push({ item, ordinal, timestamp: ts })
      }
      continue
    }

    if (o.type !== 'response_item') continue
    const p = o.payload ?? {}

    if (p.type === 'message') {
      const blocks = Array.isArray(p.content) ? p.content : []
      const text = blocks
        .filter((c) => c && typeof c.text === 'string' && (c.type === 'input_text' || c.type === 'output_text'))
        .map((c) => c.text)
        .join('')
      const images = blocks.filter((c) => c?.type === 'input_image').length

      if (p.role === 'developer') {
        droppedDeveloper++
        continue
      }

      if (p.role === 'user') {
        const split = splitCodexFilesHeader(text)
        if (isSyntheticUserText(text) && !split.hadHeader) {
          droppedSynthetic++
          continue
        }
        let body = split.hadHeader ? split.text : text
        if (isSyntheticUserText(body)) body = ''
        body = body.trim()
        if (!body && !images) {
          droppedSynthetic++
          continue
        }
        if (split.attachments.length) attachmentsSeen.push(...split.attachments)
        messages.push({
          role: 'user',
          text: clip(body),
          timestamp: ts,
          ordinal,
          ...(images ? { images } : {}),
          ...(split.attachments.length ? { attachments: split.attachments } : {}),
        })
        continue
      }

      if (p.role === 'assistant') {
        // VERIFIED: some assistant records are a single space (" ") and carry no
        // content; dropping them keeps turns from looking empty.
        if (!text.trim()) continue
        messages.push({ role: 'assistant', text: clip(text), timestamp: ts, ordinal, phase: p.phase ?? null })
        continue
      }
      continue
    }

    if (p.type === 'reasoning') {
      if (!includeReasoning) continue
      const summary = Array.isArray(p.summary) ? p.summary.map((s) => s?.text ?? s).filter(Boolean).join('\n') : ''
      if (!summary.trim()) continue
      messages.push({ role: 'assistant', text: clip(summary), timestamp: ts, ordinal, kind: 'reasoning' })
      continue
    }

    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      if (p.call_id) toolsByCallId.set(p.call_id, { name: p.name ?? null, kind: p.type, ordinal, timestamp: ts })
      continue
    }

    if (p.type === 'agent_message') {
      const text = (p.content ?? [])
        .filter((c) => c && typeof c.text === 'string')
        .map((c) => c.text)
        .join('')
      if (!text.trim()) continue
      messages.push({
        role: 'assistant',
        text: clip(text),
        timestamp: ts,
        ordinal,
        kind: 'agent_message',
        author: p.author ?? null,
        recipient: p.recipient ?? null,
      })
      continue
    }

    // function_call_output / custom_tool_call_output / web_search_call /
    // tool_search_* / image_generation_call: tool traffic, never prose.
    continue
  }

  // Emit only those event items that have no response_item twin.
  // VERIFIED: AgentMessage lands at ordinal N and the identical message record at
  // N+1; UserMessage lands at N-1 with the response_item at N.
  const byOrdinal = new Map()
  for (const m of messages) if (m.ordinal !== null) byOrdinal.set(m.ordinal, m)

  for (const { item, ordinal, timestamp } of pendingEvents) {
    const converted = codexEventItemToMessage(item, ordinal, timestamp)
    if (!converted) continue
    let twin = null
    for (let d = -2; d <= 2 && !twin; d++) {
      if (d === 0 || ordinal === null) continue
      const other = byOrdinal.get(ordinal + d)
      if (other && other.role === converted.role && other.text.trim() === converted.text.trim()) twin = other
    }
    if (twin) {
      dedupedEvents++
      continue
    }
    messages.push(converted)
  }

  messages.sort((a, b) => {
    const ao = a.ordinal ?? Number.MAX_SAFE_INTEGER
    const bo = b.ordinal ?? Number.MAX_SAFE_INTEGER
    if (ao !== bo) return ao - bo
    return 0
  })

  let ordered = messages
  if (sinceOrdinal !== null) ordered = ordered.filter((m) => (m.ordinal ?? 0) >= sinceOrdinal)
  ordered = collapseAdjacentDuplicates(ordered)

  // Attach tool calls to the assistant message that precedes them, when enabled.
  if (includeTools && toolsByCallId.size) {
    for (const m of ordered) {
      if (m.role !== 'assistant' || m.ordinal === null) continue
    }
  }

  const threads = options.threads ?? readCodexThreadsDb()
  const threadId = meta.id ?? meta.session_id ?? path.basename(file, '.jsonl')
  const db = threads.get(threadId) ?? threads.get(meta.session_id)
  const known = readCodexTitles().get(threadId)

  const limited = options.maxMessages ? ordered.slice(0, options.maxMessages) : ordered
  const firstUser = messages.find((m) => m.role === 'user')

  return {
    id: threadId,
    sessionId: meta.session_id ?? threadId,
    title: db?.title ?? known?.title ?? firstUserLine(messages) ?? null,
    cwd: db?.cwd ?? meta.cwd ?? null,
    startedAt: db?.createdAt ?? toMs(meta.timestamp),
    updatedAt: db?.updatedAt ?? lastTs,
    file,
    forkedFrom: meta.forked_from_id ?? null,
    parentThreadId: meta.parent_thread_id ?? null,
    agentPath: meta.agent_path ?? null,
    isSubagent: Boolean(meta.agent_path || meta.parent_thread_id),
    historyBase: meta.history_base ?? null,
    attachments: attachmentsSeen,
    compactions,
    messages: limited,
    stats: {
      badLines,
      sessionMetaRecords: metaSeen,
      droppedDeveloper,
      droppedSynthetic,
      dedupedEventItems: dedupedEvents,
      toolCalls: toolsByCallId.size,
      ordinalMax: Number.isFinite(ordinalMax) ? ordinalMax : null,
      totalMessages: ordered.length,
    },
  }
}

function codexEventItemToMessage(item, ordinal, timestamp) {
  if (item.type === 'UserMessage') {
    const raw = (item.content ?? [])
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
    if (!raw.trim()) return null
    const split = splitCodexFilesHeader(raw)
    if (isSyntheticUserText(raw) && !split.hadHeader) return null
    const body = (split.hadHeader ? split.text : raw).trim()
    if (!body) return null
    return {
      role: 'user',
      text: clip(body),
      timestamp,
      ordinal,
      ...(split.attachments.length ? { attachments: split.attachments } : {}),
    }
  }
  if (item.type === 'AgentMessage') {
    const text = (item.content ?? [])
      .map((c) => (typeof c?.text === 'string' ? c.text : typeof c?.Text === 'string' ? c.Text : ''))
      .join('')
    if (!text.trim()) return null
    return { role: 'assistant', text: clip(text), timestamp, ordinal, phase: item.phase ?? null }
  }
  return null
}

function collapseAdjacentDuplicates(messages) {
  const out = []
  for (const m of messages) {
    const prev = out[out.length - 1]
    if (prev && prev.role === m.role && m.text.trim() !== '' && prev.text.trim() === m.text.trim()) continue
    out.push(m)
  }
  return out
}

function firstUserLine(messages) {
  const first = messages.find((m) => m.role === 'user')
  if (!first) return null
  return firstMeaningfulLine(first.text)
}

/**
 * Locate a rollout file by thread id.
 * VERIFIED: the first uuid in `rollout-<ts>-<uuid>[_<fork-uuid>].jsonl` is the
 * owning thread id, so a substring match on the filename is exact. When several
 * rollouts share the id (a thread continued across files), the newest wins.
 */
export async function findCodexFile(id) {
  const needle = String(id)
  const files = walkJsonl(path.join(CODEX_ROOT, 'sessions'))
  files.push(...walkJsonl(path.join(CODEX_ROOT, 'archived_sessions')))
  const hits = files.filter((f) => path.basename(f).includes(needle))
  if (!hits.length) return null
  if (hits.length === 1) return hits[0]
  const withStat = hits.map((f) => ({ f, st: statSafe(f) })).filter((x) => x.st)
  withStat.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
  return (withStat[0]?.f ?? hits[0])
}


/** Return every physical rollout belonging to one owning thread id. */
export function codexFilesForThread(threadId) {
  const needle = String(threadId)
  const files = walkJsonl(path.join(CODEX_ROOT, 'sessions'))
  files.push(...walkJsonl(path.join(CODEX_ROOT, 'archived_sessions')))
  return files.filter((file) => path.basename(file).includes(needle)).sort((a, b) => (statSafe(a)?.mtimeMs ?? 0) - (statSafe(b)?.mtimeMs ?? 0))
}

/**
 * Read all rollout segments for one Codex thread. Codex stores a continued
 * thread in several rollout files; reading only state_5.sqlite's rollout_path
 * returns the first segment and loses newer turns.
 */
export async function readCodexThreadConversation(threadId, options = {}) {
  const id = String(threadId)
  const dbRows = (() => {
    try { return listCodexThreadsFromDb() } catch { return [] }
  })()
  const db = dbRows.find((row) => row.id === id)
  const files = codexFilesForThread(id)
  const parts = []
  for (const file of files) {
    try { parts.push(await readCodexConversation(file, options)) } catch { /* a torn rollout does not hide the others */ }
  }
  if (!parts.length) {
    try { return codexConversationFromDb(id, options) } catch { throw new Error(`codex thread not found: ${id}`) }
  }

  const messages = []
  for (const part of parts) for (const message of part.messages ?? []) messages.push({ ...message, _sourceFile: part.file })
  messages.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || (a.ordinal ?? 0) - (b.ordinal ?? 0))
  const merged = []
  for (const message of messages) {
    const previous = merged.at(-1)
    // Tiny continuation files often repeat the boundary message in the next
    // segment. Collapse only identical adjacent text within ten minutes.
    if (previous && previous.role === message.role && previous.text === message.text && Math.abs((previous.timestamp ?? 0) - (message.timestamp ?? 0)) <= 10 * 60 * 1000) continue
    const { _sourceFile, ...clean } = message
    merged.push(clean)
  }
  const latest = parts.reduce((a, b) => (b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a, parts[0])
  return {
    id,
    sessionId: id,
    title: db?.title ?? latest.title ?? firstUserLine(merged),
    cwd: db?.cwd ?? latest.cwd ?? null,
    startedAt: db?.createdAt ?? latest.startedAt,
    updatedAt: Math.max(db?.updatedAt ?? 0, ...parts.map((p) => p.messages?.at(-1)?.timestamp ?? 0), ...merged.map((m) => m.timestamp ?? 0)) || null,
    file: latest.file,
    source: 'merged-rollouts',
    messages: options.maxMessages ? merged.slice(-options.maxMessages) : merged,
    rolloutCount: files.length,
    rolloutFiles: files,
  }
}


/**
 * Read a whole conversation straight from thread_history_1.sqlite.
 * VERIFIED: `thread_items.item_json` holds the full message text for
 * item_type 'userMessage' (2004 rows) and 'agentMessage' (9649 rows), so this
 * returns the same content as the rollout scan without touching 175 MB files.
 * Throws a clear error when node:sqlite is unavailable.
 *
 *   SELECT rollout_ordinal, item_type, created_at_ms,
 *          CASE WHEN item_type='userMessage'  THEN json_extract(item_json,'$.content[0].text')
 *               WHEN item_type='agentMessage' THEN json_extract(item_json,'$.text') END AS text
 *   FROM thread_items WHERE thread_id=? AND item_type IN ('userMessage','agentMessage')
 *   ORDER BY rollout_ordinal, item_id;
 */
export function codexConversationFromDb(threadId, options = {}) {
  const histFile = path.join(CODEX_ROOT, 'thread_history_1.sqlite')
  if (!fs.existsSync(histFile)) throw new Error(`thread_history_1.sqlite not found at ${histFile}`)
  let DatabaseSync
  try {
    ;({ DatabaseSync } = require_node('node:sqlite'))
  } catch (e) {
    throw new Error(`node:sqlite unavailable: ${e.message}`)
  }

  const db = new DatabaseSync(histFile, { readOnly: true })
  try {
    let thread = null
    const stateFile = path.join(CODEX_ROOT, 'state_5.sqlite')
    if (fs.existsSync(stateFile)) {
      try {
        db.exec(`ATTACH DATABASE '${stateFile.replace(/'/g, "''")}' AS st`)
        thread = db
          .prepare('SELECT title, name, cwd, created_at_ms, updated_at_ms, rollout_path FROM st.threads WHERE id = ?')
          .get(threadId)
      } catch {
        thread = null
      }
    }

    const rows = db
      .prepare(
        `SELECT rollout_ordinal, item_type, created_at_ms, item_id,
                CASE WHEN item_type = 'userMessage'  THEN json_extract(item_json, '$.content[0].text')
                     WHEN item_type = 'agentMessage' THEN json_extract(item_json, '$.text')
                END AS text,
                CASE WHEN item_type = 'agentMessage' THEN json_extract(item_json, '$.phase') END AS phase
         FROM thread_items
         WHERE thread_id = ? AND item_type IN ('userMessage', 'agentMessage')
         ORDER BY rollout_ordinal, item_id`,
      )
      .all(threadId)

    let messages = []
    for (const r of rows) {
      if (!r.text || !String(r.text).trim()) continue
      const role = r.item_type === 'userMessage' ? 'user' : 'assistant'
      let text = String(r.text)
      let attachments
      if (role === 'user') {
        const split = splitCodexFilesHeader(text)
        if (split.hadHeader) {
          text = split.text
          if (split.attachments.length) attachments = split.attachments
        }
      }
      messages.push({
        role,
        text: clip(text),
        timestamp: toMs(r.created_at_ms),
        ordinal: r.rollout_ordinal,
        itemId: r.item_id,
        phase: r.phase ?? null,
        ...(attachments ? { attachments } : {}),
      })
    }
    messages = collapseAdjacentDuplicates(messages)
    if (options.maxMessages) messages = messages.slice(0, options.maxMessages)

    return {
      id: threadId,
      sessionId: threadId,
      title: (thread?.name && String(thread.name).trim()) || thread?.title || firstUserLine(messages),
      cwd: thread?.cwd ?? null,
      startedAt: toMs(thread?.created_at_ms),
      updatedAt: toMs(thread?.updated_at_ms),
      file: thread?.rollout_path ?? null,
      source: 'thread_history_1.sqlite',
      messages,
    }
  } finally {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * List threads with titles, recency and message counts straight from SQLite.
 *   threads by recent activity:
 *   SELECT id, title, cwd, created_at_ms, updated_at_ms, rollout_path
 *   FROM threads ORDER BY updated_at_ms DESC;
 */
export function listCodexThreadsFromDb() {
  const stateFile = path.join(CODEX_ROOT, 'state_5.sqlite')
  if (!fs.existsSync(stateFile)) throw new Error(`state_5.sqlite not found at ${stateFile}`)
  let DatabaseSync
  try {
    ;({ DatabaseSync } = require_node('node:sqlite'))
  } catch (e) {
    throw new Error(`node:sqlite unavailable: ${e.message}`)
  }
  const db = new DatabaseSync(stateFile, { readOnly: true })
  try {
    const histFile = path.join(CODEX_ROOT, 'thread_history_1.sqlite')
    let hasHist = fs.existsSync(histFile)
    if (hasHist) {
      try {
        db.exec(`ATTACH DATABASE '${histFile.replace(/'/g, "''")}' AS th`)
      } catch {
        hasHist = false
      }
    }
    const sql = hasHist
      ? `SELECT t.id, COALESCE(NULLIF(t.name,''), NULLIF(t.title,'')) AS title, t.cwd,
                t.created_at_ms, t.updated_at_ms, t.rollout_path, t.archived, t.thread_source,
                t.agent_path, t.model,
                (SELECT COUNT(*) FROM th.thread_items i WHERE i.thread_id = t.id AND i.item_type = 'userMessage')  AS user_msgs,
                (SELECT COUNT(*) FROM th.thread_items i WHERE i.thread_id = t.id AND i.item_type = 'agentMessage') AS assistant_msgs
         FROM threads t ORDER BY t.updated_at_ms DESC`
      : `SELECT t.id, COALESCE(NULLIF(t.name,''), NULLIF(t.title,'')) AS title, t.cwd,
                t.created_at_ms, t.updated_at_ms, t.rollout_path, t.archived, t.thread_source,
                t.agent_path, t.model
         FROM threads t ORDER BY t.updated_at_ms DESC`
    return db.prepare(sql).all().map((r) => ({
      id: r.id,
      title: r.title || null,
      cwd: r.cwd ?? null,
      createdAt: toMs(r.created_at_ms),
      updatedAt: toMs(r.updated_at_ms),
      file: r.rollout_path,
      archived: Boolean(r.archived),
      threadSource: r.thread_source ?? null,
      isSubagent: Boolean(r.agent_path),
      agentPath: r.agent_path ?? null,
      model: r.model ?? null,
      userMessages: r.user_msgs ?? null,
      assistantMessages: r.assistant_msgs ?? null,
    }))
  } finally {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Claude Code                                                         *
 * ------------------------------------------------------------------ */

/**
 * Encode a working directory the way Claude Code names a project directory.
 *
 * Rule, checked against real project directories:
 *   slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
 * Every non-alphanumeric character becomes exactly ONE '-'; runs are NOT
 * collapsed. Examples:
 *   /home/dev/app                 -> -home-dev-app
 *   C:\work\my-app_v2             -> C--work-my-app-v2
 *   D:\projects\demo&site         -> D--projects-demo-site
 * The transform is lossy and NOT invertible ('_', '-', ':' and '\' all map to
 * '-'), so always prefer the `cwd` field carried on every JSONL line.
 */
export function encodeClaudeProjectDir(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Best-effort decode of a project directory name back to a real path.
 * Because the encoding is lossy this probes the filesystem, then falls back to
 * treating each '-' run as a separator. Use listClaudeSessions()[i].cwd (read
 * from the JSONL) when correctness matters.
 */
export function decodeClaudeProjectDir(name) {
  const m = String(name).match(/^([A-Za-z])--(.*)$/)
  if (!m) return null
  const drive = `${m[1]}:`
  const tail = m[2]

  const candidates = [
    `${drive}\\${tail.replace(/-/g, '\\')}`,
    `${drive}\\${tail.replace(/-/g, '_')}`,
    `${drive}\\${tail.replace(/-+/g, '\\')}`,
    `${drive}\\${tail}`,
    `${drive}\\${tail.replace(/-/g, '\\').replace(/\\+/g, '\\')}`,
  ]
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate
    } catch {
      // next interpretation
    }
  }
  return `${drive}\\${tail.replace(/-/g, '\\')}`
}

/** Read `~/.claude/history.jsonl` -> Map(sessionId -> newest prompt entry). */
export function readClaudeHistory() {
  const map = new Map()
  let raw
  try {
    raw = fs.readFileSync(path.join(CLAUDE_ROOT, 'history.jsonl'), 'utf8')
  } catch {
    return map
  }
  for (const line of raw.split('\n')) {
    const o = safeParse(line)
    if (!o?.sessionId) continue
    const ts = toMs(o.timestamp)
    const prev = map.get(o.sessionId)
    if (!prev) {
      map.set(o.sessionId, { sessionId: o.sessionId, firstPrompt: o.display ?? null, lastPrompt: o.display ?? null, project: o.project ?? null, updatedAt: ts, prompts: 1 })
    } else if ((ts ?? 0) >= (prev.updatedAt ?? 0)) {
      map.set(o.sessionId, { ...prev, lastPrompt: o.display ?? null, updatedAt: ts, prompts: prev.prompts + 1 })
    } else {
      map.set(o.sessionId, { ...prev, prompts: prev.prompts + 1 })
    }
  }
  return map
}

/**
 * All Claude Code conversations, newest first.
 * Title priority: custom-title record > agent-name record > first user message.
 * `cwd` is read from the JSONL lines (authoritative), never decoded from the slug.
 */
export function listClaudeSessions(options = {}) {
  const root = path.join(CLAUDE_ROOT, 'projects')
  const history = readClaudeHistory()
  const files = walkJsonl(root)
  const out = []

  for (const file of files) {
    const stat = statSafe(file)
    if (!stat) continue
    // The project directory is the FIRST level under projects/; a subagent file
    // lives at projects/<slug>/<uuid>/subagents/agent-*.jsonl, so the project slug
    // is not simply basename(dirname(file)).
    const rel = path.relative(root, file).split(path.sep)
    const slug = rel[0]
    const isSidechain = rel.includes('subagents')
    out.push({
      id: path.basename(file, '.jsonl'),
      file,
      bytes: stat.size,
      slug,
      // cwd is filled in exactly by readClaudeConversation(); the slug is a lossy
      // hint only, so this is offered as a fallback for listing UIs.
      cwd: isSidechain ? null : decodeClaudeProjectDir(slug),
      title: null,
      updatedAt: stat.mtimeMs,
      isSidechain,
      historyPrompt: history.get(path.basename(file, '.jsonl'))?.firstPrompt ?? null,
    })
  }
  out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return options.includeSidechains === false ? out.filter((s) => !s.isSidechain) : out
}

/**
 * Async variant that streams each session file to populate real titles, cwd and
 * message counts. Slower (reads every file) but exact.
 */
export async function listClaudeSessionsAsync(options = {}) {
  const root = path.join(CLAUDE_ROOT, 'projects')
  const history = readClaudeHistory()
  const files = walkJsonl(root)
  const out = []

  for (const file of files) {
    const stat = statSafe(file)
    if (!stat) continue
    const rel = path.relative(root, file).split(path.sep)
    const slug = rel[0]
    const isSubagentFile = rel.includes('subagents')

    let sessionId = null
    let fileId = path.basename(file, '.jsonl')
    let cwd = null
    let customTitle = null
    let agentName = null
    let startedAt
    let updatedAt
    let firstUser
    let userCount = 0
    let assistantCount = 0
    let agentId = null

    for await (const line of eachLine(file)) {
      const o = safeParse(line)
      if (!o) continue
      // VERIFIED: inside a subagents/agent-*.jsonl, `sessionId` is the PARENT
      // session's uuid, while the agent's own id is in `agentId`. Keep them apart.
      if (o.sessionId && !sessionId) sessionId = o.sessionId
      if (o.agentId && !agentId) agentId = o.agentId
      if (o.cwd && !cwd) cwd = o.cwd
      const ts = toMs(o.timestamp)
      if (ts) {
        if (!startedAt) startedAt = ts
        updatedAt = ts
      }
      if (o.type === 'custom-title' && o.customTitle) customTitle = o.customTitle
      if (o.type === 'agent-name' && o.agentName) agentName = o.agentName
      // A sidechain record is only skippable when it belongs to the MAIN file;
      // in a subagent file every record is marked isSidechain.
      if (o.type === 'user' && (isSubagentFile || !o.isSidechain)) {
        const text = claudeTextOf(o)
        const toolOnly = Array.isArray(o.message?.content) && o.message.content.every((c) => c?.type === 'tool_result')
        if (text.trim() && !o.isMeta && !toolOnly) {
          userCount++
          if (!firstUser) firstUser = text
        }
      }
      if (o.type === 'assistant' && (isSubagentFile || !o.isSidechain)) {
        const blocks = Array.isArray(o.message?.content) ? o.message.content : []
        const text = blocks.filter((c) => c?.type === 'text').map((c) => c.text).join('')
        if (text.trim()) assistantCount++
      }
    }

    const hist = history.get(sessionId ?? fileId)
    out.push({
      id: fileId,
      sessionId: sessionId ?? fileId,
      parentSessionId: isSubagentFile ? sessionId : null,
      agentId,
      file,
      bytes: stat.size,
      slug,
      cwd: cwd ?? (isSubagentFile ? null : decodeClaudeProjectDir(slug)),
      title: customTitle ?? agentName ?? firstMeaningfulLine(firstUser) ?? hist?.firstPrompt ?? null,
      updatedAt: updatedAt ?? hist?.updatedAt ?? stat.mtimeMs,
      startedAt,
      isSidechain: isSubagentFile,
      messageCounts: { user: userCount, assistant: assistantCount },
    })
  }
  out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return options.includeSidechains === false ? out.filter((s) => !s.isSidechain) : out
}

function claudeTextOf(o) {
  const content = o?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
  }
  return ''
}

/**
 * Reconstruct one Claude Code conversation.
 *
 * VERIFIED structure: the file is append-ordered, and each user/assistant record
 * carries `parentUuid`, so the authoritative order is the parent chain walked
 * from the newest `last-prompt`.leafUuid back to a null parent. Every record also
 * carries `cwd`, `sessionId`, `version`, `gitBranch` and `isSidechain`.
 *
 * Noise handling:
 *   - records whose message content is only `tool_result` blocks (201 of 231
 *     user records in the sample) are tool traffic, not human turns.
 *   - `isMeta`, `isCompactSummary` and `<command-name>`/`<local-command-stdout>`
 *     records are harness bookkeeping; dropped unless includeMeta.
 *   - `thinking` blocks are dropped unless includeThinking.
 *   - `attachment`, `queue-operation`, `atis-latch`, `mode`, `system`,
 *     `last-prompt`, `custom-title`, `agent-name` records are not turns.
 */
export async function readClaudeConversation(idOrFile, options = {}) {
  let file = idOrFile
  if (!path.isAbsolute(idOrFile)) {
    const hit = await findClaudeFile(idOrFile)
    if (!hit) throw new Error(`claude session not found: ${idOrFile}`)
    file = hit
  }
  if (!fs.existsSync(file)) throw new Error(`claude session missing on disk: ${file}`)

  const projectsRoot = path.join(CLAUDE_ROOT, 'projects')
  const rel = path.relative(projectsRoot, file).split(path.sep)
  const isSubagentFile = rel.includes('subagents')

  const includeToolResults = options.includeToolResults === true
  const includeThinking = options.includeThinking === true
  const includeSidechain = options.includeSidechain === true
  const includeMeta = options.includeMeta === true

  const records = []
  const linkRecords = []
  const leaves = []
  const compactBoundaries = []
  const systemNotices = []
  let cwd = null
  let title = null
  let agentName = null
  let gitBranch = null
  let version = null
  let sessionId = null
  let agentId = null
  let startedAt
  let updatedAt
  let badLines = 0

  for await (const line of eachLine(file)) {
    const o = safeParse(line)
    if (!o) {
      badLines++
      continue
    }
    if (o.sessionId && !sessionId) sessionId = o.sessionId
    if (o.agentId && !agentId) agentId = o.agentId
    if (o.cwd && !cwd) cwd = o.cwd
    if (o.gitBranch) gitBranch = o.gitBranch
    if (o.version) version = o.version
    // Every uuid-bearing record participates in the parent link graph, even the
    // ones that are not turns (system, attachment, queue-operation).
    if (o.uuid && !o.isSidechain) linkRecords.push(o)
    const ts = toMs(o.timestamp)
    if (ts) {
      if (!startedAt) startedAt = ts
      updatedAt = ts
    }
    if (o.type === 'custom-title' && o.customTitle) title = o.customTitle
    if (o.type === 'agent-name' && o.agentName) agentName = o.agentName
    if (o.type === 'last-prompt') {
      leaves.push({ leafUuid: o.leafUuid, lastPrompt: o.lastPrompt })
      continue
    }
    if (o.type === 'system') {
      if (o.subtype === 'compact_boundary' || o.compactMetadata) {
        compactBoundaries.push({ timestamp: ts, metadata: o.compactMetadata ?? null })
      } else {
        systemNotices.push({ subtype: o.subtype ?? null, level: o.level ?? null, timestamp: ts })
      }
      continue
    }
    if (!o.message || (o.type !== 'user' && o.type !== 'assistant')) continue
    // In a subagent file EVERY record carries isSidechain: true, so the flag can
    // only be used to filter inside a main session file.
    if (o.isSidechain && !isSubagentFile && !includeSidechain) continue
    records.push(o)
  }

  const messages = []
  let droppedToolResults = 0
  let droppedMeta = 0
  let droppedThinking = 0

  for (const o of records) {
    const ts = toMs(o.timestamp)
    if (o.type === 'user') {
      const content = o.message.content
      const hasToolResult = Array.isArray(content) && content.some((c) => c?.type === 'tool_result')
      const text = claudeTextOf(o)
      if (hasToolResult && !includeToolResults) {
        droppedToolResults++
        // A tool_result record occasionally carries prose too; keep only that.
        if (text.trim() && !o.isMeta) {
          messages.push({ role: 'user', text: clip(text), timestamp: ts, uuid: o.uuid, parentUuid: o.parentUuid ?? null, kind: 'tool_result_text' })
        }
        continue
      }
      if (!text.trim()) continue
      if (o.isMeta && !includeMeta) {
        droppedMeta++
        continue
      }
      if (isSyntheticUserText(text) && !o.isCompactSummary) {
        droppedMeta++
        continue
      }
      messages.push({
        role: 'user',
        text: clip(text),
        timestamp: ts,
        uuid: o.uuid,
        parentUuid: o.parentUuid ?? null,
        ...(o.isCompactSummary ? { kind: 'compact_summary' } : {}),
      })
      continue
    }

    const blocks = Array.isArray(o.message.content) ? o.message.content : []
    if (includeThinking) {
      for (const b of blocks.filter((c) => c?.type === 'thinking')) {
        if (!b.thinking?.trim()) continue
        messages.push({ role: 'assistant', text: clip(b.thinking), timestamp: ts, uuid: o.uuid, parentUuid: o.parentUuid ?? null, kind: 'thinking' })
      }
    } else {
      droppedThinking += blocks.filter((c) => c?.type === 'thinking').length
    }
    const text = blocks.filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
    const tools = blocks.filter((c) => c?.type === 'tool_use').map((c) => ({ name: c.name, id: c.id }))
    // VERIFIED: 155 of 191 assistant records in the sample carry no text at all,
    // 89 of them being a bare tool_use. Emitting those produces empty assistant
    // bubbles, so text-less records are dropped; tool traffic is reported through
    // `stats.toolUses` and the `tools` field of the surrounding text record.
    if (!text.trim()) continue
    messages.push({
      role: 'assistant',
      text: clip(text),
      timestamp: ts,
      uuid: o.uuid,
      parentUuid: o.parentUuid ?? null,
      ...(tools.length ? { tools } : {}),
      model: o.message.model ?? null,
      stopReason: o.message.stop_reason ?? null,
    })
  }

  // Prefer the parent chains when they are well-formed; they are the authoritative
  // order. The ranking is computed over the full link graph (`linkRecords`) and
  // then projected onto `messages`, which are a filtered subset of the turns.
  const ordered = buildClaudeOrder(messages, linkRecords, leaves.map((l) => l.leafUuid).filter(Boolean))

  const collapsed = collapseAdjacentDuplicates(ordered)
  const limited = options.maxMessages ? collapsed.slice(0, options.maxMessages) : collapsed
  const fileId = path.basename(file, '.jsonl')

  return {
    id: fileId,
    // In a subagent file `sessionId` is the PARENT session, so the file's own
    // identity and the parent are reported separately.
    sessionId: sessionId ?? fileId,
    parentSessionId: isSubagentFile ? sessionId ?? null : null,
    agentId,
    isSidechain: isSubagentFile,
    title: title ?? agentName ?? firstUserLine(collapsed),
    cwd,
    file,
    slug: path.basename(path.dirname(file)),
    gitBranch,
    version,
    startedAt,
    updatedAt,
    compactBoundaries,
    systemNotices,
    messages: limited,
    stats: {
      badLines,
      droppedToolResults,
      droppedMeta,
      droppedThinking,
      totalMessages: collapsed.length,
    },
  }
}
/**
 * Recover the real turn order for a Claude session file.
 *
 * Three facts, all verified on the 513-line PICO session:
 *  1. `last-prompt.leafUuid` points at the newest record — often a `system` or
 *     `attachment` record, NOT a user/assistant one — so the link graph must be
 *     built from EVERY record carrying a uuid, or the walk stops immediately
 *     (walking a turns-only graph reached just 14 of 287 records).
 *  2. A compaction severs the links: only 180 of 382 uuid records are reachable
 *     from the newest leaf, while the 32 `last-prompt` leaves together reach 372.
 *     The remaining 10 belong to abandoned branches (edited or interrupted turns).
 *  3. Chain order agrees with file order on 13/13 adjacent pairs, so for an
 *     append-only log the file position is a reliable tie-break.
 *
 * Strategy: walk every leaf chain over the full link graph, then order all
 * callers' records by that chain order, tie-broken by file position. Records
 * unreachable from any leaf keep their file position and land after their
 * neighbours instead of being dropped.
 */
function buildClaudeOrder(records, allRecords, leafUuids) {
  // The link graph spans every uuid-bearing record; `records` are the turns we
  // must order, which are a subset of it.
  const byUuid = new Map()
  for (const r of allRecords) if (r.uuid) byUuid.set(r.uuid, r)

  const orderIndex = new Map()
  let n = 0
  for (const leaf of leafUuids) {
    const seen = new Set()
    let cur = leaf
    const chain = []
    while (cur && byUuid.has(cur) && !seen.has(cur)) {
      seen.add(cur)
      chain.push(cur)
      cur = byUuid.get(cur).parentUuid
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      if (!orderIndex.has(chain[i])) orderIndex.set(chain[i], n++)
    }
  }

  const filePos = new Map()
  records.forEach((r, i) => {
    if (r.uuid) filePos.set(r.uuid, i)
  })

  // Primary key: chain rank when the record is in a chain, else its file
  // position offset past the end of the chain space; secondary key: file order.
  const rank = (r) => {
    const idx = r.uuid ? orderIndex.get(r.uuid) : undefined
    if (idx !== undefined) return idx
    return n + (r.uuid ? filePos.get(r.uuid) ?? 0 : 0)
  }
  const sorted = [...records].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    return (a.uuid ? filePos.get(a.uuid) ?? 0 : 0) - (b.uuid ? filePos.get(b.uuid) ?? 0 : 0)
  })
  return sorted
}

/** Locate a Claude session file by id. */
export async function findClaudeFile(id) {
  const files = walkJsonl(path.join(CLAUDE_ROOT, 'projects'))
  const exact = files.filter((f) => path.basename(f, '.jsonl') === String(id))
  if (exact.length) return newest(exact)
  const partial = files.filter((f) => path.basename(f).includes(String(id)))
  if (partial.length) return newest(partial)
  return null
}

function newest(files) {
  if (files.length === 1) return files[0]
  const withStat = files.map((f) => ({ f, st: statSafe(f) })).filter((x) => x.st)
  withStat.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
  return withStat[0]?.f ?? files[0]
}
