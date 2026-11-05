# Configuration

The console reads its settings from the environment once at start. An invalid setting stops the start with exit code 2 and one line on stderr, prefixed `pulse-console: `. The checks run in this order, and the first failure stops the start: `PULSE_LOG_LEVEL`, `PULSE_API_URL`, `PULSE_CONSOLE_PORT`, `PULSE_CONSOLE_HOST`, `PULSE_CONSOLE_PUBLIC_URL`, `PULSE_CONSOLE_DB`, the admin token, `PULSE_CONSOLE_SECRET_KEY_FILE`. `DATABASE_URL` is not read. A value that is blank or only whitespace counts as unset.

## Settings

| Setting                          | Default               | Rule                                                                                                                                                                                                                                   |
| -------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PULSE_API_URL`                  | none, required        | Before setup the default of the setup form; after setup the saved URL wins. Trimmed. No whitespace or control character inside. Then `http:` or `https:`, a host, no credentials, no query or fragment. One trailing slash is dropped. |
| `PULSE_CONSOLE_PORT`             | `8082`                | Integer from 0 to 65535. `0` takes any free port.                                                                                                                                                                                      |
| `PULSE_CONSOLE_HOST`             | `127.0.0.1`           | Listen address. The image sets `0.0.0.0`.                                                                                                                                                                                              |
| `PULSE_CONSOLE_PUBLIC_URL`       | unset (loopback mode) | The console's public origin. The `PULSE_API_URL` rules, and no path other than `/`. Selects the mode, see below.                                                                                                                       |
| `PULSE_CONSOLE_DB`               | `./console.db`        | Path of the SQLite database file. Trimmed; blank counts as unset. The image sets `/data/console.db`.                                                                                                                                   |
| `PULSE_CONSOLE_ADMIN_TOKEN`      | unset                 | Optional. The token rules below.                                                                                                                                                                                                       |
| `PULSE_CONSOLE_ADMIN_TOKEN_FILE` | unset                 | Optional. Path to a file with the token; the content is trimmed, then the token rules apply.                                                                                                                                           |
| `PULSE_CONSOLE_SECRET_KEY_FILE`  | unset                 | Optional. Path to the key that encrypts TOTP seeds, see "Secret key" below.                                                                                                                                                            |
| `PULSE_LOG_LEVEL`                | `info`                | `debug`, `info`, `warn` or `error`.                                                                                                                                                                                                    |

### Error texts

| Setting                                    | Case                                               | Line on stderr                                                                                                              |
| ------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `PULSE_API_URL`                            | unset or blank                                     | `pulse-console: PULSE_API_URL must be set`                                                                                  |
| `PULSE_API_URL`                            | whitespace or control character inside             | `pulse-console: PULSE_API_URL: must not contain whitespace or control characters`                                           |
| `PULSE_API_URL`                            | not an http(s) URL, credentials, query or fragment | `pulse-console: PULSE_API_URL: must be an http(s) URL without credentials, query or fragment`                               |
| `PULSE_CONSOLE_PORT`                       | not an integer from 0 to 65535                     | `pulse-console: PULSE_CONSOLE_PORT: must be an integer from 0 to 65535`                                                     |
| `PULSE_CONSOLE_HOST`, `PULSE_CONSOLE_PORT` | bind failure                                       | `pulse-console: PULSE_CONSOLE_HOST/PULSE_CONSOLE_PORT: cannot listen on <host>:<port> (<code>)`, for example `(EADDRINUSE)` |
| `PULSE_LOG_LEVEL`                          | other value                                        | `pulse-console: PULSE_LOG_LEVEL: must be one of debug, info, warn, error`                                                   |

| `PULSE_CONSOLE_PUBLIC_URL` | whitespace or control character inside | `pulse-console: PULSE_CONSOLE_PUBLIC_URL: must not contain whitespace or control characters` |
| `PULSE_CONSOLE_PUBLIC_URL` | not an http(s) URL, credentials, query or fragment | `pulse-console: PULSE_CONSOLE_PUBLIC_URL: must be an http(s) URL without credentials, query or fragment` |
| `PULSE_CONSOLE_PUBLIC_URL` | a path other than `/` | `pulse-console: PULSE_CONSOLE_PUBLIC_URL: must not have a path other than /` |
| `PULSE_CONSOLE_DB` | missing or unwritable directory, not a database | `pulse-console: PULSE_CONSOLE_DB=<path>: cannot open (<code>)`, for example `(ENOENT)` or `(SQLITE_NOTADB)` |
| `PULSE_CONSOLE_DB` | schema newer than this console | `pulse-console: PULSE_CONSOLE_DB=<path>: schema version <n> is newer than this console (2)` |
| `PULSE_CONSOLE_SECRET_KEY_FILE` | file cannot be read | `pulse-console: PULSE_CONSOLE_SECRET_KEY_FILE=<path>: cannot read (<code>)` |
| `PULSE_CONSOLE_SECRET_KEY_FILE` | not 64 lowercase hex characters after dropping one trailing `\n` | `pulse-console: PULSE_CONSOLE_SECRET_KEY_FILE=<path>: must hold 64 lowercase hex characters` |
| `PULSE_CONSOLE_SECRET_KEY_FILE` | equal to the admin token | `pulse-console: PULSE_CONSOLE_SECRET_KEY_FILE=<path>: must differ from the admin token` |

The URL texts are fixed: the value is never printed, so a password in the URL stays out of the output. Whitespace inside is refused before the URL parser runs, because the parser drops tabs and newlines and would accept `http://api\t:3000` as `http://api:3000`.

## Mode

`PULSE_CONSOLE_PUBLIC_URL` selects the mode:

- `loopback`: unset, or `http:` with the host `127.0.0.1`, `localhost` or `[::1]`.
- `strict-https`: an `https:` URL.
- `strict-http`: `http:` with any other host. The start logs `warn` `PULSE_CONSOLE_PUBLIC_URL uses http: session cookies are not marked Secure`.

In loopback mode every request outside the ops routes needs a `Host` of `127.0.0.1`, `localhost` or `[::1]`, with an optional port. Otherwise the answer is `421` `misdirected request: set PULSE_CONSOLE_PUBLIC_URL to serve this host`. This also stops DNS rebinding. A form POST needs `Origin: http://<Host>` in loopback mode and the public origin in the strict modes. A reverse proxy must keep the `Origin` header and serve the console from the origin in `PULSE_CONSOLE_PUBLIC_URL`.

## Setup code and API URL

At start, a database without a completed setup gets a new setup code: 16 random bytes, written as 8 groups of 4 lowercase hex characters. The console writes it once to stdout, outside the logger: `pulse-console setup code: <code> (open /setup; a restart prints a new code)`. Only its SHA-256 digest stays in memory. Spaces and `-` in the input are ignored and case does not matter. An empty code answers `422`; a wrong code answers `401` and counts. 5 wrong codes from one client in 15 minutes lock that client for 15 minutes (`429` with `Retry-After`). A restart makes a new code, drops the old code, all grants and the throttle state.

A correct code sets a setup grant cookie that is valid for 30 minutes. A new unlock replaces it. The grant opens only `/setup/owner`.

The setup form takes the API URL (the `PULSE_API_URL` rules, at most 2048 characters, one trailing `/` dropped, a path prefix kept), the owner email (trimmed, lowercased, 3 to 254 characters, one `@`), the name (1 to 100 characters) and the password (12 to 128 code points, not trimmed) twice. The connection test calls `GET <url>/admin/config` and `GET <url>/admin/tokens` with the admin token, a 5000 ms timeout per call, a 5 MiB body cap and no redirects. It needs the `read` or `checks` scope and the `admin` scope; an api without token routes (`404`) is accepted with a notice. The connection test reads only the revision and the check ids of `GET /admin/config`, so it works with pulse-api before and after admin checks moved to its database. Finish setup saves the owner (argon2id hash) and the URL in one transaction, starts an `enrol` session for the owner and redirects to `/account/authenticator` (see "Second factor").

After setup the saved API URL is the one in use. A different `PULSE_API_URL` logs `warn` `PULSE_API_URL differs from the API URL saved at setup; the saved URL is used`, without a URL. The setup routes then answer `404`, also after a restart.

## Database

The console keeps its state in one SQLite file at `PULSE_CONSOLE_DB`. A new file is created with mode `0600`; an existing file is set to `0600`. SQLite gives the `-wal` and `-shm` files the same mode. The database uses WAL, foreign keys and a busy timeout of 5000 ms; its schema version is in `PRAGMA user_version` (now `2`). Migration 2 adds the session `stage` and `next_path`, the tables `authenticators`, `pending_authenticators` and `recovery_codes`, and deletes every schema-1 session: those never had a second factor. The owner, the password hash and the API URL stay. A file that cannot be opened, is not a database or has a newer schema stops the start; it is never replaced by a fresh database. The database never holds the api token, a setup code or grant, a password or a plain session id. Postgres and `DATABASE_URL` are not supported (`DATABASE_URL` is ignored).

The start opens the database before it prints a setup code, so a database error never shows a code. Expired sessions are deleted at start and at every new session: full sessions 30 days after their last use, partial sessions and pending authenticators 900000 ms after creation.

Reset: stop the console, delete the file with its `-wal` and `-shm` files, and start again; this prints a new setup code. Backup: copy the file while the console is stopped, or run `sqlite3 <file> ".backup <copy>"`; remove `-wal` and `-shm` on restore.

## Admin token

The admin token is optional at start. Without it the setup page shows how to set it, and setup cannot complete. Set at most one of `PULSE_CONSOLE_ADMIN_TOKEN` and `PULSE_CONSOLE_ADMIN_TOKEN_FILE`. With `_FILE`, the console reads the named file once at start and trims its content; use it for Docker or Compose secrets.

When set, the value follows the api's admin token rules, so an accepted value can be an api admin token. The rules run in this order:

| Rule                                        | `PULSE_CONSOLE_ADMIN_TOKEN`                                                                           | `PULSE_CONSOLE_ADMIN_TOKEN_FILE=<path>`                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| both settings set                           | `set only one of PULSE_CONSOLE_ADMIN_TOKEN and PULSE_CONSOLE_ADMIN_TOKEN_FILE` (the file is not read) | same                                                          |
| file cannot be read                         |                                                                                                       | `PULSE_CONSOLE_ADMIN_TOKEN_FILE=<path>: cannot read (<code>)` |
| file is empty                               |                                                                                                       | `…: file is empty`                                            |
| one line                                    |                                                                                                       | `…: must hold one line`                                       |
| at least 32 characters                      | `PULSE_CONSOLE_ADMIN_TOKEN must hold at least 32 characters`                                          | `…: must hold at least 32 characters`                         |
| no whitespace                               | `PULSE_CONSOLE_ADMIN_TOKEN must not contain whitespace`                                               | `…: must not contain whitespace`                              |
| printable ASCII without space (`\x21-\x7e`) | `PULSE_CONSOLE_ADMIN_TOKEN must hold printable ASCII`                                                 | `…: must hold printable ASCII`                                |
| not starting with `replace-with-`           | `PULSE_CONSOLE_ADMIN_TOKEN still has the example placeholder`                                         | `…: still has the example placeholder`                        |
| not a public example token of the api       | `PULSE_CONSOLE_ADMIN_TOKEN is a public example token: generate your own`                              | `…: is a public example token: generate your own`             |

The token value and the file content never appear in a log line, an error, `/metrics`, the page or a response header. A file error names the path and the error code only. The start log line `pulse-console listening` carries `host`, `port`, the origin of the API URL in use, `hasAdminToken` (`true` or `false`), `hasSecretKey` (`true` or `false`), `mode` and `isSetUp`, and no other setting value.

## Secret key

`PULSE_CONSOLE_SECRET_KEY_FILE` names a file with the key that encrypts TOTP seeds at rest. The console reads it once at start, after the admin token. After dropping exactly one trailing `\n` it must hold exactly 64 lowercase hex characters (32 bytes), and it must differ from the admin token. The key is never stored in SQLite, logged or sent. Seeds are sealed with AES-256-GCM, a fresh 12-byte nonce, a 16-byte tag and the additional data `pulse-console:totp:v1:user:<user id>`, stored as `v1:<nonce>:<ciphertext>:<tag>` in base64url.

Unset: the start logs `warn` `PULSE_CONSOLE_SECRET_KEY_FILE is not set: authenticator enrolment and TOTP sign-in are unavailable`. Enrolment and a TOTP code then answer `503`; recovery codes still work. A seed that the key cannot open answers `500` (`The authenticator secret cannot be read. Sign in with a recovery code.`), logs `error` `authenticator secret cannot be decrypted` with `userId`, does not count as a failed guess and never changes the stored seed. Back up the database and the key file together.

## In the pulse Compose stack

In pulse-api's `compose.yaml`, `PULSE_CONSOLE_PORT` is also the Compose variable for the host port. Compose does not pass `.env` values into the container, so the container always listens on the image default `8082`, and the host port `${PULSE_CONSOLE_PORT:-8082}` on `127.0.0.1` is mapped to it. Compose sets `PULSE_API_URL: http://api:3000`. See the [pulse-api configuration](https://github.com/lorenzh/pulse-api/blob/main/docs/configuration.md).

## Image defaults

The image sets `NODE_ENV=production`, `PULSE_CONSOLE_HOST=0.0.0.0` and `PULSE_CONSOLE_DB=/data/console.db`, has a `/data` directory owned by `bun`, exposes `8082`, runs as the user `bun` and has a health check on `/healthz`. `bun start` outside the image listens on `127.0.0.1`.

## HTTP routes

The routes and their answers before and after setup are in the [README](../README.md#http-endpoints).

The path is the raw request target up to the first `?`, compared byte for byte. It is not decoded or normalised, so `/index.html`, `//healthz`, `/%2e%2e/`, `/./` and `/healthz/` are `404`. An unknown path answers `404` for every method; a known path with another method answers `405` with `allow` and an empty body. The ops routes `/healthz`, `/readyz` and `/metrics` accept `GET` and `HEAD` and every `Host`.

A form POST fails at the first broken rule, in this order: route and method (`404`, `405`); phase, a setup route after setup, or `POST /sign-in` or a second-factor or account route before it (`404`); the loopback `Host` (`421`); the access gate after setup (`303`, no body is read); `Origin` (`403`); a content type other than `application/x-www-form-urlencoded` (`415`); a body over 8192 bytes (`413`); a repeated known field (`400`, unknown fields are ignored); the CSRF token (`403`, the session's token on routes behind the gate); the setup grant for `/setup/owner` (`403`); field format (`422`); the secret key (`503`); the throttle (`429`); verification (`401`); the connection test (`502`); state (`409`); the commit (`200`, `303`, `409` or `500`).

`/metrics` has `pulse_up`, `pulse_console_http_requests_total` with the labels `path` (`/`, `/healthz`, `/readyz`, `/metrics`, `/setup`, `/setup/owner`, `/sign-in`, `/sign-out`, `/console.css`, `/sign-in/factor`, `/account/authenticator`, `/account/security`, `/account/recovery-codes`, `/account/sessions`, `/account/sessions/sign-out-all` or `other`) and `code`, and `pulse_console_auth_attempts_total` with `kind` (`sign-in` for the password step, `setup-code`, `totp`, `recovery-code`, `enrolment`, `password-confirm`) and `result` (`success`, `failure`, `throttled`).

New log lines: `info` `setup complete` with `apiOrigin` and `checks`; `warn` `setup code refused` with `client` and `reason` (`credentials` or `throttled`); `info` `password accepted` with `userId` and `stage`; `warn` `sign-in failed` with `client` and `reason` (`credentials` or `throttled`); `info` `signed in` with `userId` and `factor` (`totp` or `recovery-code`, then also `remaining`); `warn` `second factor failed` with `client`, `kind` and `reason`; `warn` `password confirmation failed` with `client` and `reason`; `info` `authenticator confirmed` with `userId`; `error` `authenticator secret cannot be decrypted` with `userId`. No log line holds a password, an email, the token, a grant, a session id, a CSRF token, a seed, a setup key, a TOTP or recovery code, the secret key or the setup code.

## Sign-in and sessions

`POST /sign-in` takes `email`, `password` and an optional `next`. An empty field or a password over 128 code points answers `422` and does not count. A wrong password and an unknown email give the same `401` page (`Wrong email or password.`); an unknown email is verified against a dummy hash, so both take the same time. 5 failures in 15 minutes lock the account and, separately, the client address (the socket peer; forwarding headers are ignored) for 15 minutes: `429` with `Retry-After`. Success clears the account failures only. Each table holds at most 10000 keys.

A correct password deletes the old session of the browser and the expired rows, makes a new 32-byte session id and a CSRF token, and starts a session in the stage that the second-factor policy gives: `factor` (an authenticator exists, `303` to `/sign-in/factor`) or `enrol` (the owner has none, `303` to `/account/authenticator`). The owner must always have a second factor. A partial session stores `next` when it is a local path (it starts with one `/` that is not followed by `/` or `\`), else `/`, and the second factor redirects there. The database keeps only the SHA-256 digest of the session id. A session ends 30 days (2592000000 ms) after its last use; a request at least 60 seconds after the last use updates it and sends the cookie again with the same value. Sessions survive a restart. An invalid session cookie on `GET /sign-in` shows `Your session has expired.` and deletes the cookie. `POST /sign-out` needs the session's CSRF token; it deletes the row and the cookie. Without a session it answers `303` and changes nothing.

## Second factor

Session stages: `factor` (password proven, second factor pending), `enrol` (password proven, no authenticator yet) and `full`. Only `full` opens protected pages. A partial session lives 900000 ms from creation, is never extended and its cookie has `Max-Age=900`. A `full` row of an owner without an authenticator counts as `enrol`.

After setup every app route declares the stage it needs, and one gate checks it after the loopback `Host` and before `Origin` and the body. No session on a full or enrolment route: `303` to `/sign-in?next=<encoded path>`; no session on `/sign-in/factor`: `303` to `/sign-in`; a `factor` session elsewhere: `303` to `/sign-in/factor`; an `enrol` session elsewhere: `303` to `/account/authenticator`; a `full` session on `/sign-in/factor`: `303` to `/`. Before setup the gate does not run and the second-factor and account routes answer `404`.

TOTP: RFC 6238, HMAC-SHA-1, 6 digits, 30 seconds, T0 = 0. Steps `c - 1`, `c` and `c + 1` are accepted when they are above the stored last step; the lowest match is stored in the same transaction as the sign-in, so each code works once, also across browsers, restarts and a clock that goes back. Input is trimmed and spaces are removed; anything other than 6 digits, or a field over 64 characters, answers `422` and does not count. A seed is 20 random bytes; the setup key is its base32 text (32 characters, shown in groups of 4) with the `otpauth://` URI as text. Keep server and phone clocks in sync (NTP).

Recovery codes: ten distinct codes of 16 random bytes, shown once as 8 groups of 4 lowercase hex characters joined by `-`. Only the SHA-256 digest of each normalised code is stored. Input is trimmed, spaces and `-` removed and lowercased; anything but 32 hex characters answers `422`. A code replaces only the TOTP step, never the password. Its lookup, timing-safe comparison and use run in one `BEGIN IMMEDIATE` transaction, so one code works once, also in parallel.

`/sign-in/factor` takes `code` or `recovery_code` (exactly one, else `422` `Enter the code from your authenticator app or a recovery code.`). Order after CSRF: format (`422`), the key for a TOTP code (`503`), the factor throttle (`429`), verification (`401` `Wrong code.`), a decryption failure (`500`), commit (`303` with a new session id, or `303` to `/sign-in` when the factor session ended meanwhile).

`/account/authenticator`: `action=new` creates or replaces the pending setup key of this session (live 900000 ms). From a full session it needs the current password (`422` empty or over 128 code points, then `503` without the key, then the password throttle `429`, wrong `401`). `action=confirm` with `code`: format (`422`), key (`503`), factor throttle (`429`), a live pending key (else `409` `The setup key expired. Create a new one.`), the code (`401`). Success replaces the authenticator and the recovery codes, ends every session of the owner and starts a new full one for this browser in one transaction, and answers `200` with the ten codes and a "Continue" link.

The factor throttle is separate from the password throttle: 5 failures of TOTP, recovery codes and enrolment confirmation in 15 minutes lock the account and the client for 15 minutes (`429` with `Retry-After`). A correct password does not clear it; a successful second factor clears only the account failures.

Known limits: the setup, sign-in and factor throttles live in memory, so a restart clears them. There is no global cap on concurrent argon2id verifications; the throttle bounds them per account and client.

On `SIGTERM` or `SIGINT` the console turns not ready, stops accepting connections, closes idle ones and exits `0` after a clean stop. Open requests get 5000 ms; a stop that takes longer logs a warning and exits `1`.

## Cookies

| Cookie                  | Set by               | Max-Age                                                               |
| ----------------------- | -------------------- | --------------------------------------------------------------------- |
| `pulse_console_csrf`    | a GET of a form page | none                                                                  |
| `pulse_console_setup`   | a correct setup code | `1800`                                                                |
| `pulse_console_session` | a correct sign-in    | `2592000` for a full session, `900` for a `factor` or `enrol` session |

Every cookie has `Path=/; HttpOnly; SameSite=Strict` and no `Domain`. In strict-https mode each name gets the `__Host-` prefix and the cookie gets `Secure`. Every form holds the CSRF token as `<input type="hidden" name="csrf" value="<token>">`.

## Security headers

Every response, including ops routes, `404` and `405`, carries:

- `content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
- `x-content-type-options: nosniff`
- `x-frame-options: DENY`
- `referrer-policy: same-origin`: a browser sends the real `Origin` on a same-origin form POST, and no referrer to another origin. With `no-referrer` a browser sends `Origin: null`, which the Origin check refuses.

Pages also carry `cache-control: no-store`. They load only `/console.css`: no script, no inline style and no external asset.
