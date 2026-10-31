# pulse-console

pulse: Web console to manage checks, incidents, tokens, notify and status settings through the pulse-api admin API.

## What works now

The console is the fifth service of the pulse Compose stack. Today it serves:

- one page, "pulse Console", at `/`. It says that the Console is set up and has nothing to manage yet;
- the ops routes `/healthz`, `/readyz` and `/metrics`.

It makes no API call yet. Login, checks, incidents, tokens and the notify and status settings come in later items of [#460](https://github.com/lorenzh/pulse-meta/issues/460).

## Run locally

```sh
bun install --frozen-lockfile
PULSE_API_URL=http://localhost:3000 bun start
```

Open <http://127.0.0.1:8082>. Bun runs the TypeScript source directly (no build step).

## Run with Docker

```sh
docker build --tag pulse-console:local .
docker run --rm -p 127.0.0.1:8082:8082 -e PULSE_API_URL=http://api:3000 pulse-console:local
```

Released images are published as `ghcr.io/lorenzh/pulse-console` for `linux/amd64` and `linux/arm64`, with the tags `X.Y.Z`, `X.Y` and `X` (no `latest`):

```sh
docker pull ghcr.io/lorenzh/pulse-console:0.1.0
docker run --rm -p 127.0.0.1:8082:8082 -e PULSE_API_URL=http://api:3000 ghcr.io/lorenzh/pulse-console:0.1.0
```

Pin a setup to `X.Y.Z` by digest. How a release is cut and verified is in [docs/development.md](docs/development.md#releasing).

The image listens on `0.0.0.0:8082` inside the container and runs as the non-root user `bun`. In the pulse Compose stack (pulse-api `compose.yaml`) the console is published on host loopback only.

## Settings

| Setting                          | Default                        | Meaning                                                                           |
| -------------------------------- | ------------------------------ | --------------------------------------------------------------------------------- |
| `PULSE_API_URL`                  | none, required                 | Base URL of pulse-api, `http` or `https`, without credentials, query or fragment. |
| `PULSE_CONSOLE_PORT`             | `8082`                         | Listen port.                                                                      |
| `PULSE_CONSOLE_HOST`             | `127.0.0.1` (image: `0.0.0.0`) | Listen address.                                                                   |
| `PULSE_CONSOLE_ADMIN_TOKEN`      | unset                          | Optional pulse-api admin token. Never logged.                                     |
| `PULSE_CONSOLE_ADMIN_TOKEN_FILE` | unset                          | File that holds the admin token, instead of `PULSE_CONSOLE_ADMIN_TOKEN`.          |
| `PULSE_LOG_LEVEL`                | `info`                         | `debug`, `info`, `warn` or `error`.                                               |

An invalid setting stops the start with exit code 2 and one line on stderr. Every rule and error text is in [docs/configuration.md](docs/configuration.md).

## HTTP endpoints

| Path           | Answer                                                            |
| -------------- | ----------------------------------------------------------------- |
| `GET /`        | `200`, the HTML page.                                             |
| `GET /healthz` | `200 ok`.                                                         |
| `GET /readyz`  | `200 ok`; `503 shutting down` after `SIGTERM` or `SIGINT`.        |
| `GET /metrics` | Prometheus text: `pulse_up`, `pulse_console_http_requests_total`. |
| any other path | `404 not found`.                                                  |
| other methods  | `405` with `allow: GET, HEAD`.                                    |

`HEAD` works wherever `GET` does. More in [docs/](docs/index.md).

## License

MIT, see [LICENSE](LICENSE).
