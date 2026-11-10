// Host half of the plugin: HTTP routes for the panel plus three agent tools.
// The Client half (client.js) only talks to these routes; all DSH mutations happen here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SyncEngine } from './engine.js';
import { nativeEvents } from './native.js';

export const name = 'dsh-plugin-external-session-sync';

/** Every service the Host half touches must be declared, or Cordis refuses the row. */
export const inject = [
  'webServer',
  'tools',
  'sessionPersistence',
  'sessions',
  'sessionController',
  'workspaceRegistry',
  'clientModules',
];

export const API = '/external-session-sync';
const VERSION = '1.2.1';
const PACKAGE_ID = 'dsh-plugin-external-session-sync';
const MAX_BODY_BYTES = 64 * 1024;
const DIAGNOSTIC_EVENTS = 60;
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function apply(ctx) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const engine = new SyncEngine(ctx, home);
  const logPath = path.join(home, 'external-session-sync', 'runtime.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = (text) => fs.appendFileSync(logPath, `${new Date().toISOString()} ${text}\n`);

  const diagnostics = { version: VERSION, mountedAt: Date.now(), events: [] };
  let lastSync;

  const send = (res, value, code = 200) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(value));
  };

  async function readBody(req) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) throw new Error('请求过大');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  function route(pathname, method, handle) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: API + pathname,
          handler: async (req, res) => {
            if (req.method !== method) return send(res, { error: 'Method not allowed' }, 405);
            // A same-origin mutation must prove it came from this app, not a cross-site form.
            if (method === 'POST' && req.headers['x-dsh-sync'] !== '1') return send(res, { error: '缺少同步请求标记' }, 403);
            if (req.headers.origin) {
              try {
                const origin = new URL(req.headers.origin);
                if (!ALLOWED_HOSTS.has(origin.hostname)) return send(res, { error: '跨站请求被拒绝' }, 403);
              } catch {
                return send(res, { error: 'Invalid origin' }, 403);
              }
            }
            try {
              await handle(req, res, new URL(req.url, 'http://127.0.0.1'));
            } catch (error) {
              log(`error ${pathname} ${error.message}`);
              send(res, { error: error.message }, 500);
            }
          },
        }),
      `external-sync.route${pathname}`,
    );
  }

  route('/status', 'GET', async (req, res, url) =>
    send(res, await engine.status({ source: url.searchParams.get('source') || undefined, q: url.searchParams.get('q') || '' })),
  );
  route('/conversation', 'GET', async (req, res, url) =>
    send(res, await engine.conversation(url.searchParams.get('source'), url.searchParams.get('id'), url.searchParams.get('maxMessages'))),
  );

  route('/sync', 'POST', async (req, res) => {
    lastSync = await engine.sync(await readBody(req));
    send(res, lastSync);
  });

  route('/archive', 'POST', async (req, res) => {
    const request = await readBody(req);
    const requested = [...new Set(Array.isArray(request.sessionIds) ? request.sessionIds.filter(Boolean) : [])];
    // The registry is authoritative for pins; a client list can only add to that set.
    const pinned = new Set([
      ...(Array.isArray(request.pinnedSessionIds) ? request.pinnedSessionIds : []),
      ...(Array.isArray(ctx.workspaceRegistry.pinnedSessionIds) ? ctx.workspaceRegistry.pinnedSessionIds : []),
    ]);
    const archived = [];
    const skippedPinned = [];
    const failed = [];
    for (const sessionId of requested) {
      if (pinned.has(sessionId)) {
        skippedPinned.push(sessionId);
        continue;
      }
      try {
        await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: false });
        archived.push(sessionId);
      } catch (error) {
        failed.push({ id: sessionId, error: error.message });
      }
    }
    const archivedSet = new Set([...(ctx.workspaceRegistry.archivedSessionIds || []), ...archived]);
    const deletedWorkspaces = [];
    const deleteFailures = [];
    // Cleanup only follows a real archive in this call: an empty or no-op request must
    // never sweep project registrations on its own.
    if (request.deleteEmptyWorkspaces !== false && archived.length) {
      for (const workspace of ctx.workspaceRegistry.list()) {
        if (!workspace.sessionIds.length || !workspace.sessionIds.every((id) => archivedSet.has(id))) continue;
        try {
          if (await ctx.workspaceRegistry.delete(workspace.id)) {
            deletedWorkspaces.push({ id: workspace.id, title: workspace.title, path: workspace.path });
          }
        } catch (error) {
          deleteFailures.push({ id: workspace.id, error: error.message });
        }
      }
    }
    send(res, { requested: requested.length, archived, skippedPinned, failed: [...failed, ...deleteFailures], deletedWorkspaces });
  });

  // Re-register a project for an existing directory and restore named session membership.
  route('/workspace', 'POST', async (req, res) => {
    const request = await readBody(req);
    if (typeof request.path !== 'string' || !request.path) throw new Error('缺少项目路径');
    const workspace = await ctx.workspaceRegistry.create(request.path);
    const attached = [];
    const failed = [];
    for (const sessionId of Array.isArray(request.sessionIds) ? request.sessionIds : []) {
      try {
        await workspace.attachSession(sessionId);
        attached.push(sessionId);
      } catch (error) {
        failed.push({ id: sessionId, error: error.message });
      }
    }
    send(res, {
      workspaceId: workspace.id,
      title: workspace.title,
      path: workspace.path,
      sessionIds: workspace.sessionIds.length,
      attached,
      failed,
    });
  });

  route('/validate', 'GET', async (req, res, url) => send(res, await engine.validateSession(url.searchParams.get('id'))));

  // Runs the importer's event shape through DSH's own session validator twice: the
  // events as written, and with the system message the runtime appends when the user
  // continues the chat. Nothing is persisted; the id is throwaway.
  route('/self-check', 'POST', async (req, res) => {
    const now = Date.now();
    const conversation = {
      title: 'shape check',
      startedAt: now,
      messages: [
        { role: 'user', text: 'first question', timestamp: now - 2000 },
        { role: 'assistant', text: 'first answer', timestamp: now - 1000 },
      ],
    };
    const base = nativeEvents(conversation, 'codex');
    const continuation = [...base];
    const turn = Math.max(0, ...base.filter((event) => event.type === 'turn/start').map((event) => event.data.turn)) + 1;
    const push = (type, data, surface = false) => {
      const event = { type, seq: continuation.length, time: now, data };
      if (surface) event.surfaceOp = 'append';
      continuation.push(event);
    };
    push('turn/start', { turn });
    push('step/start', { turn, step: 1 });
    push('system/message', { turn, step: 1, message: { role: 'system', id: crypto.randomUUID(), source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'runtime prompt' }] } }, true);
    push('step/end', { turn, step: 1 });
    push('turn/end', { turn, reason: { kind: 'completed' } });
    const check = (events) => {
      try {
        ctx.sessions.prepare(`session-${crypto.randomUUID()}`, {
          seed: events,
          meta: { createdAt: now, isSeeded: false, delegationDepth: 0, agentPreset: 'standard', cwd: home },
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    };
    send(res, { events: base.length, importedShape: check(base), afterContinuation: check(continuation) });
  });

  // Reverse of /archive: brings sessions back to the sidebar without touching their logs.
  route('/unarchive', 'POST', async (req, res) => {
    const request = await readBody(req);
    const requested = [...new Set(Array.isArray(request.sessionIds) ? request.sessionIds.filter(Boolean) : [])];
    const tombstones = engine.state.deleted || {};
    const unarchived = [];
    const failed = [];
    for (const sessionId of requested) {
      // A deleted payload can never come back: refuse instead of showing a broken chat.
      if (tombstones[sessionId]) {
        failed.push({ id: sessionId, error: '该会话的正文已被永久删除，无法取消归档' });
        continue;
      }
      try {
        await ctx.workspaceRegistry.unarchiveSession(sessionId);
        unarchived.push(sessionId);
      } catch (error) {
        failed.push({ id: sessionId, error: error.message });
      }
    }
    send(res, { requested: requested.length, unarchived, failed });
  });

  // Permanent deletion of archived session payloads. Dry run unless dryRun is false.
  route('/delete-archived', 'POST', async (req, res) => send(res, await engine.deleteArchived(await readBody(req))));

  route('/legacy-imports', 'GET', async (req, res) => {
    const rows = await engine.legacyImports();
    send(res, {
      count: rows.length,
      reimportable: rows.filter((row) => row.reimportable && !row.unreadable).length,
      unrecoverable: rows.filter((row) => !row.reimportable).length,
      unreadable: rows.filter((row) => row.unreadable).length,
      sample: rows.slice(0, 5),
    });
  });

  // Archive legacy logs (no protected head) and re-import the same source conversation
  // under a fresh identity. Old logs stay archived, so unarchiveSession reverses it.
  route('/migrate-heads', 'POST', async (req, res) => send(res, await engine.migrateLegacyHeads(await readBody(req))));

  route('/health', 'GET', async (req, res) =>
    send(res, {
      ...diagnostics,
      ...(lastSync
        ? { lastSync: { imported: lastSync.imported.length, skipped: lastSync.skipped.length, repaired: lastSync.repaired.length, failed: lastSync.failed.length } }
        : {}),
    }),
  );
  route('/client-graph', 'GET', async (req, res) =>
    send(res, {
      entries: ctx.clientModules.graph().entries.filter((entry) => entry.id === PACKAGE_ID),
      path: ctx.clientModules.clientPath(PACKAGE_ID),
    }),
  );
  route('/client-state', 'POST', async (req, res) => {
    const event = await readBody(req);
    diagnostics.events.push({ ...event, time: Date.now() });
    diagnostics.events = diagnostics.events.slice(-DIAGNOSTIC_EVENTS);
    send(res, { ok: true });
  });

  const tools = [
    {
      name: 'codex_sync_status',
      description: 'List external Codex and Claude conversations and their DSH sync state.',
      parameters: { type: 'object', properties: { source: { type: 'string', enum: ['codex', 'claude'] }, limit: { type: 'number' } } },
      run: async (args) => {
        const status = await engine.status(args);
        if (args.limit) status.discovered = status.discovered.slice(0, args.limit);
        return status;
      },
    },
    {
      name: 'codex_sync_import',
      description: 'Import external conversations using DSH native persistence. Continued sessions are preserved.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['codex', 'claude'] },
          ids: { type: 'array', items: { type: 'string' } },
          limit: { type: 'number' },
        },
      },
      run: (args) => engine.sync(args),
    },
    {
      name: 'codex_read_conversation',
      description: 'Read the newest visible user and assistant messages from an external conversation.',
      parameters: {
        type: 'object',
        properties: { source: { type: 'string', enum: ['codex', 'claude'] }, id: { type: 'string' }, maxMessages: { type: 'number' } },
        required: ['source', 'id'],
      },
      run: (args) => engine.conversation(args.source, args.id, args.maxMessages),
    },
  ];
  for (const tool of tools) {
    ctx.effect(
      () =>
        ctx.tools.register({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          output: { schema: { type: 'object' }, render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
          execute: (args) => tool.run(args || {}),
        }),
      `external-sync.tool.${tool.name}`,
    );
  }

  log(`mounted ${PACKAGE_ID} ${VERSION}; no automatic imports`);
  ctx.effect(() => () => log('disposed routes and tools'), 'external-sync.lifecycle');
}
