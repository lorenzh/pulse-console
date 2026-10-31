# Development

This page holds only the points specific to pulse-console. The cross-repository text is in [architecture](https://github.com/lorenzh/pulse-meta/blob/main/docs/architecture.md) and [factory](https://github.com/lorenzh/pulse-meta/blob/main/docs/factory.md). Conventions for agents and humans are in [AGENTS.md](../AGENTS.md).

## Run locally

```sh
bun install --frozen-lockfile
PULSE_API_URL=http://localhost:3000 bun start
```

Open <http://127.0.0.1:8082>. Bun runs the TypeScript source directly (no build step).

## Code layout

- `src/main.ts` reads the log level and the settings, starts the server and wires shutdown through pulse-kit's `runService`. It is the only module that touches `process.env` and the file system.
- `src/settings.ts` reads and validates `PULSE_API_URL`, `PULSE_CONSOLE_PORT` and `PULSE_CONSOLE_HOST` (pure; the token file is read through a passed-in `readFile`).
- `src/admin-token.ts` reads and validates the optional admin token from `PULSE_CONSOLE_ADMIN_TOKEN` or `PULSE_CONSOLE_ADMIN_TOKEN_FILE`.
- `src/server.ts` is the HTTP server: security headers, the raw path rule, `405`, the page, the ops routes through pulse-kit's `handleOps`, and `404`. `listen` reports a bind failure with the error code only.
- `src/page.ts` is the static HTML page.
- `src/metrics.ts` holds `pulse_up`, the request counter and the readiness state.

## Checks

| Task                                                                      | Command                         |
| ------------------------------------------------------------------------- | ------------------------------- |
| Install from the lockfile (also installs the pre-commit hook)             | `bun install --frozen-lockfile` |
| All checks: CI runs the same steps                                        | `bun run check`                 |
| Lint (Biome plus SonarJS through ESLint, cognitive complexity at most 15) | `bun run lint`                  |
| Apply Biome fixes                                                         | `bun run format`                |
| Typecheck                                                                 | `bun run typecheck`             |
| Tests, with a line coverage gate of 80 %                                  | `bun run test`                  |
| One test file                                                             | `bun test src/<name>.test.ts`   |

## Tests

Work test first. Tests sit next to the code as `src/<module>.test.ts`, use hand-written fakes, no real clock and no external network.

- `src/settings.test.ts` and `src/admin-token.test.ts` call `readSettings` and `readAdminToken` with an env object and a fake `readFile`. They cover every rule and error text, and check that no value appears in a message.
- `src/server.test.ts` starts the real server on `127.0.0.1` port `0` and drives it over HTTP. The path-rule cases (`//healthz`, `/%2e%2e/`, …) are written as raw request lines over `node:net`, because `fetch` normalises them before sending.
- `src/main.startup.test.ts` spawns `bun src/main.ts` and checks the exit code and stderr line of a bad setting, the start log and the exit code `0` on `SIGTERM`.

## Lefthook

`bun install --frozen-lockfile` installs a Lefthook pre-commit hook. It runs `biome check` on staged `.js`, `.ts` and `.json` files and `eslint` on staged `.js` and `.ts` files, and blocks the commit if they fail. Do not use `--no-verify`.

## CI

`.github/workflows/ci.yml` has two jobs:

- `check` uses the shared `check.yml` workflow of `lorenzh/pulse-config`, pinned to a commit SHA: install from the lockfile, lint, typecheck, tests with coverage.
- `docker` builds the image and runs it:
  1. builds `pulse-console:local`;
  2. fails if the image holds `*.test.ts` or `*.spec.ts` files outside `node_modules`, or `/app/node_modules/@biomejs`, `/app/node_modules/lefthook`, `/app/node_modules/typescript7` or `/app/bunfig.toml` (no tests or dev packages ship);
  3. starts the container with `PULSE_API_URL=http://api.invalid:3000` and a sentinel admin token and waits up to 30 s for `/readyz` to answer `200` (the service starts and is ready);
  4. checks that `id -u` in the container is not `0` (non-root);
  5. checks that `/` holds `pulse Console` and carries `x-frame-options: DENY` (page and headers);
  6. checks that the sentinel token is in neither the container logs nor the page (no secret leaks);
  7. checks that `docker stop` gives exit code `0` (graceful shutdown);
  8. checks that a container without `PULSE_API_URL` exits `2` with `PULSE_API_URL must be set` (settings are validated).

## Shared configuration

Biome, TypeScript, Lefthook, ESLint and CI configuration live in [`lorenzh/pulse-config`](https://github.com/lorenzh/pulse-config) and reach this repository through the pinned `@lorenzh/pulse-config` dependency. A rule change is made there and arrives when the pin is updated. Settings, logging, shutdown, ops routes and metrics come from `@lorenzh/pulse-kit`, pinned to a full commit SHA.
