// Permanent deletion of archived session payloads.
//
// DSH exposes no session-delete API: `sessionPersistence` is create/open/flush/stat/list
// and `ctx.sessions` is the in-memory store with no removal. Deletion therefore removes
// the on-disk payload and records a tombstone in the sync state, while the id stays in the
// workspace registry's archived list. Archived ids are never rendered by the sidebar, so a
// deleted session cannot reappear as an empty chat; `unarchive` refuses tombstoned ids.
import fs from 'node:fs';
import path from 'node:path';

const SAFE_ID = /^session-[0-9a-f-]{16,}$/i;

/** A session id must look like a session id before it is ever joined into a path. */
export function isSafeSessionId(sessionId) {
  return typeof sessionId === 'string' && SAFE_ID.test(sessionId);
}

/** `$DSH_HOME/sessions/<project slug>/<sessionId>` — the slug is opaque, so look it up. */
export function sessionDirFor(sessionsRoot, sessionId) {
  if (!isSafeSessionId(sessionId)) return null;
  let entries;
  try {
    entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(sessionsRoot, entry.name, sessionId);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Refuse anything that is not exactly `<root>/<one slug>/<sessionId>`. */
export function assertContained(sessionsRoot, dir, sessionId) {
  const root = path.resolve(sessionsRoot);
  const target = path.resolve(dir);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`拒绝删除工作目录之外的路径: ${target}`);
  }
  const parts = relative.split(path.sep);
  if (parts.length !== 2 || parts[1] !== sessionId) {
    throw new Error(`拒绝删除非会话目录结构的路径: ${target}`);
  }
  return target;
}

export function directoryBytes(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += directoryBytes(full);
      else total += fs.statSync(full).size;
    } catch {
      // a file that disappeared mid-walk contributes nothing
    }
  }
  return total;
}

/** What deletion would remove for one archived session, without touching anything. */
export function planSessionDeletion({ sessionsRoot, archivesRoot, sessionId }) {
  const dir = sessionDirFor(sessionsRoot, sessionId);
  const archiveFile = path.join(archivesRoot, `${sessionId}.json`);
  const hasArchiveFile = fs.existsSync(archiveFile);
  return {
    sessionId,
    dir,
    exists: !!dir,
    archiveFile: hasArchiveFile ? archiveFile : null,
    bytes: dir ? directoryBytes(dir) + (hasArchiveFile ? fs.statSync(archiveFile).size : 0) : 0,
  };
}

/** Delete one session payload. Returns the bytes reclaimed. Irreversible by design. */
export function deleteSessionPayload({ sessionsRoot, archivesRoot, sessionId }) {
  const plan = planSessionDeletion({ sessionsRoot, archivesRoot, sessionId });
  if (plan.dir) {
    assertContained(sessionsRoot, plan.dir, sessionId);
    fs.rmSync(plan.dir, { recursive: true, force: true });
    if (fs.existsSync(plan.dir)) throw new Error(`会话目录仍然存在: ${plan.dir}`);
  }
  if (plan.archiveFile) {
    const root = path.resolve(archivesRoot);
    const target = path.resolve(plan.archiveFile);
    if (path.relative(root, target).startsWith('..')) throw new Error('拒绝删除存档目录之外的文件');
    fs.rmSync(plan.archiveFile, { force: true });
  }
  return { sessionId, bytes: plan.bytes, removedDir: !!plan.dir, removedArchive: !!plan.archiveFile };
}
