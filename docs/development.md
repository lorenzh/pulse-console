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
- `src/pages.ts` holds the setup and sign-in templates; `src/html.ts` the shared document head and form helpers (`csrfField`, `formTokenField`, `field`, `textareaField`, `submitButton` with the primary, secondary, ghost and danger variants, `formErrorSummary` as an error callout, the wordmark and the plain panel layout of `plainDocument`); `src/styles.ts` the one stylesheet served at `/console.css`: the light and dark color tokens on `:root`, the seven `@font-face` rules, the component classes and the breakpoints 1180, 900 and 719 px; `src/icons.ts` the inline SVG glyphs of the callouts and the nav entries; `src/fonts.ts` the fixed font routes and `loadFonts`.
- The fonts in `assets/fonts/` are the latin static files of the npm tarballs `@fontsource/space-grotesk@5.3.0` and `@fontsource/jetbrains-mono@5.3.0` (`package/files/<name>`), byte for byte, with each tarball's `package/LICENSE` as `OFL-*.txt`. Check the tarball `dist.integrity` and `sha256sum assets/fonts/*` against the table in the spec; nothing is added to `package.json`. The server reads them once at start and fails when one is missing. The routes are served `immutable` without a content hash, so a changed font file gets a new file name and route.
- `src/shell.ts` renders the signed-in shell (skip link, sidebar with wordmark, Main navigation, the admin "Instance" group, avatar initials, account and sign-out form, then the top bar with breadcrumbs, the banner slot and `main`); `src/navigation.ts` holds the nine-entry registry, `visibleNavigation` and `navigationGroups`; `src/roles.ts` the `ConsoleRole` order, `hasRole` and role labels.
- `src/states.ts` holds `callout` (info, success, warning, error and neutral) and the shared UI state renderers built on it; `alertCallout` renders a refusal sentence as an error callout, or as a warning for the form-expired notices; `src/confirm.ts` renders both confirmations as a panel with a ghost Cancel before the submit: a plain `ConfirmView` must set `tone` (`danger` for delete, revoke, remove and transfer, `safe` otherwise), and a typed confirmation is always danger; `src/api-failure.ts` maps a contract `fetchJson` error to an `ApiFailure` and its fixed texts. The Overview and Checks pages use the same parts: `checkStateHtml` (a dot and the unchanged state label, `dense` in tables), `tagHtml` and `sourceTag` in `src/check-pages.ts`, labelled `.table-scroll` regions (`Checks table`, `<section heading> table`), panels with an eyebrow `h2` on the detail page, and `label.choice` rows for the editor radios. `test/rendered-audit.ts` `expectCalloutsOnly` checks that every `role="alert"` or `role="status"` element is a callout and that a page has no inline style.
- `src/confirm.ts` renders the typed-name and plain confirmation pages and holds `isTypedNameConfirmed` (both names trimmed, NFC, case-sensitive, inner spaces count); `typedNameError` names the trimmed expected name.
- `src/protected-route.ts` holds the `ProtectedRoute`, `PageRequest` and `PageResult` types of a signed-in page. `src/server.ts` runs them through one dispatcher (phase, `Host`, session, POST checks, role, form token, handler) and renders the result in the shell.
- `src/overview-read.ts` reads `GET /admin/config` (with the token) and `GET /checks` (without it) at the same time; `src/overview.ts` counts the check states, picks the overall state and renders the Overview body.
- `src/form-tokens.ts` is the in-memory single-use form-token store (lifetime, per-binding and pool bounds); `src/console-script.ts` holds `CONSOLE_JS`, the busy-button script served at `/console.js`.
- `src/http-context.ts` holds the shared HTTP and session form helpers. `src/account-routes.ts` and `src/sign-in-factor.ts` handle the staged authentication and account pages; `src/account-pages.ts` renders them. `src/factor-store.ts` commits authenticator, recovery-code and session changes atomically.
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
| Browser checks in Chromium (after `bunx playwright install --with-deps chromium`)                | `bun run check:browser`         |
| Fixture console for a manual browser check, runs until stopped                                   | `bun e2e/run.ts --serve`        |

## Tests

Work test first. Tests sit next to the code as `src/<module>.test.ts`, use hand-written fakes, no real clock and no external network.

- `src/settings.test.ts` and `src/admin-token.test.ts` call `readSettings` and `readAdminToken` with an env object and a fake `readFile`. They cover every rule and error text, and check that no value appears in a message.
- `src/server.test.ts` starts the real server on `127.0.0.1` port `0` and drives it over HTTP. The path-rule cases (`//healthz`, `/%2e%2e/`, …) are written as raw request lines over `node:net`, because `fetch` normalises them before sending.
- `src/server.setup.test.ts` drives the setup flow against a real server and a fake pulse-api, both on port `0`, with a `mkdtemp` database and an injected clock. It also signs in, scans the database file for sentinels and the plain session id, compares `sessions.id_digest` with a digest from `node:crypto`, and runs a leak scan of the full flow for two clients.
- `src/server.sign-in.test.ts` covers sign-in, the throttle, session rotation, the idle limit, the cookie refresh, `next` and sign-out.
- `src/form-tokens.test.ts` drives the token store with a fake clock and fake random bytes; `src/server.form-token.test.ts` covers the form token of setup, sign-in and sign-out over HTTP (replays, concurrent posts, missing and foreign tokens, the throttle and the frozen sign-in HTML).
- `src/server.overview.test.ts` drives the Overview against the fake pulse-api of `test/fake-api.ts`; `src/server.states.test.ts` drives the state fixtures of `test/fixture-routes.ts` (statuses, headings, kept input, roles, session expiry). `src/server.confirm.test.ts` drives the eleven confirmation fixtures (`/__test/confirm/typed/<family>`, `/__test/confirm/plain/<family>`, `/__test/confirm/done`) with a recorder and a fake target that a test renames or removes. `src/server.form-token.test.ts` also covers the form token of the fixture routes. `test/signed-in-console.ts` starts a console with a completed setup and a signed-in owner session.
- `src/server.security.test.ts` covers the POST order, `Host`, `Origin`, CSRF, body limits, the CSP, cookie attributes and a leak scan.
- `src/main.startup.test.ts` spawns `bun src/main.ts` and checks bad settings and database errors, the setup code line, the warnings, the start log, the file mode and the exit code `0` on `SIGTERM`.
- Test helpers used by one test file stay inside it. Helpers shared by several test files, such as the fake pulse-api in `test/fake-api.ts`, live in `test/`. The image copies only `src`, so `test/` never ships; `tsconfig.json` includes `test` so it is typechecked and linted.
- `e2e/run.ts` is a plain Bun script, not a `*.test.ts` file, so `bun test` does not run it. `bun run check:browser` runs it: it starts the fake pulse-api and a console with the fixture routes, a temp database and a completed setup, signs in through the real form and drives Chromium (Playwright `1.64.1`, `@axe-core/playwright` `4.14.0`, both dev dependencies). It checks that no page is wider than 390 px at 390 × 844 or than 1280 px at 1280 × 800, axe with `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `wcag22aa` on sign-in, Overview, the shell 404 and 403 and one confirmation of each kind, the Tab order (Skip to content, the nav entries, Account security, Sign out) and focus outline, the `:visited` rules against the fixed link table of the spec, the confirmations and the busy button with JavaScript off (including a replay of the captured POST that answers `409`) and on (one POST only, the submitter value kept, `pageshow` restore), and that the browser reports no CSP violation. It also drives the Checks screens against a fake api that follows the writes, with JavaScript on and off: entry through the Checks navigation link, the literal host-binding and heartbeat lines and their copy buttons, the fixed quorum or heartbeat rule above Submit on the create and edit page of all six types, create of all six types, edit of all six types after a `412` conflict and Reload, edit with kept write-only values, the redacted shadowed export, composed filters and the typed delete of a name with outer spaces. It prints `ok:` per check and exits non-zero on the first failure. `e2e/tsconfig.json` adds the `dom` library, and `bun run typecheck` also runs `tsc -p e2e`.
- `bun e2e/run.ts --serve` starts the same fixture console on `127.0.0.1`, prints its URL and the test sign-in, makes the busy POST wait 3000 ms and runs until stopped. Use it for a manual check with a browser. After the password, use a fixture recovery code: 32 lowercase hex digits for the numbers 1 through 10, padded with zeros (for example `00000000000000000000000000000001`). Each works once; restarting the fixture resets the codes.

## Lefthook

`bun install --frozen-lockfile` installs a Lefthook pre-commit hook. It runs `biome check` on staged `.js`, `.ts` and `.json` files and `eslint` on staged `.js` and `.ts` files, and blocks the commit if they fail. Do not use `--no-verify`.

## CI

`.github/workflows/ci.yml` runs on pull requests, on pushes to `main` and on `v*` tags. It has five jobs:

- `check` uses the shared `check.yml` workflow of `lorenzh/pulse-config`, pinned to a commit SHA: install from the lockfile, lint (with `pulse-workflows`: every action pinned to an approved SHA, every checkout with `persist-credentials: false`, config workflow refs equal to the `package.json` pin), typecheck, tests with coverage.
- `docker` runs as a matrix on two native runners, `ubuntu-24.04` (amd64) and `ubuntu-24.04-arm` (arm64), with `fail-fast: false`. Both legs run the same steps, so the arm64 image is built and smoke-tested in every pull request. Each leg builds the image and runs it:
  1. builds `pulse-console:local`;
  2. fails if the image holds `*.test.ts` or `*.spec.ts` files outside `node_modules`, or `/app/node_modules/@biomejs`, `/app/node_modules/lefthook`, `/app/node_modules/typescript7`, `/app/bunfig.toml`, `/app/node_modules/playwright`, `/app/node_modules/@axe-core`, `/app/test` or `/app/e2e` (no tests, fixtures or dev packages ship);
  3. `Image ignores dotenv files` runs `bash scripts/image-dotenv.sh pulse-console:local`: a control run proves that `PULSE_LOG_LEVEL` from the environment is read; then `.env`, `.env.production` and `.env.local` holding a bad `PULSE_LOG_LEVEL` and `PULSE_CONSOLE_PORT=1` are mounted into `/app` in turn, and the container must pass its own healthcheck, keep the marker out of its logs and stop with `0`; last, `Cmd` and the healthcheck must start Bun with `--no-env-file`. The script prints `ok:` or `FAIL:` per case and runs all cases;
  4. starts the container with the volume `console-ci-data:/data`, `PULSE_API_URL=http://api.invalid:3000` and a sentinel admin token and waits up to 30 s for `/readyz` to answer `200` (the service starts and is ready);
  5. checks that `id -u` in the container is not `0` (non-root);
  6. follows the redirect of `/` and checks that the page holds `pulse Console` and carries `x-frame-options: DENY` (page and headers);
  7. checks that `GET /__test/states/empty` answers `404` (no test route in the image) and `GET /console.js` answers `200` with `text/javascript; charset=utf-8`;
  8. checks that two font routes answer `200 font/woff2` with the pinned SHA-256 and that the image holds both `OFL-*.txt` files;
  9. checks that the log holds exactly one `pulse-console setup code:` line;
  10. checks that `/data/console.db` belongs to `bun` with mode `600`;
  11. scans the database file and its sidecars for the sentinel token: the file must be readable, start with `SQLite format 3`, and `grep -c` must exit `1` with `0` for each file;
  12. checks that the sentinel token is in neither the container logs nor the page (no secret leaks);
  13. checks that `docker stop` gives exit code `0` (graceful shutdown);
  14. checks that a container without `PULSE_API_URL` exits `2` with `PULSE_API_URL must be set` (settings are validated);
  15. checks that a malformed secret key file exits `2` with the required error text and without disclosing its content.
- `deploy-dev` builds the dev stack of pulse-deploy main with this checkout and runs `E2E_CONSOLE_FLOW=two-factor bash e2e/console-setup.sh dev/compose.yaml`. It keeps logs on failure and always tears down the stack.
- `browser` runs on `ubuntu-24.04` with a 15 minute limit and read-only contents: install from the lockfile, `bunx playwright install --with-deps chromium`, `bun run check:browser`.
- `release` runs only on a tag. It needs `check`, both `docker` legs and `browser`, and calls the shared `release.yml` workflow of `lorenzh/pulse-config` (see [Releasing](#releasing)). On pull requests and on `main` it is skipped.

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
