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
import { createFactorStore } from "./factor-store.ts";
import { createMetrics, type Metrics } from "./metrics.ts";
import { createConsoleServer, listen, TestRouteError } from "./server.ts";
import { createSetupGate } from "./setup-code.ts";
import { createTeamStore } from "./team-store.ts";

const TEST_SECRET_KEY = Uint8Array.from(Buffer.from("0123456789abcdef".repeat(4), "hex"));

const HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
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
    instanceName: "pulse Console",
    metrics,
    log: createLogger({ level: "error", write: () => undefined }),
    mode: "loopback",
    publicOrigin: undefined,
    defaultApiUrl: "http://api.invalid:3000",
    adminToken: undefined,
    store: createAccountStore(db),
    factorStore: createFactorStore(db),
    teamStore: createTeamStore(db),
    secretKey: TEST_SECRET_KEY,
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
    const css = await res.text();
    for (const rule of [
      ".type-choice li.panel { padding: 14px 16px; overflow-wrap: anywhere; }",
      "ul.counts { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 4px; }",
      ".check-state-maintenance .dot {",
      ".tag-info { color: var(--accent2); background: var(--bg); }",
      "td.num, th.num { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }",
    ]) {
      expect(css).toContain(rule);
    }
    expect(css).toContain(
      ":focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }",
    );
    expect(css).toContain(
      '.confirm input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"])[name="confirm_name"] { font-family: var(--font-mono); }',
    );
    for (const part of [
      "color-scheme: light dark",
      "@media (prefers-color-scheme: dark)",
      "--bg: #f2eeec",
      "--bg: #271b32",
      "--error: #a4262c",
      "--error: #f2a7ab",
      "--touch: 44px",
      "[hidden] { display: none !important; }",
      '--font-sans: "Space Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif',
      '--font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      "@media (max-width: 1180px) {\n  .grid-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }",
      "@media (max-width: 900px) {\n  dl.settings, .settings { grid-template-columns: minmax(0, 1fr); }\n  .grid-2, .grid-4, .form-grid { grid-template-columns: minmax(0, 1fr); }",
      "@media (max-width: 719px) {\n  .shell { grid-template-columns: minmax(0, 1fr); }",
      "main.shell-main { padding: 20px 16px 40px; }",
      ".sidebar nav { display: flex; flex-wrap: nowrap; overflow-x: auto; padding: 6px; scroll-padding-inline: 6px; scroll-snap-type: x mandatory; gap: 0; background:",
      ".sidebar nav ul { flex-direction: row; flex-wrap: nowrap; flex: none;",
      ".sidebar nav .nav-item { display: inline-flex; flex-direction: row; align-items: center; gap: 8px; white-space: nowrap; flex: 0 0 auto; padding: 0 8px; }\n  .sidebar nav .nav-item:focus { scroll-snap-align: center; }",
      "background-attachment: local, local, scroll, scroll; }\n  .sidebar nav ul",
      ".account { flex: 1 0 auto; max-width: 100%;",
      ".account-email { display: inline-block; max-width: 100%; overflow-wrap: anywhere; }",
      ".shell { display: grid; grid-template-columns: 236px minmax(0, 1fr);",
    ]) {
      expect(css).toContain(part);
    }
    expect(css).not.toContain(".sidebar nav .icon { display: none; }");
    expect(css).not.toContain("flex-direction: column; justify-content: center;");
    expect(css.startsWith("[hidden] { display: none !important; }\n")).toBe(true);
    expect(css.split("@font-face").length - 1).toBe(7);
    expect(css.split("font-display: swap").length - 1).toBe(7);
    expect(css.split("url(").length - 1).toBe(7);
    for (const url of [
      'url("/fonts/space-grotesk-latin-400-normal.woff2") format("woff2")',
      'url("/fonts/space-grotesk-latin-500-normal.woff2") format("woff2")',
      'url("/fonts/space-grotesk-latin-600-normal.woff2") format("woff2")',
      'url("/fonts/space-grotesk-latin-700-normal.woff2") format("woff2")',
      'url("/fonts/jetbrains-mono-latin-400-normal.woff2") format("woff2")',
      'url("/fonts/jetbrains-mono-latin-500-normal.woff2") format("woff2")',
      'url("/fonts/jetbrains-mono-latin-600-normal.woff2") format("woff2")',
    ]) {
      expect(css.split(url).length - 1).toBe(1);
    }
    for (const banned of [
      "@import",
      "data:",
      "local(",
      "1b4f9c",
      "e3a008",
      "overflow-x: hidden",
      "overflow: hidden; }\nbody",
      "outline-offset: -",
    ]) {
      expect(css).not.toContain(banned);
    }
    expect(css).not.toMatch(/(?:^|\n)(?:html|body|:root)[^{]*\{[^}]*overflow(?:-x)?: hidden/);
    expect(Buffer.byteLength(css)).toBeLessThanOrEqual(49152);
  });

  test("GET /console.css holds every R3 :visited rule with its color, none inside @media", async () => {
    const { base } = await start();
    const css = await (await fetch(`${base}/console.css`)).text();
    const expected: Record<string, string> = {
      "a:visited": "var(--accent-text)",
      "a.button:visited": "var(--on-strong)",
      "a.button.secondary:visited": "var(--text)",
      "a.button.ghost:visited": "var(--text)",
      "a.button.danger:visited": "var(--bg)",
      ".callout a:not(.button):visited": "var(--text)",
      ".nav-item:visited": "var(--lead)",
      '.nav-item[aria-current="page"]:visited': "var(--text)",
      ".breadcrumbs a:visited": "var(--muted)",
    };
    const seen = new Map<string, string>();
    const tokens = css.match(/[{}]|[^{}]+/g) ?? [];
    let depth = 0;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i] ?? "";
      if (token === "}") {
        depth -= 1;
        continue;
      }
      if (token === "{" || tokens[i + 1] !== "{") continue;
      const body = tokens[i + 2] ?? "";
      if (tokens[i + 3] !== "}" || body === "{" || body === "}") {
        depth += 1;
        i += 1;
        continue;
      }
      const parts = token
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.includes(":visited"));
      if (parts.length > 0) expect(depth).toBe(0);
      const color = body
        .split(";")
        .map((d) => d.trim())
        .find((d) => d.startsWith("color:"))
        ?.slice("color:".length)
        .trim();
      for (const part of parts) {
        expect(Object.keys(expected)).toContain(part);
        expect(color).toBe(expected[part]);
        seen.set(part, color ?? "");
      }
      i += 3;
    }
    const byText = (x: string, y: string) => x.localeCompare(y);
    expect([...seen.keys()].sort(byText)).toEqual(Object.keys(expected).sort(byText));
  });
});

const NEW_ROUTES: Readonly<Record<string, readonly string[]>> = {
  "/sign-in/factor": ["GET", "HEAD", "POST"],
  "/account/authenticator": ["GET", "HEAD", "POST"],
  "/account/security": ["GET", "HEAD"],
  "/account/recovery-codes": ["GET", "HEAD", "POST"],
  "/account/sessions": ["GET", "HEAD"],
  "/account/sessions/sign-out-all": ["GET", "HEAD", "POST"],
};

async function beforeSetupAnswers(base: string, cookie: string): Promise<string[]> {
  const answers: string[] = [];
  const ask = async (method: string, path: string): Promise<void> => {
    const res = await fetch(base + path, {
      method,
      redirect: "manual",
      headers: {
        cookie,
        origin: base,
        "content-type": "application/x-www-form-urlencoded",
      },
      ...(method === "POST" ? { body: "csrf=x" } : {}),
    });
    answers.push(`${method} ${path} ${res.status} ${res.headers.get("location") ?? ""}`);
  };
  for (const [method, path] of [
    ["GET", "/"],
    ["HEAD", "/"],
    ["GET", "/sign-in"],
    ["HEAD", "/sign-in"],
    ["POST", "/sign-in"],
    ["POST", "/sign-out"],
  ]) {
    await ask(method ?? "", path ?? "");
  }
  for (const [path, methods] of Object.entries(NEW_ROUTES)) {
    for (const method of methods) await ask(method, path);
    await ask("DELETE", path);
  }
  return answers;
}

const BEFORE_SETUP = [
  "GET / 303 /setup",
  "HEAD / 303 /setup",
  "GET /sign-in 303 /setup",
  "HEAD /sign-in 303 /setup",
  "POST /sign-in 404 ",
  "POST /sign-out 303 /sign-in",
  ...Object.entries(NEW_ROUTES).flatMap(([path, methods]) => [
    ...methods.map((m) => `${m} ${path} 404 `),
    `DELETE ${path} 405 `,
  ]),
];

describe("routes before setup", () => {
  test("routes before setup keep #562 answers and the new routes are 404, with and without a cookie", async () => {
    const { base } = await start();
    const dbPath = join(dirs.at(-1) ?? "", "console.db");
    expect(await beforeSetupAnswers(base, "")).toEqual(BEFORE_SETUP);
    expect(await beforeSetupAnswers(base, `pulse_console_session=${"A".repeat(43)}`)).toEqual(
      BEFORE_SETUP,
    );
    const db = openDatabase(dbPath, { createFile: () => undefined, chmod: chmodSync });
    const rows = db.query<{ n: number }, []>("SELECT count(*) AS n FROM sessions").get();
    db.close();
    expect(rows?.n).toBe(0);
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
    await fetch(`${base}/fonts/space-grotesk-latin-700-normal.woff2`);
    await fetch(`${base}/healthz`);
    await fetch(`${base}/readyz`);
    await fetch(`${base}/nope`);
    await fetch(`${base}/`, { method: "POST" });
    const text = await metricsText(base);
    expect(requestSeries(text).sort((a, b) => a.localeCompare(b))).toEqual([
      'pulse_console_http_requests_total{path="/",code="303"} 1',
      'pulse_console_http_requests_total{path="/",code="405"} 1',
      'pulse_console_http_requests_total{path="/console.css",code="200"} 1',
      'pulse_console_http_requests_total{path="/fonts/:file",code="200"} 1',
      'pulse_console_http_requests_total{path="/healthz",code="200"} 1',
      'pulse_console_http_requests_total{path="/readyz",code="200"} 1',
      'pulse_console_http_requests_total{path="/setup",code="200"} 1',
      'pulse_console_http_requests_total{path="other",code="404"} 1',
    ]);
  });
});

describe("/console.js", () => {
  test("GET serves the busy-button script with the security headers", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/console.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expectSecurityHeaders(res);
    const js = await res.text();
    for (const part of ["data-busy-label", "aria-busy", "pageshow", "setTimeout"]) {
      expect(js).toContain(part);
    }
    for (const part of ["eval", "innerHTML", "fetch(", "XMLHttpRequest", "localStorage"]) {
      expect(js).not.toContain(part);
    }
  });

  test("HEAD has no body, POST is 405, and GET is counted under its own path", async () => {
    const { base } = await start();
    const head = await fetch(`${base}/console.js`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await head.text()).toBe("");
    const post = await fetch(`${base}/console.js`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    const { base: other } = await start();
    await fetch(`${other}/console.js`);
    expect(requestSeries(await metricsText(other))).toEqual([
      'pulse_console_http_requests_total{path="/console.js",code="200"} 1',
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

describe("protected routes without test routes", () => {
  test("/__test/ paths answer the plain 404 and count as other", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/__test/states/empty`, { redirect: "manual" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found\n");
    expectSecurityHeaders(res);
    expect(requestSeries(await metricsText(base))).toEqual([
      'pulse_console_http_requests_total{path="other",code="404"} 1',
    ]);
  });

  test("a test route key outside /__test/ or on a production path throws", () => {
    const route = {
      path: "/x",
      methods: ["GET"] as const,
      requiredRole: "viewer" as const,
      handle: () => Promise.reject(new Error("not used")),
    };
    for (const key of ["/x", "/sign-in", "/console.js", "/healthz", "/__testx"]) {
      const deps = depsFor(createMetrics());
      const testRoutes = new Map([[key, { ...route, path: key }]]);
      expect(() => createConsoleServer({ ...deps, testRoutes })).toThrow(TestRouteError);
    }
    const mismatched = new Map([["/__test/a", { ...route, path: "/__test/b" }]]);
    expect(() =>
      createConsoleServer({ ...depsFor(createMetrics()), testRoutes: mismatched }),
    ).toThrow("test route /__test/a must be a path under /__test/");
  });

  test("raw //healthz and /%2e%2e/ without a session keep the plain 404", async () => {
    const { port } = await start();
    for (const path of ["//healthz", "/%2e%2e/"]) {
      const answer = await rawRequest(port, `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1`);
      expect(answer.startsWith("HTTP/1.1 404")).toBe(true);
    }
  });
});
