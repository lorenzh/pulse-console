# AGENTS.md

Instructions for coding agents in this repository. They bind every change.

## Project

pulse is an uptime monitor with a status page, split over several repositories. This repository
is pulse-console, the web console that will manage pulse through the pulse-api admin API. Work
arrives as an issue with an approved spec from the meta repository; implement only the section
for this repository. Bun 1.4.0 (runtime, package manager, test runner), ESM, strict TypeScript
(`tsc --noEmit`), `bun:test`, Biome, Lefthook.

## Commands

| Task                                                          | Command                                         |
| ------------------------------------------------------------- | ----------------------------------------------- |
| Install from the lockfile (also installs the pre-commit hook) | `bun install --frozen-lockfile`                 |
| All checks: CI runs the same steps                            | `bun run check`                                 |
| One test file                                                 | `bun test src/<name>.test.ts`                   |
| Tests whose name matches                                      | `bun test --test-name-pattern "<text>"`         |
| Typecheck                                                     | `bun run typecheck`                             |
| Lint and format check / apply fixes                           | `bun run lint` / `bun run format`               |
| Run locally                                                   | `PULSE_API_URL=http://localhost:3000 bun start` |
| Browser checks (after `bunx playwright install chromium`)     | `bun run check:browser`                         |
| Fixture console for a manual browser check                    | `bun e2e/run.ts --serve`                        |
- A change is done when `bun run check` passes; the pre-commit hook runs Biome and ESLint. Never run `git commit --no-verify`, and never weaken `biome.json`, `tsconfig.json`, or CI to pass.

## Repository boundaries

- `pulse-contract` holds shared types, plain runtime validators and the wire version. It depends on no other repo. The console pins it and reads the pulse-api admin API through its `fetchJson`, validators and `WIRE_VERSION`.
- Import contract types with `import type`; import its validators and wire version as values. A service never imports another service.
- Services talk to each other only over HTTP at run time, in the shapes the contract defines.
- Pin the contract dependency to a full commit SHA on its `main`; update the pin when the spec needs a newer contract.
- A change that needs a contract change waits for the merged contract change. Never copy contract types into a service.
- Edit only this repository. Other repositories in the workspace are read-only context.
- Do not add `.factory/`, plan, or note files to this repository.

## TypeScript

- The source runs unbuilt under Bun: erasable syntax only (no `enum`, `namespace`, parameter properties). Use string-literal unions or `as const` objects.
- Relative imports carry the `.ts` extension. Built-ins use the `node:` prefix.
- Type-only imports use `import type`; mixed imports mark types inline: `import { type X, y }`.
- No `any`, also not in tests. Use `unknown` and narrow it, or the contract type.
- No non-null `!` in `src/` code. Check for `undefined` instead.
- Use `as` only right after a check at a trust boundary, never to silence the compiler.
- Give exported functions explicit return types. Use exhaustive `switch` over unions with a `never` default.
- Named exports only. No barrel files and no generic `utils.ts`.

## Code design

- Use `@lorenzh/pulse-kit`, `pulse-contract` or an approved package before writing infrastructure code (settings, logging, shutdown, ops endpoints, metrics, JSON helpers). Propose an addition to pulse-kit instead of a local helper.
- One module, one responsibility. Name the module after its job (`settings.ts`, `admin-token.ts`).
- Split a module when it holds a second responsibility, not because it is long. Over 200 lines is a review question, not a limit.
- Keep a helper beside its only caller; move it out when a second module needs it.
- Keep logic pure. I/O (HTTP, files, `process.env`, `console`) stays in `main.ts` and the server module.
- Pass side effects in as dependencies: `now: () => number`, `fetch`, `readFile`, `setTimeout`/`sleep`, `log`. Only `main.ts` wires the real ones.
- Validate untrusted input at the edge: request bodies, config files, env, and JSON from another service. Inside, use the parsed type.
- Name a function by its effect (`postResult`, `applyResult`); a pure query reads as a noun or question (`quorumStatus`, `isStale`).
- Booleans start with `is`, `has`, or `can`. Files are kebab-case.

## Errors

- Throw only `Error` subclasses with a `name`. Wrap with `{ cause }` instead of losing the original.
- An expected failure the caller must handle (bad input, unknown id) is a typed error or a result value.
- Catch at the boundary: the HTTP handler maps errors to a status; `main.ts` logs and exits.
- Never swallow an error silently. A deliberate ignore has a one-line comment that says why.
- Error and log text never contains secrets or full config.

## Tests (TDD)

- Red, green, refactor: write the failing test, watch it fail for the expected reason, write the smallest code that passes, then clean up.
- A bug fix starts with a test that reproduces the bug.
- Test the main behavior, the spec's acceptance criteria, and the obvious failures (invalid input, unreachable service, timeout). Skip contrived edge cases.
- Tests sit next to the code as `src/<module>.test.ts`; split a large suite by topic (`server.paths.test.ts`).
- Test through exported functions and HTTP, not private details. Do not export a function only for a test.
- Use hand-written fakes passed as dependencies. Do not mock built-in modules or globals.
- No real clock and no real timers: inject `now` and a fake `setTimeout`, and advance them in the test.
- No external network. Start servers on `127.0.0.1` port `0` inside the test and close them in `after`.
- Each test writes only to its own `mkdtemp` directory or an in-memory database, and cleans it up.
- `bun test` enforces at least 80 % line coverage and `bun run lint` limits cognitive complexity to 15 per function (SonarJS); never lower either to pass.

## End-to-end checks

- `src/server.test.ts`, `src/server.setup.test.ts`, `src/server.sign-in.test.ts`, `src/server.security.test.ts`, `src/server.factor.test.ts`, `src/server.recovery.test.ts`, `src/server.sessions.test.ts`, `src/server.upgrade.test.ts`, `src/server.roles.test.ts`, `src/server.team.test.ts`, `src/server.invite.test.ts`, `src/server.reset.test.ts`, `src/server.password.test.ts`, `src/server.checks.test.ts`, `src/server.checks-write.test.ts`, `src/server.checks-change.test.ts`, `src/server.tokens.test.ts`, `src/server.probes.test.ts`, `src/server.incidents.test.ts`, `src/server.incidents-write.test.ts`, `src/server.maintenance.test.ts`, `src/server.fonts.test.ts` and `src/server.races.test.ts` start the real server on port `0` and drive it over HTTP; `src/main.startup.test.ts` spawns `bun src/main.ts` and `src/owner-reset.test.ts` spawns `bun --no-env-file src/owner-reset.ts`.
- The CI job `deploy-dev` starts the dev stack of `pulse-deploy` `main` with this checkout and runs `E2E_CONSOLE_FLOW=two-factor bash e2e/console-setup.sh dev/compose.yaml`. A failure in a two-factor step where the console follows the spec is a deploy defect: hold the issue, never edit deploy from here or weaken the job.
- A change to an endpoint or a response shape gets such a test; once the console reads the API, the response is typed by the contract.
- Before handoff of a user-visible change, start the service with `bun start` and exercise the changed behavior once; report the command and result.

## Documentation

- `README.md` owns what the repository does, how to run it, its settings (env vars and defaults), and its HTTP endpoints.
- Update `README.md` and `docs/configuration.md` in the same change when behavior, a setting or an endpoint changes.
- `AGENTS.md` owns commands and conventions. Update it when a command or a convention changes.
- Specs and feature history live in the meta repository, not here.
- Comment only what the code cannot say: a non-obvious order, why the obvious way is wrong, a known limit, an external rule. No commented-out code.
- Write docs and comments in English, in short plain sentences.

## Commits and pull requests

- One change per pull request, limited to the issue's spec section.
- Commit subjects use Conventional Commits, imperative, lower case, no period (`fix: keep last data when the api is down`).
- The pull request names the issue, the checks that ran, and the known limits.

## This repository

- Pages are server-rendered HTML from template strings in `src/pages.ts` (setup, sign-in),
  `src/shell.ts` (signed-in shell) and `src/states.ts` (shared states), with the helpers of
  `src/html.ts`; every value goes through kit `escapeHtml`. Only the shell head carries the
  one script element `<script src="/console.js" defer></script>`. The assets are the stylesheet in `src/styles.ts`, served at
  `/console.css`, and the one script `CONSOLE_JS` in `src/console-script.ts`, served at
  `/console.js`. The script holds the busy button, the copy buttons, the `[data-secret]` clearing and the
  `time[data-countdown]` timer; later features extend it instead of adding another script. The CSP in `src/server.ts` is `default-src 'none'; script-src 'self';
  style-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors
  'none'`: no inline script or style and no external asset. A change that needs more widens the
  CSP in the same change.
- Every form POST follows the fixed order in `docs/configuration.md` (Origin, content type, body
  size, repeated fields, CSRF before any other check of the form).
- Every POST form carries a hidden `form_token` directly after `csrf` (`src/form-tokens.ts`);
  the route uses it up at its commit point, after every other check.
- Roles are stored in `users.role` and read on every request. The permission matrix, `minimumRole` and the target rule live in `src/permissions.ts`; a production `ProtectedRoute` takes its `requiredRole` from `routeRole(<action>)`. Team routes live in `src/team-routes.ts`, their pages in `src/team-pages.ts`, their reads and transactions in `src/team-store.ts`; every team commit takes the actor's `CredentialGuard` (`src/factor-store.ts`, from `PageRequest.sessionId`) and answers `409` `Not saved` when the session is gone. Token routes live in `src/token-routes.ts` and their pages in `src/token-pages.ts`; they read through `src/token-read.ts`, compute texts in `src/token-view.ts` and send changes through `sendTokenWrite` (`src/token-write.ts`); a secret exists only in the one POST answer. `src/server.tokens.test.ts` drives them against a fake api built from `test/token-fixtures.ts`. Probe routes live in `src/probe-routes.ts`, their pages in `src/probe-pages.ts` and the pure snippet builders in `src/probe-snippet.ts`; they reuse the token reads and `sendTokenWrite`, and `src/server.probes.test.ts` drives them. Incident routes live in `src/incident-routes.ts`, their pages in `src/incident-pages.ts`; they read through `src/incident-read.ts`, validate in `src/incident-form.ts` and send changes through `sendIncidentWrite` (`src/incident-write.ts`, on `sendApiWrite`); a route with `listFields` gets repeated values in `PageRequest.lists`. `CONSOLE_JS` also updates the `[data-preview-form]` preview with `textContent` only. `src/server.incidents*.test.ts` drive them against `test/incident-api.ts`. Maintenance routes live in `src/maintenance-routes.ts`, their pages in `src/maintenance-pages.ts`; they read through `src/maintenance-read.ts`, group in `src/maintenance-view.ts`, parse in `src/maintenance-form.ts` and write through `sendApiWrite` with `If-Match`; `src/server.maintenance.test.ts` drives them against `test/incident-api.ts`. Public link routes (`/invite/<token>`) live in `src/link-routes.ts`, token and origin helpers in `src/account-links.ts`; every team change appends one row with `appendPeopleEvent` (`src/people-log.ts`) in its own transaction. Writes after an awaited hash or verification (sign-in, own password, new codes, authenticator setup, sign out all, team commits) recheck their session and hash in one `BEGIN IMMEDIATE` transaction; `src/server.races.test.ts` drives them with gated `hashPassword` and `verifier` fakes passed to `startSignedInConsole`, never timers. `test/team-console.ts` starts a console with one stored user per role.
- Check routes live in `src/check-routes.ts` (also the typed delete confirmation). Pages: `src/check-pages.ts` (list and shared check views), `src/check-detail-pages.ts` (detail and shadowed definition), `src/check-editor-page.ts` (create and edit forms, and `editInputOf`, the stored-view mapping). `src/check-form.ts` parses a posted form with `parseCreateForm` and `parseEditForm`; a JSON pointer is an exact string and is never trimmed. Reads go through `src/check-read.ts` (`readCheckList`, `readCheckConfig`, `readCheckExport`); writes go through `sendCheckWrite` (`src/check-write.ts`) with the revision as `If-Match`, and `checkOutcome` (`src/check-outcome.ts`) classes a write outcome. Helpers: `src/check-format.ts` (display formats), `src/check-filters.ts` (list filters), `src/check-export.ts` (export) and the shell lines `shellQuote`, `hostBindingLine` and `heartbeatLine` in `src/shell-line.ts`. Check routes use the same `ProtectedRoute` gate with `routeRole` and the same form tokens as the other pages. A write-only stored value is never rendered: a stored literal header and the stored body offer Keep / Replace / Remove (`header_<i>_intent`, `body_intent`), the stored heartbeat secret offers Keep / Replace only (`secret_intent`). Unit tests sit beside each module; `src/server.checks.test.ts`, `src/server.checks-write.test.ts` and `src/server.checks-change.test.ts` drive the routes against the fake api of `test/fake-api.ts` with `test/check-fixtures.ts`. In `e2e/run.ts`, `checkScreensWith` (with the Tab order through the HTTP editors and the 1280 px fit of every editor) and `checkWriteFlowsWith` drive them in Chromium.
- The Overview, Team and test shell pages use a `ProtectedRoute` (`src/protected-route.ts`) with a `requiredRole`; the
  dispatcher in `src/server.ts` checks session, POST form, role and form token before its
  handler. Account and second-factor routes use the same session-stage gate and shared form-token store through `src/http-context.ts`. Navigation visibility is never authorization. Test-only routes live in
  `test/fixture-routes.ts` under `/__test/` and reach only a test-created server through
  `testRoutes`; `main.ts` never sets `testRoutes` or `roleOf`.
- The server compares the raw request path (`req.url` up to the first `?`) byte for byte. Never
  route on a parsed `URL.pathname`: it turns `//healthz` or `/%2e%2e/` into `/`.
- The admin token, passwords and the setup code never appear in a log line, an error, `/metrics` or a response (the code's one stdout line excepted).

## Shared tooling configuration

The shared tooling configuration lives in `lorenzh/pulse-config`. The other pulse repositories use it through `extends` (Biome, TypeScript, Lefthook), a one-line ESLint config and `uses:` (CI). A rule change is made in `pulse-config` and reaches a target when its pin is updated. "Never weaken `biome.json`, `tsconfig.json` or CI" refers to the shared config.
