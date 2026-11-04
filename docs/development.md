# Development

This page holds only the points specific to pulse-console. The cross-repository text is in [architecture](https://github.com/lorenzh/pulse-meta/blob/main/docs/architecture.md) and [factory](https://github.com/lorenzh/pulse-meta/blob/main/docs/factory.md). Conventions for agents and humans are in [AGENTS.md](../AGENTS.md).

## Run locally

```sh
bun install --frozen-lockfile
PULSE_API_URL=http://localhost:3000 bun start
```

Open <http://127.0.0.1:8082>. Bun runs the TypeScript source directly (no build step).

## Code layout

- `src/main.ts` reads the log level and the settings, opens the database, prints the setup code, starts the server and wires shutdown through pulse-kit's `runService`. It is the only module that touches `process.env`, the file system, `crypto` randomness, `Bun.password` and stdout.
- `src/settings.ts` reads and validates the settings and selects the mode (pure; the token file is read through a passed-in `readFile`).
- `src/admin-token.ts` reads and validates the optional admin token from `PULSE_CONSOLE_ADMIN_TOKEN` or `PULSE_CONSOLE_ADMIN_TOKEN_FILE`.
- `src/database.ts` opens the SQLite file (mode `0600`, pragmas, migrations); `src/account-store.ts` holds the instance row, the owner, the setup transaction and sessions.
- `src/setup-code.ts` makes the setup code and the grant; `src/auth-throttle.ts` is the failure limiter; `src/passwords.ts` holds the password rules and hash parameters; `src/cookies.ts` names and serializes cookies; `src/connection-test.ts` calls pulse-api.
- `src/request-guard.ts` holds the loopback `Host`, `Origin`, CSRF and `next` rules; `src/forms.ts` the content type, repeated-field and field rules.
- `src/server.ts` is the HTTP server: security headers and CSP, the raw path rule, routes, phases and the POST order, the ops routes through pulse-kit's `handleOps`, and `404`. `listen` reports a bind failure with the error code only.
- `src/pages.ts` holds the setup and sign-in templates; `src/html.ts` the shared document head and form helpers (`csrfField`, `formTokenField`, `field`, `textareaField`, `submitButton`, `formErrorSummary`); `src/styles.ts` the stylesheet served at `/console.css`.
- `src/shell.ts` renders the signed-in shell (skip link, header, sign-out form, navigation, banner slot, `main`); `src/navigation.ts` holds the nine-entry registry and `visibleNavigation`; `src/roles.ts` the `ConsoleRole` order, `hasRole` and role labels.
- `src/states.ts` holds the shared UI state renderers; `src/api-failure.ts` maps a contract `fetchJson` error to an `ApiFailure` and its fixed texts.
- `src/overview-read.ts` reads `GET /admin/config` (with the token) and `GET /checks` (without it) at the same time; `src/overview.ts` counts the check states, picks the overall state and renders the Overview body.
- `src/form-tokens.ts` is the in-memory single-use form-token store (lifetime, per-binding and pool bounds); `src/console-script.ts` holds `CONSOLE_JS`, the busy-button script served at `/console.js`.
- `src/metrics.ts` holds `pulse_up`, the request and auth counters and the readiness state.

## Checks

| Task                                                                                             | Command                         |
| ------------------------------------------------------------------------------------------------ | ------------------------------- |
| Install from the lockfile (also installs the pre-commit hook)                                    | `bun install --frozen-lockfile` |
| All checks: CI runs the same steps                                                               | `bun run check`                 |
| Lint (Biome, SonarJS through ESLint with cognitive complexity at most 15, and `pulse-workflows`) | `bun run lint`                  |
| Apply Biome fixes                                                                                | `bun run format`                |
| Typecheck                                                                                        | `bun run typecheck`             |
| Tests, with a line coverage gate of 80 %                                                         | `bun run test`                  |
| One test file                                                                                    | `bun test src/<name>.test.ts`   |

## Tests

Work test first. Tests sit next to the code as `src/<module>.test.ts`, use hand-written fakes, no real clock and no external network.

- `src/settings.test.ts` and `src/admin-token.test.ts` call `readSettings` and `readAdminToken` with an env object and a fake `readFile`. They cover every rule and error text, and check that no value appears in a message.
- `src/server.test.ts` starts the real server on `127.0.0.1` port `0` and drives it over HTTP. The path-rule cases (`//healthz`, `/%2e%2e/`, …) are written as raw request lines over `node:net`, because `fetch` normalises them before sending.
- `src/server.setup.test.ts` drives the setup flow against a real server and a fake pulse-api, both on port `0`, with a `mkdtemp` database and an injected clock. It also signs in, scans the database file for sentinels and the plain session id, compares `sessions.id_digest` with a digest from `node:crypto`, and runs a leak scan of the full flow for two clients.
- `src/server.sign-in.test.ts` covers sign-in, the throttle, session rotation, the idle limit, the cookie refresh, `next` and sign-out.
- `src/form-tokens.test.ts` drives the token store with a fake clock and fake random bytes; `src/server.form-token.test.ts` covers the form token of setup, sign-in and sign-out over HTTP (replays, concurrent posts, missing and foreign tokens, the throttle and the frozen sign-in HTML).
- `src/server.security.test.ts` covers the POST order, `Host`, `Origin`, CSRF, body limits, the CSP, cookie attributes and a leak scan.
- `src/main.startup.test.ts` spawns `bun src/main.ts` and checks bad settings and database errors, the setup code line, the warnings, the start log, the file mode and the exit code `0` on `SIGTERM`.
- Test helpers used by one test file stay inside it. Helpers shared by several test files, such as the fake pulse-api in `test/fake-api.ts`, live in `test/`. The image copies only `src`, so `test/` never ships; `tsconfig.json` includes `test` so it is typechecked and linted.

## Lefthook

`bun install --frozen-lockfile` installs a Lefthook pre-commit hook. It runs `biome check` on staged `.js`, `.ts` and `.json` files and `eslint` on staged `.js` and `.ts` files, and blocks the commit if they fail. Do not use `--no-verify`.

## CI

`.github/workflows/ci.yml` runs on pull requests, on pushes to `main` and on `v*` tags. It has three jobs:

- `check` uses the shared `check.yml` workflow of `lorenzh/pulse-config`, pinned to a commit SHA: install from the lockfile, lint (with `pulse-workflows`: every action pinned to an approved SHA, every checkout with `persist-credentials: false`, config workflow refs equal to the `package.json` pin), typecheck, tests with coverage.
- `docker` runs as a matrix on two native runners, `ubuntu-24.04` (amd64) and `ubuntu-24.04-arm` (arm64), with `fail-fast: false`. Both legs run the same steps, so the arm64 image is built and smoke-tested in every pull request. Each leg builds the image and runs it:
  1. builds `pulse-console:local`;
  2. fails if the image holds `*.test.ts` or `*.spec.ts` files outside `node_modules`, or `/app/node_modules/@biomejs`, `/app/node_modules/lefthook`, `/app/node_modules/typescript7` or `/app/bunfig.toml` (no tests or dev packages ship);
  3. `Image ignores dotenv files` runs `bash scripts/image-dotenv.sh pulse-console:local`: a control run proves that `PULSE_LOG_LEVEL` from the environment is read; then `.env`, `.env.production` and `.env.local` holding a bad `PULSE_LOG_LEVEL` and `PULSE_CONSOLE_PORT=1` are mounted into `/app` in turn, and the container must pass its own healthcheck, keep the marker out of its logs and stop with `0`; last, `Cmd` and the healthcheck must start Bun with `--no-env-file`. The script prints `ok:` or `FAIL:` per case and runs all cases;
  4. starts the container with the volume `console-ci-data:/data`, `PULSE_API_URL=http://api.invalid:3000` and a sentinel admin token and waits up to 30 s for `/readyz` to answer `200` (the service starts and is ready);
  5. checks that `id -u` in the container is not `0` (non-root);
  6. follows the redirect of `/` and checks that the page holds `pulse Console` and carries `x-frame-options: DENY` (page and headers);
  7. checks that the log holds exactly one `pulse-console setup code:` line;
  8. checks that `/data/console.db` belongs to `bun` with mode `600`;
  9. scans the database file and its sidecars for the sentinel token: the file must be readable, start with `SQLite format 3`, and `grep -c` must exit `1` with `0` for each file;
  10. checks that the sentinel token is in neither the container logs nor the page (no secret leaks);
  11. checks that `docker stop` gives exit code `0` (graceful shutdown);
  12. checks that a container without `PULSE_API_URL` exits `2` with `PULSE_API_URL must be set` (settings are validated).
- `release` runs only on a tag. It needs `check` and both `docker` legs, and calls the shared `release.yml` workflow of `lorenzh/pulse-config` (see [Releasing](#releasing)). On pull requests and on `main` it is skipped.

A tag run is never cancelled by a later push to the same ref; branch and pull request runs are.

## Releasing

The git tag is the version. `package.json` keeps `"version": "0.0.0"`.

- A stable tag is `vX.Y.Z` (no leading zeros). It must point to a commit on `main`; otherwise the release fails before any build.
- A pre-release tag is `vX.Y.Z-<pre>`, for example `v0.2.0-rc.1`. It may point to any commit.
- Other tag shapes (`v1.2`, `v1.2.3+build.5`, `v01.2.3`) fail the release.

A person cuts the release. A tag pushed by a workflow token starts no workflow.

```sh
git tag vX.Y.Z <sha on main> && git push origin vX.Y.Z
```

The tag run executes the gate first: `check` (lint, typecheck, tests) and both `docker` legs (amd64 and arm64 smoke tests). When any of them fails, `release` is skipped and nothing is published.

When the gate is green, `release` publishes `ghcr.io/lorenzh/pulse-console` for `linux/amd64` and `linux/arm64`:

- `X.Y.Z` always;
- `X.Y` only when `X.Y.Z` is the highest stable `vX.Y.*` tag, and `X` only when it is the highest stable `vX.*.*` tag, so these tags never move backward;
- a pre-release gets only its own tag, for example `0.2.0-rc.1`.

There is no `latest` and no `edge` tag. A push to `main` publishes nothing.

Never move or re-push a release tag. The workflow refuses to publish a version that already exists in the registry. The per-platform digests of a refused run stay in the package as untagged versions; delete them in the package settings if you want.

The release builds the image again from the tagged commit. The content matches the image that the `docker` job checked (same Dockerfile, lockfile and digest-pinned base), but the digest can differ through timestamps.

Verify the build provenance:

```sh
gh attestation verify oci://ghcr.io/lorenzh/pulse-console:<version> --owner lorenzh
```

Setups pin `X.Y.Z` by digest. `0` moves across breaking `0.x` minors.

The package starts private. After the first release the owner sets it to public once in the package settings on GitHub.

## Shared configuration

Biome, TypeScript, Lefthook, ESLint and CI configuration live in [`lorenzh/pulse-config`](https://github.com/lorenzh/pulse-config) and reach this repository through the pinned `@lorenzh/pulse-config` dependency. A rule change is made there and arrives when the pin is updated. Settings, logging, shutdown, ops routes and metrics come from `@lorenzh/pulse-kit`, pinned to a full commit SHA.
