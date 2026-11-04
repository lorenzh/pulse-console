# pulse-console

pulse: Web console to manage checks, incidents, tokens, notify and status settings through the pulse-api admin API.

## What works now

The console is the fifth service of the pulse Compose stack. Today it serves:

- first-run setup: a one-time setup code from the container log unlocks `/setup/owner`. That page tests the connection to pulse-api (wire version and check count) and creates the one owner account in a local SQLite database;
- the sign-in page with the "Setup is complete" notice; password sign-in and sessions follow in the next step of [#562](https://github.com/lorenzh/pulse-meta/issues/562);
- the stylesheet `/console.css` and the ops routes `/healthz`, `/readyz` and `/metrics`.

Two-factor sign-in follows in [#563](https://github.com/lorenzh/pulse-meta/issues/563). Checks, incidents, tokens and the notify and status settings come in later items of [#460](https://github.com/lorenzh/pulse-meta/issues/460).

## First-run setup

1. Start the console with `PULSE_API_URL` and an admin token (`PULSE_CONSOLE_ADMIN_TOKEN_FILE`). The token needs the `read` or `checks` scope and the `admin` scope of pulse-api.
2. Find the setup code in the log: `docker logs <container> | grep 'setup code'`. The line is `pulse-console setup code: <code> (open /setup; a restart prints a new code)`. It is written to stdout outside the logger, so `PULSE_LOG_LEVEL` never hides it.
3. Open `/setup`, enter the code, then fill in the API URL, the owner email, name and password on `/setup/owner`. "Test connection" saves nothing; "Finish setup" tests again and saves.

After setup the saved API URL is used. A different `PULSE_API_URL` logs one warning at start and is ignored. There is no way to change the saved URL yet.

**Reset (destructive).** A lost password has no recovery yet. Stop the console, delete the database file at `PULSE_CONSOLE_DB` with its `-wal` and `-shm` files (or the `console-data` volume), and start again. The console prints a new setup code.

**Backup.** Copy the database file while the console is stopped, or use `sqlite3 console.db ".backup backup.db"` while it runs. On restore, remove any `-wal` and `-shm` files beside the restored file.

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
| `PULSE_LOG_LEVEL`                | `info`                         | `debug`, `info`, `warn` or `error`.                                                              |

An invalid setting stops the start with exit code 2 and one line on stderr. Every rule and error text is in [docs/configuration.md](docs/configuration.md).

## HTTP endpoints

| Path                | Before setup                                              | After setup                  |
| ------------------- | --------------------------------------------------------- | ---------------------------- |
| `GET /`             | `303` to `/setup`                                         | `303` to `/sign-in?next=%2F` |
| `GET /setup`        | `200`, the setup code form                                | `404`                        |
| `POST /setup`       | `303` to `/setup/owner` with a grant; `401`, `422`, `429` | `404`                        |
| `GET /setup/owner`  | `200` with a grant, else `303` to `/setup`                | `404`                        |
| `POST /setup/owner` | test: `200` or `502`; finish: `303`, `409` or `500`       | `404`                        |
| `GET /sign-in`      | `303` to `/setup`                                         | `200`, the sign-in form      |
| `POST /sign-out`    | `303` to `/sign-in`                                       | `303` to `/sign-in`          |
| `GET /console.css`  | `200`, `text/css`                                         | same                         |
| `GET /healthz`      | `200 ok`                                                  | same                         |
| `GET /readyz`       | `200 ok`; `503 shutting down` after `SIGTERM`             | same                         |
| `GET /metrics`      | Prometheus text                                           | same                         |
| any other path      | `404 not found`                                           | same                         |

`HEAD` works wherever `GET` does; another method on a known path answers `405` with `allow`. A finished setup redirects to `/sign-in?setup=done`. In loopback mode the app routes answer only a loopback `Host`. Every form POST checks `Origin` and a CSRF token. Cookies, modes, the POST order and the metrics are in [docs/configuration.md](docs/configuration.md). More in [docs/](docs/index.md).

## License

MIT, see [LICENSE](LICENSE).
