// Import Codex / Claude conversations into DSH's native session store.
//
// Design rules this engine keeps:
//  - Source history is READ ONLY. Nothing under ~/.codex or ~/.claude is written.
//  - A durable import goes through DSH's own Session/Persistence/Controller/Workspace
//    APIs. No hand-written session log or workspace index.
//  - An import is an immutable snapshot keyed by (source, id, revision, cwd).
//  - "Synced" means: the body is readable AND the original session id was resumed AND
//    it is registered in its project. Re-running a sync repairs a missing registration
//    without rewriting history.
import fs from 'node:fs';
import path from 'node:path';
import {
  listClaudeSessionsAsync,
  readCodexThreadConversation,
  readClaudeConversation,
  CODEX_ROOT,
  CLAUDE_ROOT,
} from './readers.js';
import { nativeEvents, nativeId, canonicalCwd } from './native.js';
import { discoverCodexThreads } from './discovery.js';
import { readSessionAny } from './reverse.js';

const visibleMessages = (events) =>
  events.filter((event) => event.type === 'user/message' || event.type === 'assistant/message');

export class SyncEngine {
  constructor(ctx, home) {
    this.ctx = ctx;
    this.home = home;
    this.stateFile = path.join(home, 'storages', 'external-session-sync-v1.json');
    this.archiveRoot = path.join(home, 'external-session-sync', 'archives');
    this.state = this.load();
    this.queue = Promise.resolve();
    this.lastReport = null;
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, entries: {} };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.stateFile);
  }

  async discover(options = {}) {
    const out = [];
    if (options.source !== 'claude') out.push(...discoverCodexThreads());
    if (options.source !== 'codex') {
      for (const row of await listClaudeSessionsAsync()) {
        // A concurrently rotated file must not break the other source's list.
        try {
          const stat = fs.statSync(row.file);
          out.push({ ...row, source: 'claude', revision: `${stat.size}:${Math.trunc(stat.mtimeMs)}` });
        } catch {
          // the file vanished between listing and stat
        }
      }
    }
    return out
      .filter((row) => options.includeSubagents !== false || !row.isSubagent)
      .map((row) => ({ ...row, cwd: canonicalCwd(row.cwd) }))
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0) || String(a.title || '').localeCompare(String(b.title || '')));
  }

  async status(options = {}) {
    const discovered = await this.discover(options);
    const query = String(options.q || '').toLowerCase();
    const filtered = discovered.filter(
      (row) => !query || `${row.title || ''} ${row.cwd || ''} ${row.id}`.toLowerCase().includes(query),
    );
    const workspaces = this.ctx.workspaceRegistry.list();
    return {
      version: 1,
      roots: { codex: CODEX_ROOT, claude: CLAUDE_ROOT },
      scannedAt: Date.now(),
      counts: {
        codex: discovered.filter((row) => row.source === 'codex').length,
        claude: discovered.filter((row) => row.source === 'claude').length,
        synced: Object.keys(this.state.entries).length,
      },
      discovered: filtered.map((row) => {
        const entry = this.state.entries[`${row.source}:${row.id}`];
        const workspace = entry?.sessionId
          ? workspaces.find((candidate) => candidate.sessionIds.includes(entry.sessionId))
          : null;
        return {
          id: row.id,
          source: row.source,
          title: row.title || '未命名会话',
          cwd: row.cwd || null,
          bytes: row.bytes,
          updatedAt: row.updatedAt || null,
          rolloutCount: row.rolloutCount || 1,
          synced: !!entry,
          upToDate: entry?.revision === row.revision,
          dshSessionId: entry?.sessionId || null,
          workspaceAttached: !!workspace,
          workspaceId: workspace?.id || null,
        };
      }),
      lastReport: this.lastReport,
    };
  }

  async descriptor(source, id) {
    if (!['codex', 'claude'].includes(source)) throw new Error('未知会话来源');
    const all = await this.discover({ source, includeSubagents: true });
    const item = all.find((row) => row.id === id);
    if (!item) throw new Error('找不到外部会话，请刷新列表');
    return item;
  }

  async conversation(source, id, maxMessages = 100) {
    const found = await this.descriptor(source, id);
    const conversation =
      source === 'codex'
        ? await readCodexThreadConversation(id, { maxMessages: 2000 })
        : await readClaudeConversation(found.file);
    conversation.cwd = canonicalCwd(conversation.cwd || found.cwd);
    const limit = Math.max(1, Math.min(2000, Number(maxMessages) || 100));
    return {
      id: found.id,
      title: conversation.title || found.title,
      cwd: conversation.cwd || null,
      totalMessages: conversation.messages.length,
      messages: conversation.messages
        .slice(-limit)
        .map((message) => ({ role: message.role, text: message.text, timestamp: message.timestamp || null })),
      source,
    };
  }

  sync(options = {}) {
    const work = this.queue.then(() => this.run(options));
    this.queue = work.catch(() => {});
    return work;
  }

  /**
   * Resume an already-persisted native session and register it in its project.
   * `sessionController.create()` is for NEW conversations: given an existing non-empty
   * id it mints another one, which is exactly how a chat ends up outside its project.
   */
  async attachImportedSession(id, inspected) {
    const cwd = inspected.meta.cwd;
    if (!cwd) throw new Error('导入会话没有工作目录，无法登记到项目');
    const resolved = await this.ctx.sessionController.resolveAgent(id);
    if (resolved.error) throw resolved.error;
    if (!resolved.agent || resolved.agent.id !== id) throw new Error('DSH 恢复了错误的会话身份');
    const workspace = await this.ctx.workspaceRegistry.create(cwd);
    const hadMembership = workspace.sessionIds.includes(id);
    await workspace.attachSession(id);
    if (!workspace.sessionIds.includes(id)) throw new Error('DSH 会话未出现在项目中，同步未完成');
    return {
      workspaceId: workspace.id,
      workspaceTitle: workspace.title,
      workspacePath: workspace.path,
      workspaceAttached: true,
      repaired: !hadMembership,
    };
  }

  async readSource(row) {
    // A durable import is never capped the way a preview is.
    const conversation =
      row.source === 'codex'
        ? await readCodexThreadConversation(row.id)
        : await readClaudeConversation(row.file);
    conversation.messages = conversation.messages.filter(
      (message) => (message.role === 'user' || message.role === 'assistant') && message.text?.trim(),
    );
    return conversation;
  }

  /** Distinguish "no stored log" from "a stored log this DSH version cannot read". */
  async usableSession(id) {
    try {
      if (!(await this.ctx.sessionPersistence.stat(id))) return { exists: false, corrupt: false };
      await readSessionAny(this.ctx, id, { force: true });
      return { exists: true, corrupt: false };
    } catch (error) {
      if (/corrupt/i.test(String(error && error.message))) return { exists: true, corrupt: true };
      throw error;
    }
  }

  async run(options = {}) {
    const all = await this.discover({ source: options.source });
    const ids = options.ids ? new Set(options.ids) : null;
    const filtered = all.filter((row) => !ids || ids.has(row.id));
    const selected = options.limit && options.limit > 0 ? filtered.slice(0, Math.min(1000, options.limit)) : filtered;
    const report = {
      scanned: all.length,
      selected: selected.length,
      imported: [],
      skipped: [],
      repaired: [],
      recovered: [],
      archived: [],
      failed: [],
      dryRun: !!options.dryRun,
    };

    if (options.archiveSessionIds?.length && !report.dryRun) {
      for (const sessionId of [...new Set(options.archiveSessionIds)]) {
        try {
          await this.ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: false });
          report.archived.push({ id: sessionId });
        } catch (error) {
          report.failed.push({ key: `archive:${sessionId}`, title: '旧空白会话', error: error.message });
        }
      }
    }

    for (const row of selected) {
      const key = `${row.source}:${row.id}`;
      const previous = this.state.entries[key];
      try {
        let reusable = false;
        if (previous?.revision === row.revision) {
          const state = await this.usableSession(previous.sessionId);
          reusable = state.exists && !state.corrupt;
          // A log left by an older writer can be unreadable; re-import under a fresh
          // identity instead of failing the whole conversation forever.
          if (state.corrupt) report.recovered.push({ key, previous: previous.sessionId, reason: 'corrupt-session-log' });
        }
        if (reusable) {
          const inspected = await readSessionAny(this.ctx, previous.sessionId);
          const messages = visibleMessages(inspected.events).length;
          if (!messages) throw new Error('已同步会话没有有效消息，无法标记为同步完成');
          if (report.dryRun) {
            report.skipped.push({ key, id: previous.sessionId, title: row.title, messages, reason: 'already-synced' });
            continue;
          }
          // A matching snapshot still has to prove its project membership.
          const association = await this.attachImportedSession(previous.sessionId, inspected);
          this.state.entries[key] = { ...previous, ...association, messages };
          this.save();
          const item = {
            key,
            id: previous.sessionId,
            title: row.title,
            messages,
            ...association,
            reason: association.repaired ? 'workspace-repaired' : 'already-synced',
          };
          report.skipped.push(item);
          if (association.repaired) report.repaired.push(item);
          continue;
        }

        const conversation = await this.readSource(row);
        if (!conversation.messages.length) {
          report.skipped.push({ key, reason: 'no-messages' });
          continue;
        }
        let cwd = canonicalCwd(conversation.cwd || row.cwd);
        let warning;
        if (cwd) {
          try {
            if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
          } catch {
            warning = '原工作目录不存在，接手工作区使用同步模块所在工作区';
            cwd = undefined;
          }
        }
        cwd ||= path.resolve(import.meta.dirname, '../..');
        let id = nativeId(row.source, row.id, `${row.revision}|${cwd}`);
        if (report.dryRun) {
          report.imported.push({ key, id, title: conversation.title || row.title, messages: conversation.messages.length, cwd });
          continue;
        }

        let stored = await this.ctx.sessionPersistence.stat(id);
        if (stored) {
          const state = await this.usableSession(id);
          if (state.corrupt) {
            // Keep the unreadable log untouched and give this snapshot a readable identity.
            const brokenId = id;
            id = nativeId(row.source, row.id, `${row.revision}|${cwd}|recovered`);
            stored = await this.ctx.sessionPersistence.stat(id);
            report.recovered.push({ key, previous: brokenId, sessionId: id, reason: 'corrupt-session-log' });
          }
        }
        if (!stored) {
          const events = nativeEvents(conversation, row.source);
          const meta = {
            createdAt: Number(conversation.startedAt) || Date.now(),
            isSeeded: false,
            delegationDepth: 0,
            agentPreset: 'standard',
            cwd,
          };
          const prepared = this.ctx.sessions.prepare(id, { seed: events, meta });
          const handle = await this.ctx.sessionPersistence.create(prepared.header);
          try {
            await handle.append(events);
            await handle.flush();
          } finally {
            await handle.close();
          }
        }

        const inspected = await readSessionAny(this.ctx, id, { force: true });
        const count = visibleMessages(inspected.events).length;
        if (count < conversation.messages.length) {
          throw new Error(`DSH 还原消息数不完整 (${count}/${conversation.messages.length})`);
        }
        const association = await this.attachImportedSession(id, inspected);

        fs.mkdirSync(this.archiveRoot, { recursive: true });
        const archive = path.join(this.archiveRoot, `${id}.json`);
        fs.writeFileSync(
          archive,
          JSON.stringify(
            {
              source: row.source,
              externalId: row.id,
              title: conversation.title,
              cwd: canonicalCwd(conversation.cwd),
              messages: conversation.messages,
            },
            null,
            2,
          ),
        );
        this.state.entries[key] = {
          revision: row.revision,
          sessionId: id,
          title: conversation.title || row.title,
          importedAt: Date.now(),
          ...association,
          messages: count,
          archive,
          previousSessionIds: [
            ...(previous?.previousSessionIds || []),
            ...(previous?.sessionId && previous.sessionId !== id ? [previous.sessionId] : []),
          ],
        };
        this.save();
        report.imported.push({
          key,
          id,
          title: conversation.title || row.title,
          messages: count,
          cwd,
          ...association,
          ...(warning ? { warning } : {}),
        });
      } catch (error) {
        report.failed.push({ key, title: row.title, error: error.message });
      }
    }
    this.lastReport = report;
    return report;
  }

  async validateSession(id) {
    const owned = Object.values(this.state.entries).some(
      (entry) => entry.sessionId === id || entry.previousSessionIds?.includes(id),
    );
    if (!owned) throw new Error('这不是同步模块创建的会话');
    const read = await readSessionAny(this.ctx, id, { force: true });
    const messages = visibleMessages(read.events);
    const resolved = await this.ctx.sessionController.resolveAgent(id);
    if (resolved.error) throw resolved.error;
    const session = this.ctx.sessions.get(id);
    const derived = session.deriveMessages();
    const workspace = this.ctx.workspaceRegistry.list().find((row) => row.sessionIds.includes(id));
    return {
      sessionId: id,
      cwd: read.meta.cwd || null,
      eventCount: read.events.length,
      messageCount: messages.length,
      derivedMessages: derived.length,
      agentAvailable: !!resolved.agent,
      workspaceId: workspace?.id || null,
      workspaceTitle: workspace?.title || null,
      workspaceAttached: !!workspace,
      roles: derived.map((message) => message.role),
      lastText: derived
        .at(-1)
        ?.content?.filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
        ?.slice(0, 300),
    };
  }
/** Does this stored session open with a protected system head? Uses the public reader. */
  async inspectHead(sessionId) {
    try {
      const read = await readSessionAny(this.ctx, sessionId);
      const first = read.events.find(
        (event) => event.surfaceOp === 'append' || ['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'].includes(event.type),
      );
      return { sessionId, headOk: first?.type === 'system/message', firstType: first?.type || null, eventCount: read.events.length };
    } catch (error) {
      return { sessionId, headOk: false, firstType: null, unreadable: error.message };
    }
  }

  /** Every mapping whose log predates the protected head, split by whether it can be re-imported. */
  async legacyImports() {
    const discovered = await this.discover({});
    const available = new Set(discovered.map((row) => `${row.source}:${row.id}`));
    const rows = [];
    for (const [key, entry] of Object.entries(this.state.entries)) {
      if (!entry.sessionId) continue;
      const head = await this.inspectHead(entry.sessionId);
      if (head.headOk) continue;
      const split = key.indexOf(':');
      rows.push({
        key,
        sessionId: entry.sessionId,
        source: key.slice(0, split),
        externalId: key.slice(split + 1),
        title: entry.title || null,
        reimportable: available.has(key),
        firstType: head.firstType,
        unreadable: head.unreadable || null,
      });
    }
    return rows;
  }

  /**
   * Archive a legacy mapping and re-import the same source conversation under a new
   * native id (the importer's format salt guarantees a fresh identity). The old log is
   * archived, never deleted, so `workspaceRegistry.unarchiveSession` reverses this.
   */
  async migrateLegacyHeads(options = {}) {
    const rows = await this.legacyImports();
    const candidates = rows.filter((row) => row.reimportable && !row.unreadable);
    const batch = candidates.slice(0, Math.max(1, Math.min(50, Number(options.limit) || 20)));
    const summary = {
      total: rows.length,
      reimportable: candidates.length,
      unrecoverable: rows.filter((row) => !row.reimportable),
      unreadable: rows.filter((row) => row.unreadable).length,
    };
    if (options.dryRun !== false) {
      return { ...summary, dryRun: true, batch: batch.map(({ key, title, sessionId, firstType }) => ({ key, title, sessionId, firstType })) };
    }
    const journal = { startedAt: new Date().toISOString(), rows: [] };
    const ids = [];
    for (const row of batch) {
      try {
        await this.ctx.workspaceRegistry.archiveSession(row.sessionId, { stopActivity: false });
        delete this.state.entries[row.key];
        this.save();
        ids.push(row.externalId);
        journal.rows.push({ key: row.key, oldSessionId: row.sessionId, archived: true });
      } catch (error) {
        journal.rows.push({ key: row.key, oldSessionId: row.sessionId, archived: false, error: error.message });
      }
    }
    const report = ids.length ? await this.run({ ids }) : null;
    if (report) {
      for (const item of report.imported) {
        const row = journal.rows.find((entry) => entry.key === item.key);
        if (row) row.newSessionId = item.id;
      }
      for (const item of report.failed) {
        const row = journal.rows.find((entry) => entry.key === item.key);
        if (row) row.importError = item.error;
      }
    }
    journal.finishedAt = new Date().toISOString();
    const root = path.join(this.home, 'external-session-sync');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, `migration-${Date.now()}.json`), JSON.stringify(journal, null, 2));
    const remaining = await this.legacyImports();
    return {
      ...summary,
      dryRun: false,
      batch: batch.length,
      archived: journal.rows.filter((row) => row.archived).length,
      archiveFailures: journal.rows.filter((row) => !row.archived),
      imported: report ? report.imported.length : 0,
      importFailures: report ? report.failed : [],
      remaining: remaining.length,
    };
  }
}