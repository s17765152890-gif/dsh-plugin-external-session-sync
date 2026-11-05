// Permanent deletion of archived session payloads, exercised on temporary fixtures only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SyncEngine } from '../engine.js';
import { assertContained, isSafeSessionId, planSessionDeletion } from '../cleanup.js';

const ID_A = 'session-aaaaaaaa-1111-4111-8111-111111111111';
const ID_B = 'session-bbbbbbbb-2222-4222-8222-222222222222';
const ID_PINNED = 'session-cccccccc-3333-4333-8333-333333333333';
const ID_LIVE = 'session-dddddddd-4444-4444-8444-444444444444';

function makeHome(ids) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-delete-'));
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
  fs.mkdirSync(path.join(home, 'external-session-sync', 'archives'), { recursive: true });
  for (const id of ids) {
    const dir = path.join(home, 'sessions', '-tmp-project', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(2048, 7));
    fs.writeFileSync(path.join(home, 'external-session-sync', 'archives', `${id}.json`), JSON.stringify({ id, messages: [] }));
  }
  fs.writeFileSync(
    path.join(home, 'storages', 'external-session-sync-v1.json'),
    JSON.stringify({ version: 1, entries: {} }),
  );
  return home;
}

function makeEngine(home, { archived, pinned = [], live = [] }) {
  const liveSessions = new Set(live);
  const ctx = {
    workspaceRegistry: { archivedSessionIds: archived, pinnedSessionIds: pinned },
    sessions: { get: (id) => (liveSessions.has(id) ? { id } : undefined) },
  };
  return new SyncEngine(ctx, home);
}

const exists = (p) => fs.existsSync(p);

test('dry run reports what would be deleted and removes nothing', async () => {
  const home = makeHome([ID_A, ID_B]);
  const engine = makeEngine(home, { archived: [ID_A, ID_B, ID_PINNED], pinned: [ID_PINNED] });
  const plan = await engine.deleteArchived({});
  assert.equal(plan.dryRun, true);
  assert.equal(plan.candidates, 2);
  assert.equal(plan.batch, 2);
  assert.ok(plan.bytes > 0);
  assert.ok(exists(path.join(home, 'sessions', '-tmp-project', ID_A)));
  assert.ok(exists(path.join(home, 'external-session-sync', 'archives', `${ID_A}.json`)));
  assert.equal(engine.state.deleted, undefined);
});

test('a real run deletes the log and archive, frees bytes, and writes a journal', async () => {
  const home = makeHome([ID_A, ID_B]);
  const engine = makeEngine(home, { archived: [ID_A, ID_B] });
  const result = await engine.deleteArchived({ dryRun: false });
  assert.equal(result.deleted, 2);
  assert.equal(result.freedBytes > 0, true);
  assert.equal(fs.existsSync(path.join(home, 'sessions', '-tmp-project', ID_A)), false);
  assert.equal(fs.existsSync(path.join(home, 'external-session-sync', 'archives', `${ID_A}.json`)), false);
  assert.ok(engine.state.deleted[ID_A].deletedAt > 0);
  const journals = fs.readdirSync(path.join(home, 'external-session-sync')).filter((name) => name.startsWith('deletions-'));
  assert.equal(journals.length, 1);
  const journal = JSON.parse(fs.readFileSync(path.join(home, 'external-session-sync', journals[0]), 'utf8'));
  assert.equal(journal.rows.filter((row) => row.ok).length, 2);
});

test('pinned sessions are never deleted', async () => {
  const home = makeHome([ID_PINNED]);
  const engine = makeEngine(home, { archived: [ID_PINNED], pinned: [ID_PINNED] });
  const plan = await engine.deleteArchived({});
  assert.equal(plan.candidates, 0);
  const result = await engine.deleteArchived({ dryRun: false });
  assert.equal(result.deleted, 0);
  assert.ok(exists(path.join(home, 'sessions', '-tmp-project', ID_PINNED)));
});

test('a currently open session is never deleted', async () => {
  const home = makeHome([ID_LIVE]);
  const engine = makeEngine(home, { archived: [ID_LIVE], live: [ID_LIVE] });
  assert.equal((await engine.deleteArchived({})).candidates, 0);
});

test('deletion is idempotent: tombstones are skipped on the next run', async () => {
  const home = makeHome([ID_A]);
  const engine = makeEngine(home, { archived: [ID_A] });
  assert.equal((await engine.deleteArchived({ dryRun: false })).deleted, 1);
  const second = await engine.deleteArchived({ dryRun: false });
  assert.equal(second.deleted, 0);
  assert.equal(second.remaining, 0);
});

test('a non-archived id is never touched even when requested explicitly', async () => {
  const home = makeHome([ID_B]);
  const engine = makeEngine(home, { archived: [] });
  const result = await engine.deleteArchived({ dryRun: false, ids: [ID_B] });
  assert.equal(result.deleted, 0);
  assert.ok(exists(path.join(home, 'sessions', '-tmp-project', ID_B)));
});

test('session ids must look like session ids before they reach a path', () => {
  assert.equal(isSafeSessionId(ID_A), true);
  assert.equal(isSafeSessionId('..'), false);
  assert.equal(isSafeSessionId('session-../../etc'), false);
  assert.equal(planSessionDeletion({ sessionsRoot: os.tmpdir(), archivesRoot: os.tmpdir(), sessionId: '../evil' }).exists, false);
});

test('a path outside the sessions root is refused', () => {
  const root = path.join(os.tmpdir(), 'sessions-root');
  assert.throws(() => assertContained(root, path.join(root, '..', 'elsewhere', ID_A), ID_A), /工作目录之外/);
  assert.throws(() => assertContained(root, path.join(root, '-tmp-project', 'other-id'), ID_A), /非会话目录结构/);
  assert.ok(assertContained(root, path.join(root, '-tmp-project', ID_A), ID_A));
});
