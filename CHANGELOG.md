# Changelog

## Unreleased

- Include the README's linked setup and tool docs in the npm package, without historical reports.
- Put install, client configuration and a first task check at the top of the README.
- Move tool examples to `docs/tools.md` and historical reports to `docs/archive/`.
- Document the stdio-only Docker route without assuming public image availability.

## 0.3.2 — 2026-08-11

### Fixes

- Serialize bulk create/update writes (default concurrency 1) and retry SQLite lock / 5xx errors (`VIKUNJA_BULK_WRITE_CONCURRENCY` to raise on Postgres)
- Assignees on create/assign use per-user APIs and verify persistence (Vikunja ignores the bulk assign body)
- Labels use additive `PUT` instead of the bulk labels route that cleared labels
- Task `percentDone` (0–100) on create / update / bulk
- Filtered task lists apply `done` / `filter` server-side before pagination (client-side fallback unchanged)

### Platform

- Bump nested dep overrides (`js-yaml`, audit pins) so npm audit stays clean
- README updated for fork highlights, team ops, and bulk concurrency

## 0.3.1 — 2026-07-26

### Fixes

- Pass task content through to Vikunja (no local content blocklist / false rejects)
- Include all list items in success responses (no silent drop when more than 10)
- Use `GET /tasks` for getAllTasks on Vikunja 2.x (node-vikunja still called `/tasks/all`)

### Platform

- Pin nested deps (`@hono/node-server`, `fast-uri`, `brace-expansion`) so npm audit stays clean
- Weekly Hono override watch: open an undo PR when the MCP SDK no longer needs the pin

## 0.3.0 — 2026-07-18

Republish after npm package delete + GitHub release cleanup. First clean release with working CI publish token (bypass 2FA, empty IP allowlist).

## 0.2.9 — 2026-07-17

Fix Release npm auth by overwriting setup-node userconfig (empty token line was winning).

## 0.2.8 — 2026-07-17

Fix Release workflow: write npm auth into setup-node's userconfig (not project `.npmrc`).

## 0.2.7 — 2026-07-17

Confirm Release workflow npm publish (scope + public access + refreshed `NPM_TOKEN`).

## 0.2.6 — 2026-07-17

Verify GitHub Release → npm publish with the corrected `NPM_TOKEN` secret (0.2.5 was published manually after the Action token failed).

## 0.2.5 — 2026-07-17

Republish via GitHub Release so the automated npm publish job completes successfully (0.2.4 is already on the registry; recreating that release could not overwrite it).

## 0.2.4 — 2026-07-17

Republish to fix broken npm package metadata (0.2.3 was not installable via `npm`/`npx` despite existing on the registry).

## 0.2.3 — 2026-07-17

First release of the **`@joyjit/vikunja-mcp`** soft fork (based on democratize-technology/vikunja-mcp).

### Fixes

- Stop HTML-encoding strings before Vikunja JSON API calls (titles/descriptions stay raw; HTML bodies work)
- Narrow SQL-keyword rejects that false-positived on ordinary titles like "Create…"
- `bulk-update` merges per task so unrelated fields are not wiped
- Task `update` honors `projectId` (move) and applies labels on create
- Project partial `update` preserves title and `parent_project_id` when omitted

### Platform

- Require Node.js 24+ (Active LTS)
- Dockerized MCP integration CI against Vikunja 2.3; weekly canary + Dependabot on the fork

### Notes

- Package renamed from `@democratize-technology/vikunja-mcp` → `@joyjit/vikunja-mcp`
- Upstream PRs remain open where applicable; prefer upstream once equivalent fixes ship there

## Historical README notes

Archived fork highlights and architecture notes from the former README. These
are release history, not current setup requirements or new verification claims.

### Fork highlights (vs upstream npm `0.2.0`)

- **Thin wrapper**: task titles/descriptions are passed through to Vikunja unchanged; no local content blocklist (words like “format” or HTML are not rejected here)
- **No HTML-encoding** of titles/descriptions before API calls (real HTML task bodies work)
- **bulk-update** preserves fields it was not asked to change
- **Task `projectId` update** actually moves the task; labels apply on create
- **Project partial update** keeps title / parent instead of wiping them
- **Assignees stick**: create/assign use per-user APIs and verify persistence (Vikunja’s bulk assign body is ignored)
- **Labels stick**: set labels via additive `PUT` (Vikunja’s bulk labels route clears labels when given the wrong body shape)
- **`percentDone`**: create / update / bulk can set completion percentage (0–100)
- **Filtered lists paginate correctly**: `done` / `filter` go to the server before paging (with client-side fallback)
- **Bulk writes vs SQLite**: default one write at a time, retry lock/5xx; raise with `VIKUNJA_BULK_WRITE_CONCURRENCY` on Postgres
- **Vikunja 2.x**: `getAllTasks` uses `GET /tasks`; list responses include all items (no silent drop after 10)
- **Node.js 24** + Dockerized MCP integration CI against Vikunja 2.3

### Architecture notes (v0.2.0)

This release represents a **massive architectural simplification** that eliminates technical debt while enhancing security and reliability:

#### Storage Architecture Refactoring (90% Code Reduction)
- **Before**: 33 files, 9,803 lines of over-engineered storage system
- **After**: 4 files, essential functionality only
- **Eliminated**: Complex orchestrators, health monitors, statistics tracking, migration systems
- **Result**: Same external API with dramatically improved maintainability

#### Zod-Based Filter System (850+ Lines Removed)
- **Before**: Custom tokenizer, parser, and validator with security vulnerabilities
- **After**: Secure Zod schema validation with production-ready parsing
- **Enhanced**: DoS protection and comprehensive error handling
- **Result**: Faster parsing, better security, and enterprise-grade reliability

#### Production-Ready Retry System (580+ Lines Replaced)
- **Before**: Custom retry logic with maintenance overhead
- **After**: Battle-tested opossum circuit breaker library
- **Features**: Circuit breaker state sharing, automatic recovery, comprehensive monitoring
- **Result**: Production resilience with battle-tested patterns

#### Zero Breaking Changes
All improvements maintain **100% backward compatibility** with existing implementations while providing enhanced reliability and security.
