# Configuration

The console reads its settings from the environment once at start. An invalid setting stops the start with exit code 2 and one line on stderr, prefixed `pulse-console: `. The checks run in this order, and the first failure stops the start: `PULSE_LOG_LEVEL`, `PULSE_API_URL`, `PULSE_CONSOLE_PORT`, `PULSE_CONSOLE_HOST`, `PULSE_CONSOLE_PUBLIC_URL`, `PULSE_CONSOLE_DB`, the admin token. `DATABASE_URL` is not read. A value that is blank or only whitespace counts as unset.

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
| `PULSE_CONSOLE_DB` | schema newer than this console | `pulse-console: PULSE_CONSOLE_DB=<path>: schema version <n> is newer than this console (1)` |

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

The setup form takes the API URL (the `PULSE_API_URL` rules, at most 2048 characters, one trailing `/` dropped, a path prefix kept), the owner email (trimmed, lowercased, 3 to 254 characters, one `@`), the name (1 to 100 characters) and the password (12 to 128 code points, not trimmed) twice. The connection test calls `GET <url>/admin/config` and `GET <url>/admin/tokens` with the admin token, a 5000 ms timeout per call, a 5 MiB body cap and no redirects. It needs the `read` or `checks` scope and the `admin` scope; an api without token routes (`404`) is accepted with a notice. Finish setup saves the owner (argon2id hash) and the URL in one transaction, then redirects to `/sign-in?setup=done`.

After setup the saved API URL is the one in use. A different `PULSE_API_URL` logs `warn` `PULSE_API_URL differs from the API URL saved at setup; the saved URL is used`, without a URL. The setup routes then answer `404`, also after a restart.

## Database

The console keeps its state in one SQLite file at `PULSE_CONSOLE_DB`. A new file is created with mode `0600`; an existing file is set to `0600`. SQLite gives the `-wal` and `-shm` files the same mode. The database uses WAL, foreign keys and a busy timeout of 5000 ms; its schema version is in `PRAGMA user_version` (now `1`). A file that cannot be opened, is not a database or has a newer schema stops the start; it is never replaced by a fresh database. The database never holds the api token, a setup code or grant, a password or a plain session id. Postgres and `DATABASE_URL` are not supported.

The start opens the database before it prints a setup code, so a database error never shows a code. Expired sessions are deleted at start.

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

The token value and the file content never appear in a log line, an error, `/metrics`, the page or a response header. A file error names the path and the error code only. The start log line `pulse-console listening` carries `host`, `port`, the origin of the API URL in use, `hasAdminToken` (`true` or `false`), `mode` and `isSetUp`, and no other setting value.

## In the pulse Compose stack

In pulse-api's `compose.yaml`, `PULSE_CONSOLE_PORT` is also the Compose variable for the host port. Compose does not pass `.env` values into the container, so the container always listens on the image default `8082`, and the host port `${PULSE_CONSOLE_PORT:-8082}` on `127.0.0.1` is mapped to it. Compose sets `PULSE_API_URL: http://api:3000`. See the [pulse-api configuration](https://github.com/lorenzh/pulse-api/blob/main/docs/configuration.md).

## Image defaults

The image sets `NODE_ENV=production`, `PULSE_CONSOLE_HOST=0.0.0.0` and `PULSE_CONSOLE_DB=/data/console.db`, has a `/data` directory owned by `bun`, exposes `8082`, runs as the user `bun` and has a health check on `/healthz`. `bun start` outside the image listens on `127.0.0.1`.

## HTTP routes

The routes and their answers before and after setup are in the [README](../README.md#http-endpoints).

The path is the raw request target up to the first `?`, compared byte for byte. It is not decoded or normalised, so `/index.html`, `//healthz`, `/%2e%2e/`, `/./` and `/healthz/` are `404`. An unknown path answers `404` for every method; a known path with another method answers `405` with `allow` and an empty body. The ops routes `/healthz`, `/readyz` and `/metrics` accept `GET` and `HEAD` and every `Host`.

A form POST fails at the first broken rule, in this order: route and method (`404`, `405`); phase, a setup route after setup or `POST /sign-in` before it (`404`); the loopback `Host` (`421`); `Origin` (`403`); a content type other than `application/x-www-form-urlencoded` (`415`); a body over 8192 bytes (`413`); a repeated known field (`400`, unknown fields are ignored); the CSRF token (`403`); the setup grant for `/setup/owner` (`403`); field format (`422`); the throttle (`429`); verification (`401`); the connection test (`502`); the commit (`303`, `409` or `500`).

`/metrics` has `pulse_up`, `pulse_console_http_requests_total` with the labels `path` (`/`, `/healthz`, `/readyz`, `/metrics`, `/setup`, `/setup/owner`, `/sign-in`, `/sign-out`, `/console.css` or `other`) and `code`, and `pulse_console_auth_attempts_total` with `kind` (`sign-in`, `setup-code`) and `result` (`success`, `failure`, `throttled`).

New log lines: `info` `setup complete` with `apiOrigin` and `checks`, and `warn` `setup code refused` with `client` and `reason` (`credentials` or `throttled`). No log line holds a password, an email, the token, a grant or the code.

On `SIGTERM` or `SIGINT` the console turns not ready, stops accepting connections, closes idle ones and exits `0` after a clean stop. Open requests get 5000 ms; a stop that takes longer logs a warning and exits `1`.

## Cookies

| Cookie                  | Set by               | Max-Age   |
| ----------------------- | -------------------- | --------- |
| `pulse_console_csrf`    | a GET of a form page | none      |
| `pulse_console_setup`   | a correct setup code | `1800`    |
| `pulse_console_session` | sign-in (next step)  | `2592000` |

Every cookie has `Path=/; HttpOnly; SameSite=Strict` and no `Domain`. In strict-https mode each name gets the `__Host-` prefix and the cookie gets `Secure`. Every form holds the CSRF token as `<input type="hidden" name="csrf" value="<token>">`.

## Security headers

Every response, including ops routes, `404` and `405`, carries:

- `content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
- `x-content-type-options: nosniff`
- `x-frame-options: DENY`
- `referrer-policy: no-referrer`

Pages also carry `cache-control: no-store`. They load only `/console.css`: no script, no inline style and no external asset.
