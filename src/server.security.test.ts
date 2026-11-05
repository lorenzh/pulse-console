import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@lorenzh/pulse-kit";
import { type AccountStore, createAccountStore } from "./account-store.ts";
import { openDatabase } from "./database.ts";
import { createFactorStore } from "./factor-store.ts";
import { createMetrics } from "./metrics.ts";
import { createCredentialVerifier, PASSWORD_HASH_OPTIONS } from "./passwords.ts";
import { createConsoleServer, listen } from "./server.ts";
import type { ConsoleMode } from "./settings.ts";
import { createSetupGate } from "./setup-code.ts";

const TEST_SECRET_KEY = Uint8Array.from(Buffer.from("0123456789abcdef".repeat(4), "hex"));

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const TOKEN = "console-test-sentinel-token-0123456789abcdef";
const PASSWORD = "console-test-password-sentinel-42";
const CSRF = "csrf-token-of-client-a-0123456789abcdef0123";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

type Console = {
  port: number;
  code: string;
  store: AccountStore;
  logs: string[];
  metricsText: () => string;
  apiRequests: string[];
};

async function startConsole(
  mode: ConsoleMode = "loopback",
  publicOrigin: string | undefined = undefined,
): Promise<Console> {
  const dir = mkdtempSync(join(tmpdir(), "console-security-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDatabase(join(dir, "console.db"), {
    createFile: (path, m) => closeSync(openSync(path, "wx", m)),
    chmod: chmodSync,
  });
  const store = createAccountStore(db);
  const randomBytes = (size: number): Uint8Array => crypto.getRandomValues(new Uint8Array(size));
  const setup = createSetupGate({ now: () => 0, randomBytes });
  const logs: string[] = [];
  const metrics = createMetrics();
  const apiRequests: string[] = [];
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      apiRequests.push(new URL(req.url).pathname);
      return Response.json({ tokens: [] }, { headers: { "x-pulse-contract": "1" } });
    },
  });
  cleanups.push(() => {
    void api.stop(true);
  });
  const server: Server = createConsoleServer({
    metrics,
    log: createLogger({ level: "debug", write: (_l, line) => logs.push(line) }),
    mode,
    publicOrigin,
    defaultApiUrl: `http://127.0.0.1:${api.port}`,
    adminToken: TOKEN,
    store,
    factorStore: createFactorStore(db),
    secretKey: TEST_SECRET_KEY,
    gate: setup.gate,
    now: () => 0,
    randomBytes,
    hashPassword: (pw) =>
      Bun.password.hash(pw, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 }),
    verifier: await createCredentialVerifier({
      hash: (pw) => Bun.password.hash(pw, PASSWORD_HASH_OPTIONS),
      verify: (pw, hash) => Bun.password.verify(pw, hash),
      dummySecret: "dummy secret for tests",
    }),
    fetch,
  });
  const port = await listen(server, "127.0.0.1", 0);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  );
  return { port, code: setup.code, store, logs, metricsText: () => metrics.render(), apiRequests };
}

type Answer = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

/** One request with full control over Host and the other headers. */
function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body = "",
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { "content-length": Buffer.byteLength(body), ...headers },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => {
          data += String(d);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function formHeaders(port: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    "content-type": "application/x-www-form-urlencoded",
    cookie: `pulse_console_csrf=${CSRF}`,
    ...extra,
  };
}

describe("headers and pages", () => {
  test("the CSP is exactly the spec literal on pages, errors and ops routes", async () => {
    const c = await startConsole();
    for (const path of ["/setup", "/nope", "/healthz", "/console.css", "/"]) {
      const res = await send(c.port, "GET", path, { host: `localhost:${c.port}` });
      expect(res.headers["content-security-policy"]).toBe(CSP);
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["referrer-policy"]).toBe("same-origin");
    }
  });

  test("a GET of a form page sets the CSRF cookie once and renders the exact field", async () => {
    const c = await startConsole();
    const first = await send(c.port, "GET", "/setup", { host: "localhost" });
    const cookie = first.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toMatch(
      /^pulse_console_csrf=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/,
    );
    const token = cookie.slice("pulse_console_csrf=".length).split(";")[0];
    expect(first.body).toContain(`<input type="hidden" name="csrf" value="${token}">`);
    const again = await send(c.port, "GET", "/setup", {
      host: "localhost",
      cookie: `pulse_console_csrf=${CSRF}`,
    });
    expect(again.headers["set-cookie"]).toBeUndefined();
    expect(again.body).toContain(`<input type="hidden" name="csrf" value="${CSRF}">`);
  });

  test("strict-https cookies carry Secure and the __Host- prefix", async () => {
    const c = await startConsole("strict-https", "https://console.example.com");
    const page = await send(c.port, "GET", "/setup", { host: "console.example.com" });
    expect(page.headers["set-cookie"]?.[0]).toMatch(
      /^__Host-pulse_console_csrf=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure$/,
    );
    const unlock = await send(
      c.port,
      "POST",
      "/setup",
      {
        host: "console.example.com",
        origin: "https://console.example.com",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `__Host-pulse_console_csrf=${CSRF}`,
      },
      `csrf=${CSRF}&code=${c.code}`,
    );
    expect(unlock.status).toBe(303);
    expect(unlock.headers["set-cookie"]?.[0]).toMatch(
      /^__Host-pulse_console_setup=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=1800$/,
    );
    const httpOrigin = await send(
      c.port,
      "POST",
      "/setup",
      {
        host: "console.example.com",
        origin: "http://console.example.com",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `__Host-pulse_console_csrf=${CSRF}`,
      },
      `csrf=${CSRF}&code=${c.code}`,
    );
    expect(httpOrigin.status).toBe(403);
  });
});

describe("Host and Origin", () => {
  test("loopback mode refuses another Host with 421, but ops routes accept it", async () => {
    const c = await startConsole();
    const page = await send(c.port, "GET", "/sign-in", { host: "evil.example:8082" });
    expect(page.status).toBe(421);
    expect(page.body).toBe(
      "misdirected request: set PULSE_CONSOLE_PUBLIC_URL to serve this host\n",
    );
    for (const path of ["/healthz", "/readyz", "/metrics"]) {
      expect((await send(c.port, "GET", path, { host: "evil.example:8082" })).status).toBe(200);
    }
  });

  test("a missing, null or different Origin is 403", async () => {
    const c = await startConsole();
    const body = `csrf=${CSRF}&code=${c.code}`;
    for (const origin of [undefined, "null", "http://127.0.0.1:8082"]) {
      const headers = formHeaders(c.port, { host: "localhost:8082" });
      if (origin === undefined) delete headers.origin;
      else headers.origin = origin;
      const res = await send(c.port, "POST", "/setup", headers, body);
      expect(res.status).toBe(403);
      expect(res.body).toContain("Request refused. Reload the page and try again.");
    }
  });
});

describe("POST order", () => {
  test("each step fails with its own status", async () => {
    const c = await startConsole();
    const p = c.port;
    const ok = `csrf=${CSRF}&code=`;
    const cases: [string, string, Record<string, string>, string, number][] = [
      ["unknown route", "/nope", formHeaders(p), ok, 404],
      ["method", "/", formHeaders(p), ok, 405],
      ["phase", "/sign-in", formHeaders(p), ok, 404],
      ["host", "/setup", formHeaders(p, { host: "evil.example" }), ok, 421],
      ["origin", "/setup", formHeaders(p, { origin: "http://evil.example" }), ok, 403],
      ["content type", "/setup", formHeaders(p, { "content-type": "application/json" }), ok, 415],
      ["body", "/setup", formHeaders(p), "x".repeat(8193), 413],
      ["repeat", "/setup", formHeaders(p), `${ok}&code=a`, 400],
      ["csrf", "/setup", formHeaders(p), `csrf=${CSRF.slice(0, -1)}x&code=`, 403],
      ["grant", "/setup/owner", formHeaders(p), `csrf=${CSRF}&action=test`, 403],
      ["format", "/setup", formHeaders(p), `${ok}&unknown=1&unknown=2`, 422],
      ["verification", "/setup", formHeaders(p), `csrf=${CSRF}&code=0000`, 401],
    ];
    for (const [name, path, headers, body, status] of cases) {
      const res = await send(p, "POST", path, headers, body);
      expect({ name, status: res.status }).toEqual({ name, status });
    }
    const full = `${ok}&pad=`;
    const atLimit = full + "x".repeat(8192 - full.length);
    expect((await send(p, "POST", "/setup", formHeaders(p), atLimit)).status).toBe(422);
    for (let i = 0; i < 4; i++)
      await send(p, "POST", "/setup", formHeaders(p), `csrf=${CSRF}&code=1`);
    const throttled = await send(
      p,
      "POST",
      "/setup",
      formHeaders(p),
      `csrf=${CSRF}&code=${c.code}`,
    );
    expect(throttled.status).toBe(429);
    expect(c.apiRequests).toHaveLength(0);
    expect(c.metricsText()).toContain(
      'pulse_console_auth_attempts_total{kind="setup-code",result="throttled"} 1',
    );
    expect(c.metricsText()).toContain(
      'pulse_console_auth_attempts_total{kind="setup-code",result="failure"} 5',
    );
  });

  test("owner form: format 422, connection 502 and commit 303 follow the grant", async () => {
    const c = await startConsole();
    const p = c.port;
    const unlock = await send(p, "POST", "/setup", formHeaders(p), `csrf=${CSRF}&code=${c.code}`);
    const grant = String(unlock.headers["set-cookie"]?.[0]).split(";")[0];
    const headers = formHeaders(p, { cookie: `pulse_console_csrf=${CSRF}; ${grant}` });
    const fields = new URLSearchParams({
      csrf: CSRF,
      api_url: "http://127.0.0.1:1",
      email: "owner@example.com",
      name: "Owner",
      password: PASSWORD,
      password_confirm: PASSWORD,
      action: "complete",
    });
    const bad = new URLSearchParams(fields);
    bad.set("email", "x");
    expect((await send(p, "POST", "/setup/owner", headers, bad.toString())).status).toBe(422);
    const unreachable = await send(p, "POST", "/setup/owner", headers, fields.toString());
    expect(unreachable.status).toBe(502);
    expect(unreachable.body).toContain("pulse-api cannot be reached at http://127.0.0.1:1.");
    const csrfOnly = await send(p, "POST", "/sign-out", headers, `csrf=${CSRF}`);
    expect(csrfOnly.status).toBe(303);
    expect(csrfOnly.headers.location).toBe("/sign-in");
  });
});

describe("leak scan of the setup flow", () => {
  test("secrets appear only in their intended places", async () => {
    const c = await startConsole();
    const p = c.port;
    const answers: Answer[] = [];
    const page = await send(p, "GET", "/setup", { host: `127.0.0.1:${p}` });
    answers.push(page);
    const csrfCookie = String(page.headers["set-cookie"]?.[0]);
    const csrf = csrfCookie.slice("pulse_console_csrf=".length).split(";")[0] ?? "";
    const base = formHeaders(p, { cookie: `pulse_console_csrf=${csrf}` });
    answers.push(await send(p, "POST", "/setup", base, `csrf=${csrf}&code=0000`));
    const unlock = await send(p, "POST", "/setup", base, `csrf=${csrf}&code=${c.code}`);
    answers.push(unlock);
    const grantCookie = String(unlock.headers["set-cookie"]?.[0]);
    expect(grantCookie.startsWith("pulse_console_setup=")).toBe(true);
    const grant = grantCookie.slice("pulse_console_setup=".length).split(";")[0] ?? "";
    const withGrant = formHeaders(p, {
      cookie: `pulse_console_csrf=${csrf}; pulse_console_setup=${grant}`,
    });
    const fields = new URLSearchParams({
      csrf,
      api_url: `http://127.0.0.1:${p}/nope`,
      email: "owner@example.com",
      name: "Owner",
      password: PASSWORD,
      password_confirm: PASSWORD,
      action: "test",
    });
    answers.push(await send(p, "GET", "/setup/owner", withGrant));
    answers.push(await send(p, "POST", "/setup/owner", withGrant, fields.toString()));
    answers.push(await send(p, "GET", "/metrics", { host: "x" }));

    const csrfField = `<input type="hidden" name="csrf" value="${csrf}">`;
    for (const a of [answers[0], answers[1], answers[3], answers[4]]) {
      expect(a?.body).toContain(csrfField);
    }
    const sentinels = [TOKEN, PASSWORD, c.code, csrf, grant];
    for (const a of answers) {
      const headers = Object.entries(a.headers)
        .filter(([name]) => name !== "set-cookie")
        .map(([name, v]) => `${name}: ${String(v)}`)
        .join("\n");
      const cookies = ([] as string[]).concat(a.headers["set-cookie"] ?? []);
      const otherCookies = cookies.filter(
        (l) =>
          !(
            l.startsWith(`pulse_console_csrf=${csrf};`) ||
            l.startsWith(`pulse_console_setup=${grant};`)
          ),
      );
      const rest = [headers, ...otherCookies, a.body.split(csrfField).join("")].join("\n");
      for (const s of sentinels) expect(rest.split(s).length - 1).toBe(0);
    }
    for (const line of c.logs) for (const s of sentinels) expect(line).not.toContain(s);
    for (const s of sentinels) expect(c.metricsText()).not.toContain(s);
  });
});
