/* eslint-disable sonarjs/no-clear-text-protocols -- loopback test servers and URL inputs under test */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, StartupError } from "@lorenzh/pulse-kit";
import { createAccountStore } from "./account-store.ts";
import { openDatabase } from "./database.ts";
import { createMetrics, type Metrics } from "./metrics.ts";
import { createConsoleServer, listen } from "./server.ts";
import { createSetupGate } from "./setup-code.ts";

const HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

interface Running {
  base: string;
  port: number;
  metrics: Metrics;
}

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const s of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections();
    });
  }
});

function depsFor(metrics: Metrics): Parameters<typeof createConsoleServer>[0] {
  const dir = mkdtempSync(join(tmpdir(), "console-server-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "console.db"), {
    createFile: (path, mode) => closeSync(openSync(path, "wx", mode)),
    chmod: chmodSync,
  });
  const bytes = (size: number): Uint8Array => new Uint8Array(size).fill(7);
  return {
    metrics,
    log: createLogger({ level: "error", write: () => undefined }),
    mode: "loopback",
    publicOrigin: undefined,
    defaultApiUrl: "http://api.invalid:3000",
    adminToken: undefined,
    store: createAccountStore(db),
    gate: createSetupGate({ now: () => 0, randomBytes: bytes }).gate,
    now: () => 0,
    randomBytes: bytes,
    hashPassword: () => Promise.reject(new Error("not used")),
    verifier: { verify: () => Promise.reject(new Error("not used")) },
    fetch: () => Promise.reject(new Error("no network in this test")),
  };
}

async function start(): Promise<Running> {
  const metrics = createMetrics();
  const server = createConsoleServer(depsFor(metrics));
  servers.push(server);
  const port = await listen(server, "127.0.0.1", 0);
  return { base: `http://127.0.0.1:${port}`, port, metrics };
}

function expectSecurityHeaders(res: Response): void {
  for (const [name, value] of Object.entries(HEADERS)) expect(res.headers.get(name)).toBe(value);
}

/** Sends one request line as written, without fetch's path normalisation. */
function rawRequest(port: number, head: string, body = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.on("connect", () => socket.write(`${head}\r\n\r\n${body}`));
    socket.on("data", (chunk) => {
      data += String(chunk);
      // One response is enough; the header block ends with an empty line.
      if (data.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("error", reject);
  });
}

async function metricsText(base: string): Promise<string> {
  return (await fetch(`${base}/metrics`)).text();
}

function requestSeries(text: string): string[] {
  return text.split("\n").filter((l) => l.startsWith("pulse_console_http_requests_total{"));
}

describe("app routes", () => {
  test("GET / before setup redirects to /setup with the security headers", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/setup");
    expectSecurityHeaders(res);
  });

  test("GET /setup serves the HTML page with the stylesheet link and no inline assets", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/setup`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expectSecurityHeaders(res);
    const html = await res.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain("pulse Console</title>");
    expect(html).toContain('<link rel="stylesheet" href="/console.css">');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<style");
    expect(html).not.toContain(" style=");
    expect(html).not.toMatch(/(?:src|href)="https?:/);
  });

  test("HEAD /setup answers the same headers without a body", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/setup`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expectSecurityHeaders(res);
    expect(await res.text()).toBe("");
  });

  test("GET /console.css serves the stylesheet", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/console.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expectSecurityHeaders(res);
    expect(await res.text()).toContain(":focus-visible");
  });
});

describe("ops routes", () => {
  test("/healthz and /readyz answer ok with the security headers", async () => {
    const { base } = await start();
    for (const path of ["/healthz", "/readyz"]) {
      const res = await fetch(base + path);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok\n");
      expectSecurityHeaders(res);
    }
    const head = await fetch(`${base}/readyz`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("after shutdown starts, /readyz is 503 and pulse_up is 0; /healthz stays ok", async () => {
    const { base, metrics } = await start();
    expect(await metricsText(base)).toContain("pulse_up 1");
    metrics.setShuttingDown();
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.text()).toBe("shutting down\n");
    expectSecurityHeaders(ready);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect(await metricsText(base)).toContain("pulse_up 0");
  });

  test("/metrics?x=1 is the metrics route", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/metrics?x=1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("pulse_up 1");
  });
});

describe("other paths and methods", () => {
  test("an unknown path is 404 and counts as other in one series", async () => {
    const { base } = await start();
    for (const path of ["/nope", "/nope2", "/index.html"]) {
      const res = await fetch(base + path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await res.text()).toBe("not found\n");
      expectSecurityHeaders(res);
    }
    const text = await metricsText(base);
    expect(text).toContain('pulse_console_http_requests_total{path="other",code="404"} 3');
    expect(text).not.toContain("/nope");
  });

  test("raw paths that a URL parser would normalise are 404", async () => {
    const { base, port } = await start();
    const paths = ["//healthz", "//", "/%2e%2e/", "/./", "/healthz/", "/%68ealthz", "/%2F"];
    for (const path of paths) {
      const answer = await rawRequest(port, `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close`);
      expect(answer.startsWith("HTTP/1.1 404 ")).toBe(true);
      expect(answer.toLowerCase()).toContain("x-frame-options: deny");
      expect(answer.toLowerCase()).toContain("content-security-policy: default-src 'none';");
    }
    const absolute = await rawRequest(
      port,
      "GET http://x/ HTTP/1.1\r\nHost: x\r\nConnection: close",
    );
    expect(absolute.startsWith("HTTP/1.1 404 ")).toBe(true);
    const series = requestSeries(await metricsText(base));
    expect(series).toEqual([
      `pulse_console_http_requests_total{path="other",code="404"} ${paths.length + 1}`,
    ]);
  });

  test("other methods are 405 with the allowed methods of the route", async () => {
    const { base } = await start();
    for (const [method, path, allow] of [
      ["POST", "/", "GET, HEAD"],
      ["DELETE", "/readyz", "GET, HEAD"],
      ["PUT", "/metrics", "GET, HEAD"],
      ["PUT", "/setup", "GET, HEAD, POST"],
      ["GET", "/sign-out", "POST"],
    ] as const) {
      const res = await fetch(base + path, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe(allow);
      expect(await res.text()).toBe("");
      expectSecurityHeaders(res);
    }
  });

  test("a POST with a 10 MB body is answered 405 without reading the body", async () => {
    const { port } = await start();
    const answer = await rawRequest(
      port,
      "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10485760",
      "x".repeat(1024),
    );
    expect(answer.startsWith("HTTP/1.1 405 ")).toBe(true);
    expect(answer.toLowerCase()).toContain("allow: get, head");
  });

  test("an unknown path is 404 for every method", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/nope`, { method: "PATCH" })).status).toBe(404);
  });

  test("/metrics counts responses by path label and code", async () => {
    const { base } = await start();
    await fetch(`${base}/`, { redirect: "manual" });
    await fetch(`${base}/setup`);
    await fetch(`${base}/console.css`);
    await fetch(`${base}/healthz`);
    await fetch(`${base}/readyz`);
    await fetch(`${base}/nope`);
    await fetch(`${base}/`, { method: "POST" });
    const text = await metricsText(base);
    expect(requestSeries(text).sort((a, b) => a.localeCompare(b))).toEqual([
      'pulse_console_http_requests_total{path="/",code="303"} 1',
      'pulse_console_http_requests_total{path="/",code="405"} 1',
      'pulse_console_http_requests_total{path="/console.css",code="200"} 1',
      'pulse_console_http_requests_total{path="/healthz",code="200"} 1',
      'pulse_console_http_requests_total{path="/readyz",code="200"} 1',
      'pulse_console_http_requests_total{path="/setup",code="200"} 1',
      'pulse_console_http_requests_total{path="other",code="404"} 1',
    ]);
  });
});

describe("listen", () => {
  test("an occupied port names both settings and the code only", async () => {
    const blocker = createHttpServer();
    servers.push(blocker);
    const port = await listen(blocker, "127.0.0.1", 0);
    const server = createConsoleServer(depsFor(createMetrics()));
    servers.push(server);
    const err: unknown = await listen(server, "127.0.0.1", port).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StartupError);
    expect(err instanceof Error ? err.message : "").toBe(
      `PULSE_CONSOLE_HOST/PULSE_CONSOLE_PORT: cannot listen on 127.0.0.1:${port} (EADDRINUSE)`,
    );
  });
});
