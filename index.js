// Host half of the plugin: HTTP routes for the panel plus three agent tools.
// The Client half (client.js) only talks to these routes; all DSH mutations happen here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncEngine } from './engine.js';

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
const VERSION = '1.0.0';
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
