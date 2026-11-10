# Changelog

All notable changes to `dsh-plugin-external-session-sync`.

## 1.8.0 — 2026-11-10

### Changed

- Session reads go through DSH's supported API first: `sessionPersistence.open(id, 'read')`
  returns the validated header and events, so the plugin no longer depends on
  `sessionController.inspect` (removed upstream) or on decoding the log format itself.
- The raw-log decoder stays as a fallback for logs the current build refuses to restore,
  and a missing or failing `open()` degrades instead of throwing.
- Fork ancestry reads the header through the same API-first path (`readHeaderAny`).

### Verified

- `readSessionAny` closes every handle it opens, falls back when the service refuses a log,
  and tolerates a service without `open()` — covered by three new tests (28 total).
- Test fixtures now expose `open()` so the suite exercises the same path as production.

### Credits

- **Thanks to [@rumeng2580](https://github.com/rumeng2580)** — PR
  [#1](https://github.com/s17765152890-gif/dsh-plugin-external-session-sync/pull/1) identified
  that `sessionController.inspect` had been removed upstream and that reading through
  `sessionPersistence.open(id, 'read')` is the supported replacement. This feature branch now
  uses the same API-first path, with the decoded log demoted to a fallback.

## 1.2.0 — 2026-11-06

### Added

- Reverse sync (`POST /external-session-sync/reverse`, dry run by default): appends the
  turns that exist only inside a DSH session back into the Codex conversation it was
  imported from. Codex rollout files are append-only, each write is preceded by a byte
  backup (`*.reverse-sync-backup-<epoch>`) and followed by a re-read that must show the new
  records, and the payloads mirror what Codex itself writes.
- Fork resolution: a DSH "fork conversation" copies its parent and records `parentSession`
  in the session header. The fork's seeded prefix is proved equal to the parent before any
  write, and the Codex thread is taken from the imported ancestor's mapping, so a fork syncs
  back to the same "main" conversation.
- DSH runtime context (`<system-reminder>`, the runtime snapshot, the skill catalog, the
  turn timestamp) is filtered out of user messages: it is not user speech and must never be
  written into another tool's history.

### Safety

- An unscoped request is refused (HTTP 400): reverse sync only ever touches the sessions
  named in `sessionIds`.
- Threads whose rollout file no longer exists are reported instead of being recreated.
- `entry.reversed` records what was written, so a repeated request does not duplicate turns.

## 1.1.1 — 2026-11-02

### Added

- `POST /external-session-sync/unarchive`: the reverse of `/archive`, so a migration or an
  over-eager archive run can be undone per session without touching logs.

### Changed

- Migration guidance: run `migrate-heads` in small batches. Importing hundreds of large
  histories in one pass is memory-heavy and can restart the DSH process mid-run; a restart
  aborts the in-flight batch with `cannot get required service ... in inactive context`.
  Archive-then-import is idempotent, so recovering means re-running `sync` for the archived
  conversations whose `newSessionId` is missing from the migration journal.

## 1.1.0 — 2026-11-02

### Added

- `GET /external-session-sync/legacy-imports` and `POST /external-session-sync/migrate-heads`:
  detect sessions imported before the protected head, archive them, and re-import the same
  source conversation under a fresh identity. Reversible: old logs are archived, never
  deleted, so `workspaceRegistry.unarchiveSession` restores them. Every run writes
  `$DSH_HOME/external-session-sync/migration-<timestamp>.json` as a rollback journal.
- `POST /external-session-sync/self-check`: pushes the generated event shape through DSH's
  own session validator, once as written and once with the system message the runtime
  appends when a conversation continues. Nothing is persisted.

### Changed

- Native session ids carry an importer format version (`dsh-sync-native-2:`), so a migrated
  import never reuses the identity of the archived log it replaces. Existing mappings keep
  their recorded ids because re-syncing a known revision goes through the stored entry.

## 1.0.2 — 2026-11-02

### Fixed

- Imported sessions now open with a protected system head. DSH records the protected head
  only when a `system/message` is the first surface event, and that event must sit inside an
  open turn and step and be an identified message. Continuing an imported chat previously
  made the runtime append its own system message, which `session-format` rejects with
  `system/message requires a protected first surface head`, corrupting the whole log on the
  first continued turn.
- The canonical turn/step structure: the first assistant reply of a turn shares the turn's
  opening step, later replies open their own step.

### Added

- `tests/native-format.test.mjs` mirrors the V4 relations keeper, reproduces the reported
  failure for the previous shape, and proves the new shape survives continuation.

## 1.0.1 — 2026-11-02

### Fixed

- The `/sync` route had been dropped from the route table, so the panel's sync buttons hit
  the server fallback and reported a non-JSON response.
- A non-user `session/title` now always cites a message sequence; with no user message to
  anchor, the event is omitted instead of being written invalid.
- An unreadable stored log is detected, left untouched, and the conversation is re-imported
  under a deterministic `recovered` identity instead of failing forever (reported in
  `recovered[]`).
- The client separates request timeouts from body-read aborts and reports the HTTP status
  plus a body excerpt instead of a generic "invalid response".

## 1.0.0 — 2026-11-01

### Added

- Discover Codex threads from `state_5.sqlite` and merge every `rollout-*.jsonl` segment of a
  thread, including rollouts that exist on disk before Codex indexes them.
- Import Codex and Claude Code history into native DSH sessions through the Session,
  Session Persistence, Session Controller and Workspace Registry APIs.
- Verify an import: body readable, original session id resumed, project registered.
  Repeated syncs repair a missing registration without rewriting history.
- Web panel with source picker, search, per-session and bulk sync, and "continue in DSH".
- Bulk archival for old sessions (1 / 3 / 6 / 12 months), pinned sessions never archived,
  empty projects unregistered only after a real archive in the same request.
- Three agent tools: `codex_sync_status`, `codex_sync_import`, `codex_read_conversation`.
