# AGENTS.md

Guide for coding agents working in this repo. This is the canonical agent
guide. `CLAUDE.md` points here.

## What this repo is

`@joyjit/vikunja-mcp` is a Model Context Protocol (MCP) server that exposes
Vikunja task management as tools for AI assistants. It is a maintained fork of
`democratize-technology/vikunja-mcp`. It speaks MCP over stdio and calls the
Vikunja REST API through `node-vikunja` plus a few direct API calls where that
library is incomplete.

Design stance: the server is a thin Vikunja API wrapper. Tool arguments are
validated for shape (IDs, dates, enums, filter structure). Task titles and
descriptions are passed through unchanged. Content policy belongs to Vikunja,
not to this process. Do not add a content blocklist or HTML-encode task text.

## Layout

```
src/
  index.ts              Entry point: McpServer over stdio
  auth/                 AuthManager (API token vs JWT auto-detect), permissions
  client.ts             Session-aware client access
  client/               VikunjaClientFactory, patchGetAllTasks (Vikunja 2.x shim)
  config/               ConfigurationManager (env vars, profiles, defaults)
  middleware/           Rate limiting and direct middleware
  tools/index.ts        Tool registration (conditional on client and auth type)
  tools/*.ts            One module per tool (labels, teams, webhooks, ...)
  tools/tasks/          Task CRUD, bulk, assignees, comments, filtering, labels
  tools/projects/       Project CRUD, hierarchy, sharing, validation
  services/             EntityResolver, TaskCreationService
  parsers/              CSV/JSON parsers for batch import
  storage/              SimpleFilterStorage (in-memory saved filters)
  transforms/           Response field selection and task transforms
  types/                Shared types and typed errors
  utils/                Errors, logging, retry (opossum), security, memory, filters
tests/                  Jest tests, mirrors src/ layout
__mocks__/node-vikunja.ts  Jest mock for node-vikunja
scripts/                vikunja-docker.ts and test-mcp.ts for integration tests
docker/vikunja.e2e.yml  Ephemeral Vikunja for integration tests
docs/                   Architecture, configuration, API notes, CI docs
.github/workflows/      CI, integration, canary, security, release, image build
```

Many top-level `*.md`, `*.json` and `test-*.js` files are historical reports and
ad hoc scripts from earlier refactors. They are not part of the build or the
Jest suite. Do not treat them as current documentation; prefer `README.md`,
`docs/` and the code.

## Build and test

Requires Node.js 24 (`.nvmrc` is `24`, `engines.node` is `>=24.0.0`).

```bash
npm ci                 # install; also runs "prepare", which runs the build
npm test               # jest --silent (unit tests, all mocked)
npm run test:coverage  # jest with coverage thresholds enforced
npm run lint           # eslint on src/
npm run typecheck      # tsc --noEmit
npm run build          # tsc to dist/
npm run dev            # tsx watch src/index.ts
npm run format         # prettier on src/ and tests/
```

Run a single file or test:

```bash
npx jest tests/tools/labels.test.ts
npx jest -t "should create task"
```

CI (`.github/workflows/ci.yml`) runs, in order: `npm ci`, `npm run lint`,
`npm run typecheck`, `npm run test:coverage`, `npm run build`. Run the same set
before you call a change done.

Integration tests against a real Vikunja in Docker (needs Docker and Compose):

```bash
npm run build
npm run test:mcp       # up, run, down
# or step by step:
npm run test:mcp:up
npm run test:mcp:run
npm run test:mcp:down
```

`test:mcp:up` registers a throwaway user, mints a JWT and writes `.env.e2e`
(gitignored, no real secrets). See `docs/MCP-INTEGRATION-CI.md`.

## Conventions

- TypeScript strict mode. Prettier config in `.prettierrc.json`: single quotes,
  semicolons, trailing commas, 100 column width, 2 spaces, LF.
- Tools use a subcommand pattern with Zod schemas, registered in
  `src/tools/index.ts`. New tools go there, with tests under `tests/tools/`
  and a README section.
- Errors: throw `MCPError` with an `ErrorCode` (see `src/types/errors.ts` and
  `src/utils/error-handler.ts`). Re-throw an existing `MCPError` as is.
- Logs go to stderr via `src/utils/logger.ts`. stdout is reserved for the MCP
  protocol; never `console.log` to stdout in server code.
- Tests mock every external call. `node-vikunja` is mocked through
  `__mocks__/node-vikunja.ts`. Cover both success and failure paths.
- Coverage thresholds in `package.json` are enforced: branches 90, functions
  98, lines 95, statements 95. Code that cannot be tested should not be added.
  Defensive fallbacks need a test that triggers them.
- Commit messages follow a conventional style, for example
  `fix(labels): ...`, `feat: ...`, `ci: ...`, often with the issue number.
- Add user-facing changes to `CHANGELOG.md` under the next version.

## Gotchas

- `npm ci` runs the `prepare` script, which runs `tsc`. A type error breaks
  install, not just build. The Dockerfile copies `tsconfig.json` and `src/`
  before `npm ci` for this reason.
- `.npmrc` sets `strict-allow-scripts=true`. A new dependency with an install
  script fails install until it is approved in `package.json` `allowScripts`.
- `package.json` `overrides` pin nested dependencies for `npm audit`. The
  `@hono/node-server` pin is watched by `hono-override-watch.yml`, which opens
  a PR to drop it when the MCP SDK no longer needs it. Do not remove pins by
  hand without checking `npm audit`.
- Vikunja replaces the full model on update. Partial updates must GET, merge,
  then POST. Bulk update does a per-task fetch, merge and update on purpose;
  do not switch it to Vikunja's native bulk endpoint, which wipes omitted
  fields.
- Labels are additive (`PUT` per label). The bulk labels route clears labels
  when given the wrong body shape. Assignees use per-user APIs and are
  verified after write, because Vikunja ignores the bulk assign body.
- Bulk writes default to concurrency 1 (SQLite-safe) and retry lock and 5xx
  errors. `VIKUNJA_BULK_WRITE_CONCURRENCY` raises it.
- `src/client/patchGetAllTasks.ts` redirects `getAllTasks` to `GET /tasks`
  because `node-vikunja` 0.4.0 calls `/tasks/all`, which Vikunja 2.x rejects.
  Keep it until `node-vikunja` ships a fix.
- 401 vs 403: a 403 is permanent and must not be retried as if a token
  refresh would fix it. Detect status via `statusCode`.
- `users` and `export` tools register only with JWT auth. API tokens
  (`tk_...`) do not get them. Auth type is detected from the token format.
- Saved filters live in memory and are lost on restart.
- `tests/tools/*.bak*` files are stale backups and are not run by Jest.

## Release and deploy

- npm: creating a GitHub release triggers `.github/workflows/release.yml`,
  which runs lint, build and tests, then publishes `@joyjit/vikunja-mcp` with
  the `NPM_TOKEN` repo secret. Bump the version with `npm run version:patch`
  (or `minor`/`major`) and update `CHANGELOG.md` first.
- Container image: `.github/workflows/build.yml` builds the `Dockerfile` and
  pushes to GHCR on pushes to the `fleet-deploy` branch and on `v*` tags.
- CI, integration and security workflows run on pushes and PRs to `main`
  (and `develop` for CI and integration). The weekly canary runs the
  integration suite against `vikunja/vikunja:latest` and does not block PRs.
- Open changes as a branch and PR. Do not commit directly to `main` or
  `fleet-deploy`.

## Do not touch

- Secrets and env files: `.env`, `.env.local`, `.env.e2e`. Never commit real
  Vikunja URLs or tokens. Use `.env.example` placeholders.
- `.github/workflows/`, `Dockerfile`, `.npmrc`, `package.json` `overrides` and
  `allowScripts`, and `package-lock.json`, unless the task is about them.
- The pinned Vikunja image in `docker/vikunja.e2e.yml`. Bumping it is a
  deliberate support decision, not a drive-by change.
- `dist/`, `coverage/` and `node_modules/` are build output.
- The coverage thresholds in `package.json`. Do not lower them to make a
  change pass.
