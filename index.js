// Host half of the plugin: HTTP routes for the panel plus three agent tools.
// The Client half (client.js) only talks to these routes; all DSH mutations happen here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SyncEngine } from './engine.js';
import { nativeEvents } from './native.js';
import { planReverse, appendTurns, readRolloutFacts, turnRecords, readSessionHeader, readSessionAny, readHeaderAny, sessionMessages, pendingTurns, prefixMatches, targetRollout, newRolloutPath, exportRecords } from './reverse.js';

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
const VERSION = '1.8.0';
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

  // Walk a session's parent chain to the imported ancestor. A DSH "fork" copies the
  // imported session, so the fork's own turns start after its parent's messages.
  const resolveSource=async(sessionId)=>{
    const entries=engine.state.entries;
    const findEntry=(id)=>Object.entries(entries).find(([,value])=>value.sessionId===id) || null;
    let mapped=findEntry(sessionId);
    const chain=[];
    let current=sessionId;
    while(!mapped && chain.length<8){
      const head=await readHeaderAny(ctx,current);
      const parentId=head?.header?.parentSession;
      if(!parentId)return {error:'该会话没有 Codex 来源，也不是导入会话的 fork'};
      chain.push({id:current,parentId});
      current=parentId;
      mapped=findEntry(current);
    }
    if(!mapped)return {error:'父链过深，无法定位导入来源'};
    const [key,entry]=mapped;
    if(!chain.length)return {key,entry,boundary:Number(entry.messages)||0,forked:false};
    let parentMessages;
    try{const parent=await readSessionAny(ctx,chain[0].parentId);if(!parent)throw new Error('父会话日志不可读');parentMessages=sessionMessages(parent.events);}
    catch(error){return {error:`无法读取父会话：${error.message}`};}
    return {key,entry,boundary:parentMessages.length,parentId:chain[0].parentId,parentMessages,forked:true};
  };

  // Sidebar-shaped source for the reverse page: projects with their unarchived sessions.
  route('/reverse-groups','GET',async(req,res)=>{
    const archived=new Set(ctx.workspaceRegistry.archivedSessionIds || []);
    const groups=ctx.workspaceRegistry.list().map(workspace=>({
      id:workspace.id,
      title:workspace.title,
      path:workspace.path,
      sessionIds:(workspace.sessionIds || []).filter(id=>!archived.has(id)),
    })).filter(group=>group.sessionIds.length);
    send(res,{groups,archived:archived.size});
  });

  // Classify one session: append to its Codex main, or export it as a new Codex thread.
  // Message preview for the reverse page: what would be written for this DSH session.
  route('/session-preview','GET',async(req,res,url)=>{
    const sessionId=url.searchParams.get('id');
    const maxMessages=Math.max(1,Math.min(200,Number(url.searchParams.get('maxMessages'))||40));
    if(!sessionId)return send(res,{error:'缺少 id'},400);
    const inspected=await readSessionAny(ctx,sessionId);
    if(!inspected)return send(res,{error:'无法读取会话：日志不可读'},500);
    const messages=sessionMessages(inspected.events);
    const tail=messages.slice(-maxMessages);
    send(res,{sessionId,total:messages.length,shown:tail.length,messages:tail.map(message=>({role:message.role,text:message.text.length>600?message.text.slice(0,600)+'…':message.text,time:message.time}))});
  });

  route('/reverse-targets','POST',async(req,res)=>{
    const request=await readBody(req);
    const ids=[...new Set(Array.isArray(request.sessionIds)?request.sessionIds.filter(Boolean):[])];
    if(!ids.length)return send(res,{error:'必须显式指定 sessionIds'},400);
    const rows=[];
    for(const sessionId of ids.slice(0,400)){
      let events;
      const read=await readSessionAny(ctx,sessionId);
      if(!read){rows.push({sessionId,mode:'error',error:'无法读取会话：日志不可读'});continue;}
      events=read.events;
      const messages=sessionMessages(events);
      const resolved=await resolveSource(sessionId);
      if(resolved.error){
        const turns=pendingTurns(messages,0);
        rows.push({sessionId,mode:'export',messages:messages.length,turns:turns.length});
        continue;
      }
      const {key,boundary,parentMessages,forked}=resolved;
      const prefixOk=!forked || prefixMatches(messages,parentMessages);
      const turns=prefixOk?pendingTurns(messages,boundary):[];
      const threadId=key.slice(key.indexOf(':')+1);
      rows.push({sessionId,mode:'append',threadId,key,forked,prefixOk,messages:messages.length,importedCount:boundary,turns:turns.length,hasRollout:!!targetRollout(threadId)});
    }
    send(res,{requested:ids.length,rows});
  });

  route('/reverse','POST',async(req,res)=>{
    const request=await readBody(req);
    const dryRun=request.dryRun!==false;
    const wanted=[...new Set(Array.isArray(request.sessionIds)?request.sessionIds.filter(Boolean):[])];
    const results=[];
    if(!wanted.length){
      return send(res,{error:'必须显式指定 sessionIds，反同步不会自动处理全部会话'},400);
    }
    for(const requested of wanted){
      let events;
      const read=await readSessionAny(ctx,requested);
      if(!read){results.push({sessionId:requested,error:'无法读取会话：日志不可读'});continue;}
      events=read.events;
      const messages=sessionMessages(events);
      const resolved=await resolveSource(requested);

      if(resolved.error){
        // Export: a session that never came from Codex becomes a new Codex thread.
        const turns=pendingTurns(messages,0);
        if(!turns.length){results.push({sessionId:requested,mode:'export',turns:0,note:'没有可导出的完整轮次（缺少助手回复）'});continue;}
        const threadId=crypto.randomUUID();
        const startedAt=Number(turns[0].user.time)||Date.now();
        const target=newRolloutPath(threadId,startedAt);
        const records=exportRecords({threadId,cwd:request.cwd||home,startedAtMs:startedAt,turns});
        if(dryRun){
          results.push({sessionId:requested,mode:'export',threadId,rollout:target,turns:turns.length,records:records.length,sample:records.slice(0,2),dryRun:true});
          continue;
        }
        try{
          fs.mkdirSync(path.dirname(target),{recursive:true});
          fs.writeFileSync(target,records.map(record=>JSON.stringify(record)).join('\n')+'\n');
          const written=fs.readFileSync(target,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
          results.push({sessionId:requested,mode:'export',threadId,rollout:target,turns:turns.length,records:records.length,appended:records.length,verified:written.length===records.length});
        }catch(error){results.push({sessionId:requested,mode:'export',error:'导出失败：'+error.message});}
        continue;
      }

      const {key,entry,boundary,parentMessages,forked}=resolved;
      if(forked && !prefixMatches(messages,parentMessages)){
        results.push({sessionId:requested,key,error:'fork 的种子前缀与父会话不一致，拒绝回写'});
        continue;
      }
      const turns=pendingTurns(messages,boundary);
      if(!turns.length){results.push({sessionId:requested,key,mode:'append',turns:0,note:'没有仅存在于 DSH 的新轮次'});continue;}
      const threadId=key.slice(key.indexOf(':')+1);
      const target=targetRollout(threadId);
      if(!target){results.push({sessionId:requested,key,threadId,mode:'append',turns:turns.length,error:'该 Codex 会话已没有 rollout 文件，无法回写'});continue;}
      const facts=readRolloutFacts(target);
      const records=[];
      for(const turn of turns)records.push(...turnRecords({threadId:facts.threadId,modelContextWindow:facts.modelContextWindow,contextTemplate:facts.contextTemplate,turn,ordinal:facts.lastOrdinal+1+records.length}));
      if(dryRun){
        results.push({sessionId:requested,key,threadId,mode:'append',rollout:target,forked,turns:turns.length,records:records.length,sample:records.slice(0,3),dryRun:true});
        continue;
      }
      const written=appendTurns(target,records);
      entry.reversed={...(entry.reversed||{}),[requested]:{turns:turns.length,messages:messages.length,at:Date.now(),threadId}};
      entry.reverseThrough=(Number(entry.reverseThrough)||0)+turns.length;
      engine.save();
      results.push({sessionId:requested,key,threadId,mode:'append',rollout:target,forked,turns:turns.length,records:records.length,...written});
    }
    send(res,{dryRun,results,done:results.filter(row=>row.verified).length,failed:results.filter(row=>row.error).length});
  });
  // Permanent deletion of archived session payloads. Dry run unless dryRun is false.
  route('/delete-archived', 'POST', async (req, res) => send(res, await engine.deleteArchived(await readBody(req))));

  route('/health', 'GET', async (req, res) =>
    send(res, {
      ...diagnostics,
      ...(lastSync
        ? { lastSync: { imported: lastSync.imported.length, skipped: lastSync.skipped.length, repaired: lastSync.repaired.length, failed: lastSync.failed.length } }
        : {}),
    }),
  );
  route('/refresh-client','POST',async(req,res)=>send(res,{revision:ctx.clientModules.rebuilt('dsh-plugin-external-session-sync')}));
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