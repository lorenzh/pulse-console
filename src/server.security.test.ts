import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@lorenzh/pulse-kit";
import {
  formTokenOf,
  getPage,
  postForm,
  type SignedInConsole,
  startSignedInConsole,
} from "../test/signed-in-console.ts";
import { startTeamConsole } from "../test/team-console.ts";
import { type AccountStore, createAccountStore } from "./account-store.ts";
import { openDatabase } from "./database.ts";
import { createFactorStore } from "./factor-store.ts";
import { createMetrics } from "./metrics.ts";
import { createCredentialVerifier, PASSWORD_HASH_OPTIONS } from "./passwords.ts";
import { createConsoleServer, listen } from "./server.ts";
import type { ConsoleMode } from "./settings.ts";
import { createSetupGate } from "./setup-code.ts";
import { createTeamStore } from "./team-store.ts";
import {
  closeAll,
  csrfIn,
  enrol,
  enrolledConsole,
  KEY_HEX,
  PASSWORD as OWNER_PASSWORD,
  type Reply,
  SESSION,
  STEP_MS,
  startConsole as startTwoFactorConsole,
  stepAt,
  Client as TwoFactorClient,
  totpCode,
} from "./two-factor-harness.ts";

const TEST_SECRET_KEY = Uint8Array.from(Buffer.from("0123456789abcdef".repeat(4), "hex"));

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
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
    instanceName: "pulse Console",
    metrics,
    log: createLogger({ level: "debug", write: (_l, line) => logs.push(line) }),
    mode,
    publicOrigin,
    defaultApiUrl: `http://127.0.0.1:${api.port}`,
    adminToken: TOKEN,
    store,
    factorStore: createFactorStore(db),
    teamStore: createTeamStore(db),
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

/** A fresh form token from a GET /setup with the same Host and cookie. */
async function setupFormToken(port: number, host: string, cookie: string): Promise<string> {
  const page = await send(port, "GET", "/setup", { host, cookie });
  return /name="form_token" value="([^"]+)"/.exec(page.body)?.[1] ?? "";
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
    for (const path of [
      "/setup",
      "/nope",
      "/healthz",
      "/console.css",
      "/fonts/jetbrains-mono-latin-400-normal.woff2",
      "/",
    ]) {
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
    const strictCookie = `__Host-pulse_console_csrf=${CSRF}`;
    const strictToken = await setupFormToken(c.port, "console.example.com", strictCookie);
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
      `csrf=${CSRF}&code=${c.code}&form_token=${strictToken}`,
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
    const unlockToken = await setupFormToken(p, `127.0.0.1:${p}`, `pulse_console_csrf=${CSRF}`);
    const unlock = await send(
      p,
      "POST",
      "/setup",
      formHeaders(p),
      `csrf=${CSRF}&code=${c.code}&form_token=${unlockToken}`,
    );
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
    const unlockToken = await setupFormToken(p, `127.0.0.1:${p}`, `pulse_console_csrf=${csrf}`);
    const unlock = await send(
      p,
      "POST",
      "/setup",
      base,
      `csrf=${csrf}&code=${c.code}&form_token=${unlockToken}`,
    );
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

class RecordingClient extends TwoFactorClient {
  readonly replies: Reply[] = [];
  readonly posted: string[] = [];

  override async request(
    method: string,
    path: string,
    fields?: Record<string, string>,
  ): Promise<Reply> {
    for (const [name, value] of Object.entries(fields ?? {})) {
      if (name === "code" || name === "recovery_code") this.posted.push(value);
    }
    const reply = await super.request(method, path, fields);
    this.replies.push(reply);
    return reply;
  }
}

async function rawPost(
  base: string,
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<number> {
  const res = await fetch(base + path, { method: "POST", redirect: "manual", headers, body });
  await res.arrayBuffer();
  return res.status;
}

describe("gate and POST order of the new routes", () => {
  afterEach(closeAll);

  test("the gate answers before Origin, content type and body; then the documented order", async () => {
    const { c } = await enrolledConsole();
    const anonymous = { origin: "http://evil.example", "content-type": "text/plain" };
    const huge = "x".repeat(10_000);
    for (const path of [
      "/sign-in/factor",
      "/account/authenticator",
      "/account/recovery-codes",
      "/account/sessions/sign-out-all",
    ]) {
      expect(await rawPost(c.base, path, huge, anonymous)).toBe(303);
    }
    const client = new TwoFactorClient(c);
    await client.password();
    const page = await client.get("/sign-in/factor");
    const csrf = csrfIn(page.body);
    const cookie = [...client.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const form = "application/x-www-form-urlencoded";
    const steps: [string, Record<string, string>, number][] = [
      [`csrf=${csrf}&code=1`, { cookie, origin: "http://evil.example", "content-type": form }, 403],
      [`csrf=${csrf}&code=1`, { cookie, origin: c.base, "content-type": "text/plain" }, 415],
      [`csrf=${csrf}&code=${huge}`, { cookie, origin: c.base, "content-type": form }, 413],
      [`csrf=${csrf}&code=1&code=2`, { cookie, origin: c.base, "content-type": form }, 400],
      ["csrf=wrong&code=1", { cookie, origin: c.base, "content-type": form }, 403],
      [`csrf=${csrf}&code=1`, { cookie, origin: c.base, "content-type": form }, 422],
    ];
    for (const [body, headers, status] of steps) {
      expect(await rawPost(c.base, "/sign-in/factor", body, headers)).toBe(status);
    }
    // None of these counted: four wrong codes still answer 401, not 429.
    for (let i = 0; i < 4; i += 1) {
      expect((await client.factor({ code: "000000" })).status).not.toBe(429);
    }
  });
});

describe("leak scan of the two-factor flows", () => {
  afterEach(closeAll);

  test("no seed, setup key, typed code, recovery code, key or session secret leaks", async () => {
    const c = await startTwoFactorConsole();
    const owner = new RecordingClient(c);
    await owner.password();
    const enrolled = await enrol(owner);
    c.clock.now += STEP_MS;
    const other = new RecordingClient(c);
    await other.password();
    const otherFactorId = other.jar.get(SESSION) ?? "";
    const otherCsrf = csrfIn((await other.get("/sign-in/factor")).body);
    await other.factor({ code: totpCode(enrolled.seed, stepAt(c.clock.now) + 4) });
    await other.factor({ recovery_code: enrolled.codes[1] ?? "" });
    const ownerId = owner.jar.get(SESSION) ?? "";
    await owner.get("/");
    const otherFullId = other.jar.get(SESSION) ?? "";
    const otherFullCsrf = csrfIn((await other.get("/")).body);
    await owner.get("/account/security");
    const listed = await owner.get("/account/sessions");
    const ownerCsrf = csrfIn(listed.body);
    const renewed = await owner.post("/account/recovery-codes", {
      csrf: ownerCsrf,
      password: OWNER_PASSWORD,
    });
    const freshCodes = [...renewed.body.matchAll(/<li><code>([^<]+)<\/code><\/li>/g)].map(
      (m) => m[1] ?? "",
    );
    expect(freshCodes).toHaveLength(10);
    await owner.get("/account/sessions/sign-out-all");
    await owner.post("/account/sessions/sign-out-all", { csrf: ownerCsrf });
    await owner.get("/account/sessions?signed-out=others");
    const metrics = await owner.get("/metrics");

    // Positive controls: the intended disclosures exist before they are cut out.
    const keyText = enrolled.key.replaceAll(" ", "");
    const intended = owner.replies.filter(
      (r) => r.body.includes('id="totp-secret"') || r.body.includes('id="recovery-codes"'),
    );
    expect(intended.length).toBeGreaterThanOrEqual(3);
    const sentinels = [
      keyText,
      enrolled.seed.toString("hex"),
      enrolled.seed.toString("base64url"),
      KEY_HEX,
      ...enrolled.codes,
      ...enrolled.codes.map((code) => code.replaceAll("-", "")),
      ...owner.posted,
      ...other.posted,
      ...freshCodes,
      OWNER_PASSWORD,
    ];
    const replies = [...owner.replies, ...other.replies].filter((r) => !intended.includes(r));
    for (const r of replies) {
      const text = [r.headers.get("location") ?? "", r.body].join("\n");
      for (const s of sentinels) expect(text).not.toContain(s);
      for (const line of r.headers.getSetCookie()) {
        for (const s of sentinels) expect(line).not.toContain(s);
      }
    }
    for (const r of owner.replies) {
      for (const s of [otherFactorId, otherCsrf, otherFullId, otherFullCsrf]) {
        expect(r.body).not.toContain(s);
      }
    }
    for (const line of c.logs) {
      for (const s of [...sentinels, ownerId, otherFactorId, otherCsrf, otherFullId]) {
        expect(line).not.toContain(s);
      }
    }
    for (const s of [...sentinels, ownerId, otherFactorId, otherCsrf]) {
      expect(metrics.body).not.toContain(s);
    }
    expect(metrics.body).toContain('path="/sign-in/factor"');
    expect(metrics.body).toContain('kind="enrolment",result="success"');
    expect(metrics.body).toContain('kind="recovery-code",result="success"');
    expect(metrics.body).toContain('path="/account/sessions/sign-out-all"');
    expect(metrics.body).toContain('kind="password-confirm",result="success"');
    expect(c.logs.some((l) => l.includes("signed out other sessions"))).toBe(true);
  });
});

describe("signed-in unknown paths and the Overview", () => {
  const CSP =
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

  async function signedIn(): Promise<SignedInConsole> {
    const c = await startSignedInConsole({
      apiUrl: "http://127.0.0.1:9",
      adminToken: "security-admin-token",
    });
    cleanups.push(() => c.close());
    return c;
  }

  function expectShell(res: Reply): void {
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body.match(/<script/g)).toEqual(["<script"]);
    expect(res.body).toContain('<script src="/console.js" defer></script>');
    expect(res.body).not.toContain("style=");
    expect(res.body).not.toMatch(/\son[a-z]+=/);
  }

  test("GET of an unknown path with a session is the shell 404", async () => {
    const c = await signedIn();
    const res = await getPage(c, "/no-such-page");
    expect(res.status).toBe(404);
    expect(res.body.split("Page not found")).toHaveLength(3);
    expect(res.body).toContain("<title>Page not found");
    expect(res.body).toContain("<h1>Page not found</h1>");
    expect(res.body).not.toContain("<h2>Page not found</h2>");
    expect(res.body).toContain("<p>There is no page at this address; go to the overview.</p>");
    expect(res.body).toContain('<a href="/">Go to the overview</a>');
    expectShell(res);
    const head = await fetch(`${c.base}/no-such-page`, {
      method: "HEAD",
      headers: { cookie: c.cookie },
    });
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
  });

  test("shell 404 explanatory paragraph has one sentence", async () => {
    const c = await signedIn();
    const res = await getPage(c, "/no-such-page");
    expect(res.status).toBe(404);
    const paragraphs = textParagraphs(res.body);
    expect(paragraphs).toHaveLength(1);
    expect(sentenceCount(paragraphs[0] ?? "")).toBe(1);
  });

  test("other unknown-path requests keep the plain 404", async () => {
    const c = await signedIn();
    const post = await postForm(c, "/no-such-page", {});
    expect(post.status).toBe(404);
    expect(post.body).toBe("not found\n");
    const anonymous = await getPage(c, "/no-such-page", "");
    expect(anonymous.status).toBe(404);
    expect(anonymous.body).toBe("not found\n");
  });

  test("the Overview carries the shell headers and one script", async () => {
    const c = await signedIn();
    const res = await getPage(c, "/");
    expect(res.status).toBe(200);
    expectShell(res);
    expect(res.body).toContain("<p>Kind: connection refused</p>");
    expect(res.body).toContain(
      "The connection to http://127.0.0.1:9 was refused. Check that pulse-api is running at this address.",
    );
  });

  test("GET / without a session redirects to sign-in with next=/", async () => {
    const c = await signedIn();
    const res = await getPage(c, "/", "");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sign-in?next=%2F");
  });
});

describe("invite link tokens", () => {
  test("a link token appears only on its link page and its own form, never in logs, metrics or events", async () => {
    const c = await startTeamConsole({ apiUrl: "http://127.0.0.1:9" });
    try {
      const page = await getPage(c, "/team", c.cookies.owner);
      const created = await postForm(
        c,
        "/team/invites",
        {
          csrf: c.csrfs.owner,
          form_token: formTokenOf(page.body, "/team/invites"),
          email: "new@example.com",
          role: "member",
        },
        { cookie: c.cookies.owner },
      );
      const token = /\/invite\/([A-Za-z0-9_-]{43})/.exec(created.body)?.[1] ?? "";
      expect(token).toHaveLength(43);
      const form = await getPage(c, `/invite/${token}`, "");
      expect(form.body).toContain(`action="/invite/${token}"`);
      const csrf =
        /pulse_console_csrf=([A-Za-z0-9_-]+)/.exec(form.headers.get("set-cookie") ?? "")?.[1] ?? "";
      const accepted = await postForm(
        c,
        `/invite/${token}`,
        {
          csrf,
          form_token: formTokenOf(form.body, `/invite/${token}`),
          name: "Newt",
          password: "invite-sentinel-password-1",
          password_confirm: "invite-sentinel-password-1",
        },
        { cookie: `pulse_console_csrf=${csrf}` },
      );
      expect(accepted.status).toBe(303);
      const others = [
        await getPage(c, "/team", c.cookies.owner),
        await getPage(c, "/team", c.cookies.admin),
        await getPage(c, `/invite/${token}`, ""),
      ];
      for (const r of others) expect(r.body).not.toContain(token);
      expect(accepted.headers.get("location") ?? "").not.toContain(token);
      const logs = c.logs.join("\n");
      expect(logs).not.toContain(token);
      expect(logs).not.toContain("invite-sentinel-password-1");
      expect(logs).not.toContain("new@example.com");
      expect(c.metrics.render()).not.toContain(token);
      const events = JSON.stringify(c.db.query("SELECT * FROM people_events").all());
      expect(events).not.toContain(token);
      expect(events).not.toContain("invite-sentinel-password-1");
    } finally {
      await c.close();
    }
  });
});

describe("reset link tokens", () => {
  test("a reset token and the new password never reach logs, metrics, events or other pages", async () => {
    const c = await startTeamConsole({ apiUrl: "http://127.0.0.1:9" });
    try {
      const path = `/team/reset-link?user=${c.ids.member}`;
      const confirm = await getPage(c, path, c.cookies.admin);
      const row = c.db
        .query<{ created_at: number; role: string }, [number]>(
          "SELECT created_at, role FROM users WHERE id = ?",
        )
        .get(c.ids.member);
      const made = await postForm(
        c,
        path,
        {
          csrf: c.csrfs.admin,
          form_token: formTokenOf(confirm.body, path),
          revision: `${row?.created_at}-${row?.role}`,
        },
        { cookie: c.cookies.admin },
      );
      const token = /\/reset\/([A-Za-z0-9_-]{43})/.exec(made.body)?.[1] ?? "";
      expect(token).toHaveLength(43);
      const form = await getPage(c, `/reset/${token}`, "");
      const csrf =
        /pulse_console_csrf=([A-Za-z0-9_-]+)/.exec(form.headers.get("set-cookie") ?? "")?.[1] ?? "";
      const secret = "reset-sentinel-password-1";
      const used = await postForm(
        c,
        `/reset/${token}`,
        {
          csrf,
          form_token: formTokenOf(form.body, `/reset/${token}`),
          password: secret,
          password_confirm: secret,
        },
        { cookie: `pulse_console_csrf=${csrf}` },
      );
      expect(used.status).toBe(303);
      expect(used.headers.get("location")).toBe("/sign-in?reset=done");
      for (const r of [
        await getPage(c, "/team", c.cookies.admin),
        await getPage(c, `/reset/${token}`, ""),
      ]) {
        expect(r.body).not.toContain(token);
      }
      const logs = c.logs.join("\n");
      expect(logs).not.toContain(token);
      expect(logs).not.toContain(secret);
      expect(c.metrics.render()).not.toContain(token);
      const stored = JSON.stringify([
        c.db.query("SELECT * FROM people_events").all(),
        c.db.query("SELECT * FROM reset_links").all(),
      ]);
      expect(stored).not.toContain(token);
      expect(stored).not.toContain(secret);
    } finally {
      await c.close();
    }
  });
});

/** The text of the paragraphs inside `<main>` that hold no link, tags stripped, entities decoded. */
function textParagraphs(body: string): string[] {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(body)?.[1] ?? "";
  return [...main.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => m[1] ?? "")
    .filter((inner) => !inner.includes("<a"))
    .map((inner) =>
      inner
        .split("<")
        .map((part, i) => (i === 0 ? part : part.slice(part.indexOf(">") + 1)))
        .join("")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&"),
    );
}

function sentenceCount(text: string): number {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  return [...segmenter.segment(text)].filter((s) => s.segment.trim() !== "").length;
}
