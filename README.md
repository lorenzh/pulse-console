# pulse-console

pulse: Web console to manage checks, incidents, tokens, notify and status settings through the pulse-api admin API.

## What works now

The console is the fifth service of the pulse Compose stack. Today it serves:

- first-run setup: a one-time setup code from the container log unlocks `/setup/owner`. That page tests the connection to pulse-api (wire version and check count) and creates the one owner account in a local SQLite database;
- password sign-in for the owner, then a required second factor: a TOTP authenticator app (RFC 6238) or one of ten single-use recovery codes. A full session ends after 30 days without use; a signed-in shell with navigation, the Overview and sign-out. When pulse-api cannot be reached, the Overview names the kind of failure: `Kind: timeout`, `Kind: connection refused`, `Kind: network error` or `Kind: status <n>` (texts in `docs/configuration.md`);
- enrolment of the authenticator at `/account/authenticator` right after setup, with the setup key shown as text (no QR code), and replacement of it with the current password;
- the account security page `/account/security` (linked from the shell): new recovery codes with the current password, the list of signed-in sessions, and "Sign out all other sessions". The account security page, Sessions and both confirmations are signed-in shell pages with the header and the Main navigation, whose "Overview" link leads back to `/`; Sessions links "Back to account security", and both confirmations have a Cancel link (to `/account/sessions` and `/account/security`) that changes nothing;
- a single-use form token on every POST form, including the account and second-factor forms: a form sent twice changes nothing the second time;
- the stylesheet `/console.css`, the busy-button script `/console.js` and the ops routes `/healthz`, `/readyz` and `/metrics`.

Each person has one console role: Owner, Admin, Member or Viewer. The role is read from the database on every request, and a policy decides what each role may do; the Team page (`/team`, Admin and Owner) lists everyone and the pending invites, makes single-use invite links, and links to each person's role change, 2FA reset, removal and (for the Owner) ownership transfer; the Owner also turns the organisation-wide 2FA requirement on or off there (no email is sent; the person who made the link passes it on). Roles, the matrix, invites and the two-factor rule are in [docs/team.md](docs/team.md). In loopback mode an invite link starts with `http://<Host>` of the page that made it, so the invitee must open the console on a loopback address (the same machine or an SSH tunnel), or the operator sets `PULSE_CONSOLE_PUBLIC_URL`. An Admin (or the Owner, for an Admin) makes a single-use password reset link that works for 24 hours; everyone changes their own password at `/account/password`. The Owner recovers a lost password with the container command below. Passkeys are not part of the console yet. Checks, incidents, tokens and the notify and status settings come in later items of [#460](https://github.com/lorenzh/pulse-meta/issues/460).

## First-run setup

1. Start the console with `PULSE_API_URL` and an admin token (`PULSE_CONSOLE_ADMIN_TOKEN_FILE`). The token needs the `read` or `checks` scope and the `admin` scope of pulse-api.
2. Find the setup code in the log: `docker logs <container> | grep 'setup code'`. The line is `pulse-console setup code: <code> (open /setup; a restart prints a new code)`. It is written to stdout outside the logger, so `PULSE_LOG_LEVEL` never hides it.
3. Open `/setup`, enter the code, then fill in the API URL, the owner email, name and password on `/setup/owner`. "Test connection" saves nothing; "Finish setup" tests again and saves.
4. "Secure the owner account": Finish setup leads to `/account/authenticator`. Create a setup key, add it to an authenticator app (SHA-1, 6 digits, 30 seconds), and enter the code it shows. The answer lists ten recovery codes once; save them. This step cannot be skipped: until it is done, every protected page leads back to it, also after a new password sign-in.

Enrolment and TOTP need `PULSE_CONSOLE_SECRET_KEY_FILE`, a file with 64 lowercase hex characters that encrypts the TOTP seeds at rest (pulse-deploy generates it). Without it the console starts and logs a warning, but enrolment and TOTP sign-in answer `503`, so the owner gets no protected access. Recovery codes still work without it.

After setup the saved API URL is used. A different `PULSE_API_URL` logs one warning at start and is ignored. There is no way to change the saved URL yet.

**Owner recovery.** A lost Owner password (or a lost Owner second factor) is recovered from the container: `bun --no-env-file src/owner-reset.ts` (in the image `docker exec <container> bun --no-env-file src/owner-reset.ts`, in a deploy stack `docker compose -f <setup>/compose.yaml exec console bun --no-env-file src/owner-reset.ts`). It reads only `PULSE_CONSOLE_DB` and `PULSE_CONSOLE_PUBLIC_URL`, replaces any unused recovery link, and prints one line: `pulse-console owner reset link: <link> (valid 15 minutes, one use)`. Without a public URL the link is `/reset/<token>` and the line ends `; open it on the console address)`. Using the link sets a new password, ends every Owner session and removes the Owner's authenticator and recovery codes, so the next sign-in leads into enrolment. Before setup it exits `2` with `pulse-console: no owner account: finish setup first`. No page links to it. Another person's password is reset with a reset link from the Team page.

**Reset (destructive).** The last resort when the Owner recovery cannot run. Stop the console, delete the database file at `PULSE_CONSOLE_DB` with its `-wal` and `-shm` files (or the `console-data` volume), and start again. The console prints a new setup code.

The console stores only SQLite; Postgres and `DATABASE_URL` are not supported.

**Lost key.** Without the key file the stored seed cannot be read: TOTP sign-in answers `500` (`The authenticator secret cannot be read. Sign in with a recovery code.`). Sign in with the password and a recovery code, then replace the authenticator on `/account/authenticator`; the new seed is encrypted with the key in use. With the key and every recovery code lost, only the Owner recovery command (for the Owner) or the reset above helps.

**Sign out.** "Sign out" (`POST /sign-out`) ends only this browser. "Sign out all other sessions" (`/account/sessions/sign-out-all`) ends every other session of the account, also half-finished sign-ins and their pending setup keys, and keeps this browser signed in with the same cookie. After a suspected cookie theft, use both: first sign out all other sessions, then sign out. Replacing the authenticator also ends every other session. Changing your own password at `/account/password` also ends every other session and keeps this one.

**Known limits.** No passkeys yet. No QR code for the setup key. The throttles live in memory and a restart clears them. TOTP needs a correct clock (NTP) on the server and the phone: the console accepts one 30-second step before and after.

**Backup.** Back up the database file and the key file together. Copy the database file while the console is stopped, or use `sqlite3 console.db ".backup backup.db"` while it runs. On restore, remove any `-wal` and `-shm` files beside the restored file.

## Run locally

```sh
bun install --frozen-lockfile
PULSE_API_URL=http://localhost:3000 bun start
```

Open <http://127.0.0.1:8082>. Bun runs the TypeScript source directly (no build step).

## Run with Docker

```sh
docker build --tag pulse-console:local .
docker run --rm -p 127.0.0.1:8082:8082 -v console-data:/data -e PULSE_API_URL=http://api:3000 pulse-console:local
```

The image keeps its database at `/data/console.db`. `/data` is owned by `bun`; mount a volume there so the account survives a new container.

Released images are published as `ghcr.io/lorenzh/pulse-console` for `linux/amd64` and `linux/arm64`, with the tags `X.Y.Z`, `X.Y` and `X` (no `latest`):

```sh
docker pull ghcr.io/lorenzh/pulse-console:0.1.0
docker run --rm -p 127.0.0.1:8082:8082 -e PULSE_API_URL=http://api:3000 ghcr.io/lorenzh/pulse-console:0.1.0
```

Pin a setup to `X.Y.Z` by digest. How a release is cut and verified is in [docs/development.md](docs/development.md#releasing).

The image listens on `0.0.0.0:8082` inside the container and runs as the non-root user `bun`. It starts with `bun --no-env-file src/main.ts`, and its healthcheck also runs `bun --no-env-file`. So neither the console nor its healthcheck reads `.env` files, also not ones mounted into `/app`. Settings come from the container environment (`-e`, `docker run --env-file` read on the host, Compose `environment:` or `env_file:`). In the pulse Compose stack (pulse-api `compose.yaml`) the console is published on host loopback only.

## Settings

| Setting                          | Default                        | Meaning                                                                                          |
| -------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `PULSE_API_URL`                  | none, required                 | Base URL of pulse-api, `http` or `https`, without credentials, query or fragment.                |
| `PULSE_CONSOLE_PORT`             | `8082`                         | Listen port.                                                                                     |
| `PULSE_CONSOLE_HOST`             | `127.0.0.1` (image: `0.0.0.0`) | Listen address.                                                                                  |
| `PULSE_CONSOLE_PUBLIC_URL`       | unset (loopback mode)          | Public origin of the console; selects the mode `loopback`, `strict-https` or `strict-http`.      |
| `PULSE_CONSOLE_DB`               | `./console.db`                 | Path of the SQLite database file; the image sets `/data/console.db`. `DATABASE_URL` is not read. |
| `PULSE_CONSOLE_ADMIN_TOKEN`      | unset                          | Optional pulse-api admin token, at least 32 characters. Never logged.                            |
| `PULSE_CONSOLE_ADMIN_TOKEN_FILE` | unset                          | File with the admin token (at least 32 characters), instead of the env var.                      |
| `PULSE_CONSOLE_SECRET_KEY_FILE`  | unset                          | File with the 32-byte seed key as 64 lowercase hex characters. Without it TOTP answers `503`.    |
| `PULSE_LOG_LEVEL`                | `info`                         | `debug`, `info`, `warn` or `error`.                                                              |

An invalid setting stops the start with exit code 2 and one line on stderr. Every rule and error text is in [docs/configuration.md](docs/configuration.md).

## HTTP endpoints

| Path                                          | Before setup                                                     | After setup                                                                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`                                       | `303` to `/setup`                                                | `200` Overview with a full session, else the access gate                                                                                   |
| `GET /setup`                                  | `200`, the setup code form                                       | `404`                                                                                                                                      |
| `POST /setup`                                 | `303` to `/setup/owner` with a grant; `401`, `409`, `422`, `429` | `404`                                                                                                                                      |
| `GET /setup/owner`                            | `200` with a grant, else `303` to `/setup`                       | `404`                                                                                                                                      |
| `POST /setup/owner`                           | test: `200` or `502`; finish: `303`, `409` or `500`              | `404`                                                                                                                                      |
| `GET /sign-in`                                | `303` to `/setup`                                                | `200`, the sign-in form; `303` to `/` when signed in                                                                                       |
| `POST /sign-in`                               | `404`                                                            | `303` to `/sign-in/factor` or `/account/authenticator`; `401`, `422`, `429`                                                                |
| `POST /sign-out`                              | `303` to `/sign-in`                                              | `303` to `/sign-in`; ends the session                                                                                                      |
| `GET /sign-in/factor`                         | `404`                                                            | `200`, the TOTP and recovery-code forms (`factor` session)                                                                                 |
| `POST /sign-in/factor`                        | `404`                                                            | `303` to `next`; `401`, `422`, `429`, `500`, `503`                                                                                         |
| `GET /account/authenticator`                  | `404`                                                            | `200`, setup key or replace form (`enrol` or full session); `503` without the key                                                          |
| `POST /account/authenticator`                 | `404`                                                            | `action=new`: `303`; `action=confirm`: `200` with the recovery codes; `401`, `409`, `422`, `429`, `503`                                    |
| `GET /account/security`                       | `404`                                                            | `200`, authenticator date, recovery codes left, links (full session)                                                                       |
| `GET /account/recovery-codes`                 | `404`                                                            | `200`, the password confirmation for new codes                                                                                             |
| `POST /account/recovery-codes`                | `404`                                                            | `200` with 10 new codes; the old ones stop working; `401`, `409`, `422`, `429`                                                             |
| `GET`/`POST /account/password`                | `404`                                                            | `200` form, then `303` to `/account/password?changed=1`; ends other sessions; `401`, `409`, `422`, `429`; every role                       |
| `GET /team`                                   | `303` to `/setup`                                                | `200` for Admin and Owner, the People list and pending invites; `403` `Access denied` for Member and Viewer                                |
| `POST /team/invites`                          | `404`                                                            | `200` with the invite link, shown only now; `403`, `409`, `422`; Admin and Owner (an Admin invite needs the Owner)                         |
| `GET`/`POST /team/invites/revoke?invite=<id>` | `303` to `/setup` / `404`                                        | `200` confirmation, then `303` to `/team`; `403`, `404`, `409`                                                                             |
| `GET`/`POST /team/role?user=<id>`             | `303` to `/setup` / `404`                                        | `200` role form, then `303` to `/team`; `403`, `404`, `409`, `422`; Owner only; ends every session of the person                           |
| `GET`/`POST /team/remove?user=<id>`           | `303` to `/setup` / `404`                                        | `200` typed confirmation, then `303` to `/team`; `403`, `404`, `409`, `422`; Admin and Owner (an Admin target needs the Owner)             |
| `GET`/`POST /team/reset-2fa?user=<id>`        | `303` to `/setup` / `404`                                        | `200` confirmation, then `303` to `/team`; `403`, `404`, `409`; Admin and Owner (an Admin target needs the Owner)                          |
| `GET`/`POST /team/reset-link?user=<id>`       | `303` to `/setup` / `404`                                        | `200` confirmation, then `200` with the reset link, shown only now; `403`, `404`, `409`; Admin and Owner (an Admin target needs the Owner) |
| `GET`/`POST /team/transfer?user=<id>`         | `303` to `/setup` / `404`                                        | `200` typed confirmation, then `303` to `/sign-in?transfer=done` with the session cookie deleted; `403`, `404`, `409`, `422`; Owner only   |
| `POST /team/require-2fa`                      | `404`                                                            | `303` to `/team`; `403`, `409`, `422`; Owner only; `value` `on` or `off`                                                                   |
| `GET`/`POST /invite/<token>`                  | `404`                                                            | `200` accept form, then `303` to `/` or `/account/authenticator`; `404` `Link not valid`, `409`, `422`; no session needed                  |
| `GET`/`POST /reset/<token>`                   | `404`                                                            | `200` new-password form, then `303` to `/sign-in?reset=done`; `404` `Link not valid`, `409`, `422`; no session needed, starts none         |
| `GET /account/sessions`                       | `404`                                                            | `200`, the live full sessions with "This browser"                                                                                          |
| `GET /account/sessions/sign-out-all`          | `404`                                                            | `200`, the confirmation                                                                                                                    |
| `POST /account/sessions/sign-out-all`         | `404`                                                            | `303` to `/account/sessions?signed-out=others`; ends every other session, keeps this one; `409` when the session changed                   |
| `GET /console.css`                            | `200`, `text/css`                                                | same                                                                                                                                       |
| `GET /console.js`                             | `200`, `text/javascript`                                         | same                                                                                                                                       |
| `GET /healthz`                                | `200 ok`                                                         | same                                                                                                                                       |
| `GET /readyz`                                 | `200 ok`; `503 shutting down` after `SIGTERM`                    | same                                                                                                                                       |
| `GET /metrics`                                | Prometheus text                                                  | same                                                                                                                                       |
| any other path                                | `404 not found`                                                  | full-session `GET`/`HEAD`: shell `404`; else plain `404`                                                                                   |

Every form POST can also answer `409` when its single-use form token is missing, expired or replayed.

`HEAD` works wherever `GET` does; another method on a known path answers `405` with `allow`. A finished setup starts an enrolment session and redirects to `/account/authenticator`. After setup an access gate sends a request without the needed session stage to its step: no session to `/sign-in?next=<path>`, a password-only session to `/sign-in/factor`, a user who must have a second factor (Owner, Admin, or everyone when the organisation switch is on) and has none to `/account/authenticator`. In loopback mode the app routes answer only a loopback `Host`. Every form POST checks `Origin` and a CSRF token. Cookies, modes, the POST order and the metrics are in [docs/configuration.md](docs/configuration.md). More in [docs/](docs/index.md).

## License

MIT, see [LICENSE](LICENSE).
