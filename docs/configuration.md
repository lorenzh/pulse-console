# Configuration

The console reads its settings from the environment once at start. An invalid setting stops the start with exit code 2 and one line on stderr, prefixed `pulse-console: `. The checks run in this order, and the first failure stops the start: `PULSE_LOG_LEVEL`, `PULSE_API_URL`, `PULSE_CONSOLE_PORT`, `PULSE_CONSOLE_HOST`, `PULSE_CONSOLE_PUBLIC_URL`, `PULSE_CONSOLE_DB`, the admin token. `DATABASE_URL` is not read. A value that is blank or only whitespace counts as unset.

## Settings

| Setting                          | Default               | Rule                                                                                                                                                       |
| -------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PULSE_API_URL`                  | none, required        | Trimmed. No whitespace or control character inside. Then `http:` or `https:`, a host, no credentials, no query or fragment. One trailing slash is dropped. |
| `PULSE_CONSOLE_PORT`             | `8082`                | Integer from 0 to 65535. `0` takes any free port.                                                                                                          |
| `PULSE_CONSOLE_HOST`             | `127.0.0.1`           | Listen address. The image sets `0.0.0.0`.                                                                                                                  |
| `PULSE_CONSOLE_PUBLIC_URL`       | unset (loopback mode) | The console's public origin. The `PULSE_API_URL` rules, and no path other than `/`. Selects the mode, see below.                                           |
| `PULSE_CONSOLE_DB`               | `./console.db`        | Path of the SQLite database file. Trimmed; blank counts as unset.                                                                                          |
| `PULSE_CONSOLE_ADMIN_TOKEN`      | unset                 | Optional. The token rules below.                                                                                                                           |
| `PULSE_CONSOLE_ADMIN_TOKEN_FILE` | unset                 | Optional. Path to a file with the token; the content is trimmed, then the token rules apply.                                                               |
| `PULSE_LOG_LEVEL`                | `info`                | `debug`, `info`, `warn` or `error`.                                                                                                                        |

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
- `strict-http`: `http:` with any other host.

## Database

The console keeps its state in one SQLite file at `PULSE_CONSOLE_DB`. A new file is created with mode `0600`; an existing file is set to `0600`. SQLite gives the `-wal` and `-shm` files the same mode. The database uses WAL, foreign keys and a busy timeout of 5000 ms; its schema version is in `PRAGMA user_version` (now `1`). A file that cannot be opened, is not a database or has a newer schema stops the start; it is never replaced by a fresh database. The database never holds the api token, a setup code or grant, a password or a plain session id. Postgres and `DATABASE_URL` are not supported.

This version has the settings and the database module; the start does not open the database yet, and the mode does not change any request yet. Setup and sign-in follow.

## Admin token

The admin token is optional in this version: the console makes no API call yet. Set at most one of `PULSE_CONSOLE_ADMIN_TOKEN` and `PULSE_CONSOLE_ADMIN_TOKEN_FILE`. With `_FILE`, the console reads the named file once at start and trims its content; use it for Docker or Compose secrets.

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

The token value and the file content never appear in a log line, an error, `/metrics`, the page or a response header. A file error names the path and the error code only. The start log line `pulse-console listening` carries `host`, `port`, the origin of `PULSE_API_URL` and `hasAdminToken` (`true` or `false`), and no other setting value.

## In the pulse Compose stack

In pulse-api's `compose.yaml`, `PULSE_CONSOLE_PORT` is also the Compose variable for the host port. Compose does not pass `.env` values into the container, so the container always listens on the image default `8082`, and the host port `${PULSE_CONSOLE_PORT:-8082}` on `127.0.0.1` is mapped to it. Compose sets `PULSE_API_URL: http://api:3000`. See the [pulse-api configuration](https://github.com/lorenzh/pulse-api/blob/main/docs/configuration.md).

## Image defaults

The image sets `NODE_ENV=production` and `PULSE_CONSOLE_HOST=0.0.0.0`, exposes `8082`, runs as the user `bun` and has a health check on `/healthz`. `bun start` outside the image listens on `127.0.0.1`.

## HTTP routes

- `/`: `200`, `text/html; charset=utf-8`, `cache-control: no-store`. The query string is ignored.
- `/healthz`: `200 ok`, always.
- `/readyz`: `200 ok` while running; `503 shutting down` after `SIGTERM` or `SIGINT`.
- `/metrics`: `200`, Prometheus text. `pulse_up` is 1 when ready and 0 while shutting down. `pulse_console_http_requests_total` counts responses with the labels `path` and `code`; `path` is one of `/`, `/healthz`, `/readyz`, `/metrics` and `other`.
- Any other path: `404`, `text/plain; charset=utf-8`, `not found`.

The path is the raw request target up to the first `?`, compared byte for byte. It is not decoded or normalised, so `/index.html`, `//healthz`, `/%2e%2e/`, `/./` and `/healthz/` are `404`. `GET` and `HEAD` are the only methods; any other method answers `405` with `allow: GET, HEAD` and an empty body, on every path. The console reads no request body.

On `SIGTERM` or `SIGINT` the console turns not ready, stops accepting connections, closes idle ones and exits `0` after a clean stop. Open requests get 5000 ms; a stop that takes longer logs a warning and exits `1`.

## Security headers

Every response, including ops routes, `404` and `405`, carries:

- `content-security-policy: default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
- `x-content-type-options: nosniff`
- `x-frame-options: DENY`
- `referrer-policy: no-referrer`

The page loads no script, style, font or image.
