/* eslint-disable sonarjs/no-clear-text-protocols -- loopback test servers and URL inputs under test */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import nodeCrypto from "node:crypto";
import { chmodSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@lorenzh/pulse-kit";
import { SELF_ID, selfToken } from "../test/token-fixtures.ts";
import { type AccountStore, createAccountStore } from "./account-store.ts";
import { openDatabase } from "./database.ts";
import { createFactorStore } from "./factor-store.ts";
import { createMetrics } from "./metrics.ts";
import { createCredentialVerifier, PASSWORD_HASH_OPTIONS } from "./passwords.ts";
import { createConsoleServer, listen } from "./server.ts";
import { createSetupGate } from "./setup-code.ts";
import { createTeamStore } from "./team-store.ts";

const TEST_SECRET_KEY = Uint8Array.from(Buffer.from("0123456789abcdef".repeat(4), "hex"));

const TOKEN = "console-test-sentinel-token-0123456789abcdef";
const PASSWORD = "console-test-password-sentinel-42";
const OWNER_EMAIL = "owner-sentinel@example.com";

type Recorded = { path: string; authorization: string | null };
type FakeApi = { url: string; requests: Recorded[]; stop: () => void };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function config(checks: number): unknown {
  const list = Array.from({ length: checks }, (_, i) => ({
    id: `check-${i}`,
    name: `Check ${i}`,
    url: "https://example.com",
    intervalMs: 60000,
  }));
  return { revision: `sha256-${"a".repeat(64)}`, checks: list, components: [], maintenance: [] };
}

function startApi(
  handler: (path: string) => Response | Promise<Response> = (path) => okFor(path, 3),
): FakeApi {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      requests.push({ path, authorization: req.headers.get("authorization") });
      return handler(path);
    },
  });
  const stop = (): void => {
    void server.stop(true);
  };
  cleanups.push(stop);
  return { url: `http://127.0.0.1:${server.port}`, requests, stop };
}

function okFor(path: string, checks: number, tokensStatus = 200, selfStatus = 200): Response {
  const headers = { "content-type": "application/json", "x-pulse-contract": "1" };
  if (path.endsWith("/admin/config")) return Response.json(config(checks), { headers });
  if (path.endsWith("/admin/tokens/self")) {
    return selfStatus === 200
      ? Response.json(selfToken(), { headers })
      : new Response("no", { status: selfStatus, headers });
  }
  if (tokensStatus !== 200) return new Response("no", { status: tokensStatus, headers });
  return Response.json({ tokens: [] }, { headers });
}

type Console = {
  base: string;
  origin: string;
  code: string;
  store: AccountStore;
  dbPath: string;
  logs: string[];
  clock: { now: number };
};

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "console-setup-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "console.db");
}

async function startConsole(
  opts: {
    dbPath?: string;
    adminToken?: string | undefined;
    defaultApiUrl?: string;
    wrapStore?: (store: AccountStore) => AccountStore;
  } = {},
): Promise<Console> {
  const dbPath = opts.dbPath ?? tempDb();
  const db = openDatabase(dbPath, {
    createFile: (path, mode) => closeSync(openSync(path, "wx", mode)),
    chmod: chmodSync,
  });
  const realStore = createAccountStore(db);
  const store = opts.wrapStore?.(realStore) ?? realStore;
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const randomBytes = (size: number): Uint8Array => crypto.getRandomValues(new Uint8Array(size));
  const setup = createSetupGate({ now, randomBytes });
  const logs: string[] = [];
  const server: Server = createConsoleServer({
    instanceName: "pulse Console",
    metrics: createMetrics(),
    log: createLogger({ level: "debug", write: (_level, line) => logs.push(line) }),
    mode: "loopback",
    publicOrigin: undefined,
    defaultApiUrl: opts.defaultApiUrl ?? "http://api.invalid:3000",
    adminToken: "adminToken" in opts ? opts.adminToken : TOKEN,
    store,
    factorStore: createFactorStore(db),
    teamStore: createTeamStore(db),
    secretKey: TEST_SECRET_KEY,
    gate: realStore.instance() === undefined ? setup.gate : undefined,
    now,
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
  const origin = `http://127.0.0.1:${port}`;
  return { base: origin, origin, code: setup.code, store, dbPath, logs, clock };
}

// The cookies that the page of each form needs; every other form needs only the CSRF cookie.
const FORM_COOKIES: Record<string, string[]> = {
  "/sign-out": ["pulse_console_session"],
  "/setup/owner": ["pulse_console_csrf", "pulse_console_setup"],
};

/** A browser-like client with its own cookie jar. */
class Client {
  readonly jar = new Map<string, string>();
  readonly responses: { status: number; headers: Headers; body: string }[] = [];
  readonly c: Console;
  constructor(c: Console) {
    this.c = c;
  }

  private remember(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const index = (pair ?? "").indexOf("=");
      const name = (pair ?? "").slice(0, index);
      const value = (pair ?? "").slice(index + 1);
      if (line.includes("Max-Age=0")) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  private cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async get(path: string): Promise<{ status: number; headers: Headers; body: string }> {
    const res = await fetch(this.c.base + path, {
      redirect: "manual",
      headers: { cookie: this.cookieHeader() },
    });
    this.remember(res);
    const r = { status: res.status, headers: res.headers, body: await res.text() };
    this.responses.push(r);
    return r;
  }

  /** A fresh form token from the page of that form, sent with only the cookies it needs. */
  private async freshFormToken(path: string): Promise<string | undefined> {
    const page = path === "/sign-out" ? "/account/authenticator" : path;
    const names = FORM_COOKIES[path] ?? ["pulse_console_csrf"];
    const cookie = names
      .filter((n) => this.jar.has(n))
      .map((n) => `${n}=${this.jar.get(n)}`)
      .join("; ");
    const res = await fetch(this.c.base + page, { redirect: "manual", headers: { cookie } });
    const html = await res.text();
    const form = html.slice(Math.max(0, html.indexOf(`action="${path}"`)));
    return /name="form_token" value="([^"]+)"/.exec(form)?.[1];
  }

  async post(
    path: string,
    fields: Record<string, string>,
  ): Promise<{ status: number; headers: Headers; body: string }> {
    const token = await this.freshFormToken(path);
    const body = new URLSearchParams({
      csrf: this.jar.get("pulse_console_csrf") ?? "",
      ...(token === undefined ? {} : { form_token: token }),
      ...fields,
    });
    const res = await fetch(this.c.base + path, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: this.cookieHeader(),
        origin: this.c.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    this.remember(res);
    const r = { status: res.status, headers: res.headers, body: await res.text() };
    this.responses.push(r);
    return r;
  }

  /** Loads the code form and unlocks setup. */
  async unlock(): Promise<void> {
    await this.get("/setup");
    const res = await this.post("/setup", { code: this.c.code });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/setup/owner");
  }
}

function ownerFields(apiUrl: string, action: "test" | "complete"): Record<string, string> {
  return {
    api_url: apiUrl,
    email: OWNER_EMAIL,
    name: "Owner Sentinel",
    password: PASSWORD,
    password_confirm: PASSWORD,
    action,
  };
}

/** The success line is a success callout with its id, no role, and the exact deploy text. */
function expectConnected(body: string, checks: number): void {
  const open = '<section class="callout callout-success" id="connection-result">';
  expect(body).toContain(open);
  const start = body.indexOf(open);
  const end = body.indexOf("</section>", start);
  expect(body.slice(start, end)).toContain(`<p>Connected. Wire version: 1. Checks: ${checks}.</p>`);
}

function userCount(dbPath: string): number {
  const db = openDatabase(dbPath, { createFile: () => undefined, chmod: chmodSync });
  const row = db.query("SELECT count(*) AS n FROM users").get();
  db.close();
  return typeof row === "object" && row !== null ? Number(Reflect.get(row, "n")) : -1;
}

describe("setup without the code is refused", () => {
  test("no grant: GET /setup/owner is 303 /setup and POST is 403", async () => {
    const api = startApi();
    const c = await startConsole();
    const client = new Client(c);
    const get = await client.get("/setup/owner");
    expect(get.status).toBe(303);
    expect(get.headers.get("location")).toBe("/setup");
    await client.get("/setup");
    const post = await client.post("/setup/owner", ownerFields(api.url, "complete"));
    expect(post.status).toBe(403);
    expect(post.body).toContain("Setup is locked. Enter the setup code first.");
    expect(post.body).toContain('<a href="/setup">');
    expect(api.requests).toHaveLength(0);
    expect(userCount(c.dbPath)).toBe(0);
  });

  test("a wrong code is 401, an empty code is 422, the sixth attempt is 429", async () => {
    const api = startApi();
    const c = await startConsole();
    const client = new Client(c);
    await client.get("/setup");
    expect((await client.post("/setup", { code: "" })).status).toBe(422);
    expect((await client.post("/setup", { code: " - " })).status).toBe(422);
    const flipped = (c.code[0] === "a" ? "b" : "a") + c.code.slice(1);
    for (let i = 0; i < 5; i++) {
      const res = await client.post("/setup", { code: flipped });
      expect(res.status).toBe(401);
      expect(res.body).toContain("Wrong setup code.");
    }
    const sixth = await client.post("/setup", { code: c.code });
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("retry-after")).toBe("900");
    expect(api.requests).toHaveLength(0);
    expect(userCount(c.dbPath)).toBe(0);
    const refused = c.logs.filter((l) => l.includes('"setup code refused"'));
    expect(refused).toHaveLength(6);
    expect(refused[0]).toContain('"reason":"credentials"');
    expect(refused[5]).toContain('"reason":"throttled"');
    for (const line of c.logs) expect(line).not.toContain(c.code);
  });

  test("the code in upper case with spaces is accepted", async () => {
    const c = await startConsole();
    const client = new Client(c);
    await client.get("/setup");
    const res = await client.post("/setup", { code: ` ${c.code.toUpperCase()} ` });
    expect(res.status).toBe(303);
    const grant = res.headers.getSetCookie().find((l) => l.startsWith("pulse_console_setup="));
    expect(grant).toMatch(
      /^pulse_console_setup=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=1800$/,
    );
    expect(res.headers.get("location")).toBe("/setup/owner");
  });
});

describe("grants", () => {
  test("forged, expired and replaced grants are 403", async () => {
    const api = startApi();
    const c = await startConsole();
    const a = new Client(c);
    await a.unlock();
    a.jar.set("pulse_console_setup", "forged-grant-value");
    expect((await a.post("/setup/owner", ownerFields(api.url, "test"))).status).toBe(403);

    const b = new Client(c);
    await b.unlock();
    c.clock.now += 1_800_001;
    expect((await b.post("/setup/owner", ownerFields(api.url, "test"))).status).toBe(403);

    c.clock.now += 1;
    const first = new Client(c);
    await first.unlock();
    const second = new Client(c);
    await second.unlock();
    expect((await first.post("/setup/owner", ownerFields(api.url, "test"))).status).toBe(403);
    expect((await second.post("/setup/owner", ownerFields(api.url, "test"))).status).toBe(200);
  });

  test("a grant just before 30 minutes still works", async () => {
    const api = startApi();
    const c = await startConsole();
    const client = new Client(c);
    await client.unlock();
    c.clock.now += 1_799_999;
    expect((await client.get("/setup/owner")).status).toBe(200);
    expect((await client.post("/setup/owner", ownerFields(api.url, "test"))).status).toBe(200);
  });
});

describe("owner form", () => {
  test("invalid fields are 422 with a message each; passwords are never echoed", async () => {
    const api = startApi();
    const c = await startConsole();
    const client = new Client(c);
    await client.unlock();
    const res = await client.post("/setup/owner", {
      api_url: "http://user:pw@api:3000",
      email: "not-an-email",
      name: "",
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a too-short test input
      password: "shortpwsent",
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a too-short test input
      password_confirm: "shortpwsent",
      action: "complete",
    });
    expect(res.status).toBe(422);
    expect(res.body).toContain("Enter an http(s) URL without credentials, query or fragment.");
    expect(res.body).toContain("Enter a valid email address.");
    expect(res.body).toContain("Enter a name of 1 to 100 characters.");
    expect(res.body).toContain("The password must have at least 12 characters.");
    expect(res.body).toContain('value="not-an-email"');
    expect(res.body).toContain('aria-describedby="field-email-error"');
    expect(res.body).not.toContain("shortpwsent");
    expect(api.requests).toHaveLength(0);

    for (const [fields, text] of [
      [{ password_confirm: `${PASSWORD}x` }, "The passwords do not match."],
      [{ password: "a".repeat(129), password_confirm: "a".repeat(129) }, "at most 128"],
      [{ api_url: `http://api/${"a".repeat(2038)}` }, "at most 2048 characters"],
      [{ action: "other" }, "Choose an action."],
    ] as const) {
      const r = await client.post("/setup/owner", {
        ...ownerFields(api.url, "complete"),
        ...fields,
      });
      expect(r.status).toBe(422);
      expect(r.body).toContain(text);
      expect(r.body).not.toContain(PASSWORD);
    }
    const noAction = await client.post("/setup/owner", {
      ...ownerFields(api.url, "complete"),
      action: "other",
    });
    expect(noAction.body).toContain('<section class="callout callout-error" role="alert">');
    expect(noAction.body).toContain("<p>Choose an action.</p>");
    expect(noAction.body).not.toContain("style=");
    const emoji = "😀".repeat(12);
    const ok = await client.post("/setup/owner", {
      ...ownerFields(api.url, "test"),
      password: emoji,
      password_confirm: emoji,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).not.toContain(emoji);
  });

  test("invalid account fields are 422 for both actions before any API request", async () => {
    const api = startApi();
    const c = await startConsole();
    const client = new Client(c);
    await client.unlock();
    const short = "elevenchars";
    for (const action of ["test", "complete"] as const) {
      for (const [fields, text] of [
        [{ email: "not-an-email" }, "Enter a valid email address."],
        [{ name: "" }, "Enter a name of 1 to 100 characters."],
        [{ password: short, password_confirm: short }, "at least 12 characters"],
        [{ password_confirm: `${PASSWORD}x` }, "The passwords do not match."],
      ] as const) {
        const r = await client.post("/setup/owner", { ...ownerFields(api.url, action), ...fields });
        expect(r.status).toBe(422);
        expect(r.body).toContain(text);
      }
    }
    expect(api.requests).toHaveLength(0);
  });

  test("the first owner page shows the missing-token instruction only without a token", async () => {
    const text =
      "The console has no pulse-api token. Set PULSE_CONSOLE_ADMIN_TOKEN_FILE and restart the console.";
    const without = new Client(await startConsole({ adminToken: undefined }));
    await without.unlock();
    expect((await without.get("/setup/owner")).body).toContain(text);
    const withToken = new Client(await startConsole());
    await withToken.unlock();
    expect((await withToken.get("/setup/owner")).body).not.toContain(text);
  });

  test("the form defaults to PULSE_API_URL and holds the exact CSRF field", async () => {
    const c = await startConsole({ defaultApiUrl: "http://api:3000" });
    const client = new Client(c);
    await client.unlock();
    const page = await client.get("/setup/owner");
    expect(page.body).toContain('value="http://api:3000"');
    expect(page.body).toContain(
      `<input type="hidden" name="csrf" value="${client.jar.get("pulse_console_csrf")}">`,
    );
    expect(page.body).toContain('autocomplete="new-password"');
    expect(page.body).toContain('autocomplete="username"');
    expect(page.body).toContain('<label for="field-email">');
  });
});

describe("connection test", () => {
  test("Checks: 3 and Checks: 0 render the exact result and save nothing", async () => {
    let checks = 3;
    const api = startApi((path) => okFor(path, checks));
    const c = await startConsole();
    const client = new Client(c);
    await client.unlock();
    const three = await client.post("/setup/owner", ownerFields(api.url, "test"));
    expect(three.status).toBe(200);
    expectConnected(three.body, 3);
    expect(three.body).not.toContain("admin scope was not checked");
    checks = 0;
    const zero = await client.post("/setup/owner", ownerFields(`${api.url}/`, "test"));
    expectConnected(zero.body, 0);
    expect(api.requests.map((r) => r.path)).toEqual([
      "/admin/config",
      "/admin/tokens/self",
      "/admin/config",
      "/admin/tokens/self",
    ]);
    expect(api.requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(c.store.instance()).toBeUndefined();
    expect(userCount(c.dbPath)).toBe(0);
    for (const r of client.responses) expect(r.body).not.toContain(TOKEN);
  });

  test("self 404 falls back to the token list; its 200 confirms the admin scope", async () => {
    const api = startApi((path) => okFor(path, 2, 200, 404));
    const c = await startConsole();
    const client = new Client(c);
    await client.unlock();
    const res = await client.post("/setup/owner", ownerFields(api.url, "test"));
    expect(res.status).toBe(200);
    expectConnected(res.body, 2);
    expect(res.body).not.toContain("admin scope was not checked");
    expect(api.requests.map((r) => r.path)).toEqual([
      "/admin/config",
      "/admin/tokens/self",
      "/admin/tokens",
    ]);
  });

  test("a valid self answer never reaches the browser", async () => {
    const api = startApi((path) => okFor(path, 1));
    const c = await startConsole();
    const client = new Client(c);
    await client.unlock();
    const res = await client.post("/setup/owner", ownerFields(api.url, "test"));
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(SELF_ID);
    expect(res.body).not.toContain(TOKEN);
  });

  test("self 404 and tokens 404 add the scope notice", async () => {
    const api = startApi((path) => okFor(path, 2, 404, 404));
    const c = await startConsole();
    const client = new Client(c);
    await client.unlock();
    const res = await client.post("/setup/owner", ownerFields(api.url, "test"));
    expect(res.status).toBe(200);
    expect(res.body).toContain("Checks: 2.");
    expect(res.body).toContain(
      "This pulse-api has no token routes, so the admin scope was not checked.",
    );
  });

  test("failures are 502 with their fixed text and save nothing", async () => {
    const target = startApi();
    const cases: [(path: string) => Response, string][] = [
      [
        () => new Response("upstream-body-sentinel", { status: 401 }),
        "pulse-api rejected the console token.",
      ],
      [
        (p) => (p.endsWith("/config") ? new Response("x", { status: 403 }) : okFor(p, 1)),
        "The console token lacks the read or checks scope.",
      ],
      [
        (p) => (p.endsWith("/config") ? okFor(p, 1) : new Response("x", { status: 403 })),
        "The console token lacks the admin scope.",
      ],
      [
        (p) =>
          p.endsWith("/self")
            ? new Response("upstream-body-sentinel", { status: 403 })
            : okFor(p, 1),
        "The console token lacks the admin scope.",
      ],
      [
        (p) => (p.endsWith("/tokens") ? new Response("x", { status: 403 }) : okFor(p, 1, 200, 404)),
        "The console token lacks the admin scope.",
      ],
      [
        (p) => (p.endsWith("/self") ? Response.json(selfToken()) : okFor(p, 1)),
        "pulse-api sent no x-pulse-contract header.",
      ],
      [() => Response.json(config(1)), "pulse-api sent no x-pulse-contract header."],
      [
        () => Response.json(config(1), { headers: { "x-pulse-contract": "2" } }),
        "pulse-api speaks wire version 2; this console needs 1.",
      ],
      [
        () =>
          new Response(null, {
            status: 302,
            headers: { location: `${target.url}/admin/config` },
          }),
        "pulse-api answered with a redirect (302); redirects are not followed.",
      ],
    ];
    for (const [handler, text] of cases) {
      const api = startApi(handler);
      const c = await startConsole();
      const client = new Client(c);
      await client.unlock();
      const res = await client.post("/setup/owner", ownerFields(api.url, "complete"));
      expect(res.status).toBe(502);
      expect(res.body).toContain(
        '<section class="callout callout-error" role="alert" id="connection-result">',
      );
      expect(res.body).toContain(`<p>${text.replace("'", "&#39;")}</p>`);
      expect(res.body).not.toContain("upstream-body-sentinel");
      expect(c.store.instance()).toBeUndefined();
      expect(userCount(c.dbPath)).toBe(0);
    }
    expect(target.requests).toHaveLength(0);
  });

  test("without a token no request is sent and the operator text shows", async () => {
    const api = startApi();
    const c = await startConsole({ adminToken: undefined });
    const client = new Client(c);
    await client.unlock();
    const res = await client.post("/setup/owner", ownerFields(api.url, "test"));
    expect(res.status).toBe(502);
    expect(res.body).toContain(
      "The console has no pulse-api token. Set PULSE_CONSOLE_ADMIN_TOKEN_FILE and restart the console.",
    );
    expect(api.requests).toHaveLength(0);
  });
});

describe("completion", () => {
  test("complete commits once, redirects, and closes setup also for a second server", async () => {
    const api = startApi();
    const c = await startConsole();
    const client = new Client(c);
    await client.unlock();
    const done = await client.post("/setup/owner", ownerFields(`${api.url}/`, "complete"));
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/account/authenticator");
    expect(c.store.instance()?.apiUrl).toBe(api.url);
    expect(userCount(c.dbPath)).toBe(1);
    const complete = c.logs.find((l) => l.includes('"setup complete"'));
    expect(complete).toContain(`"apiOrigin":"${api.url}"`);
    expect(complete).toContain('"checks":3');

    const signIn = await client.get("/sign-in?setup=done");
    expect(signIn.status).toBe(200);
    expect(signIn.body).toContain("Setup is complete. Sign in.");
    expect(signIn.body).toContain('autocomplete="current-password"');
    // Finish setup started an enrolment session: protected pages lead to enrolment.
    expect((await client.get("/")).headers.get("location")).toBe("/account/authenticator");
    expect((await client.post("/setup", { code: c.code })).status).toBe(404);
    expect((await client.get("/setup")).status).toBe(404);
    expect((await client.get("/setup/owner")).status).toBe(404);
    expect((await client.post("/setup/owner", ownerFields(api.url, "complete"))).status).toBe(404);

    const second = await startConsole({ dbPath: c.dbPath });
    const other = new Client(second);
    expect((await other.get("/setup")).status).toBe(404);
    expect((await other.post("/setup", { code: second.code })).status).toBe(404);

    await other.get("/sign-in");
    const signedIn = await other.post("/sign-in", {
      email: OWNER_EMAIL,
      password: PASSWORD,
      next: "/",
    });
    expect(signedIn.status).toBe(303);
    const sessionId = other.jar.get("pulse_console_session") ?? "";
    expect(sessionId.length).toBeGreaterThan(20);
    const reader = new Database(c.dbPath, { readonly: true });
    const digestRow = reader
      .query("SELECT id_digest FROM sessions WHERE id_digest = ?")
      .all(nodeCrypto.createHash("sha256").update(sessionId).digest("hex"));
    const rawIds = reader
      .query("SELECT id_digest FROM sessions WHERE id_digest = ?")
      .all(sessionId);
    reader.close();
    expect(digestRow).toHaveLength(1);
    expect(rawIds).toHaveLength(0);

    // The database scan: the file must be read; a sidecar is skipped only when it is absent.
    const chunks: Buffer[] = [readFileSync(c.dbPath)];
    for (const suffix of ["-wal", "-shm"]) {
      try {
        chunks.push(readFileSync(c.dbPath + suffix));
      } catch (err) {
        if (!(err instanceof Error && Reflect.get(err, "code") === "ENOENT")) throw err;
      }
    }
    const all = Buffer.concat(chunks).toString("latin1");
    expect(all.split(OWNER_EMAIL).length - 1).toBeGreaterThanOrEqual(1);
    expect(all.split(TOKEN).length - 1).toBe(0);
    expect(all.split(PASSWORD).length - 1).toBe(0);
    expect(all.split(c.code).length - 1).toBe(0);
    expect(all.split(sessionId).length - 1).toBe(0);
    expect(all.startsWith("SQLite format 3\0")).toBe(true);
    expect(
      c.store.userByEmail(OWNER_EMAIL)?.passwordHash.startsWith("$argon2id$v=19$m=19456,t=2,p=1$"),
    ).toBe(true);
    for (const line of [...c.logs, ...second.logs]) {
      for (const secret of [TOKEN, PASSWORD, OWNER_EMAIL, c.code])
        expect(line).not.toContain(secret);
    }
  });

  test("a 2.0.0 api answer tests with Checks: 3 and completes with 303", async () => {
    const config200 = {
      revision: `sha256-${"2".repeat(64)}`,
      checks: [
        {
          id: "a",
          name: "A",
          url: "https://a.test",
          intervalMs: 1000,
          method: "POST",
          headers: { authorization: { keep: true } },
          body: { keep: true },
          source: "database",
        },
        { id: "b", name: "B", url: "https://b.test", intervalMs: 1000, source: "file" },
        {
          id: "h",
          name: "H",
          type: "heartbeat",
          period: 1000,
          grace: 0,
          hasSecret: true,
          source: "file",
        },
      ],
      shadowed: [
        { id: "b", name: "B db", url: "https://b.test", intervalMs: 1000, source: "database" },
      ],
      components: [],
      maintenance: [],
      file: { state: "invalid", message: "checks[0].url: is required", lastAppliedAt: 7 },
    };
    const headers = { "content-type": "application/json", "x-pulse-contract": "1" };
    const api = startApi((path) =>
      path.endsWith("/admin/config") ? Response.json(config200, { headers }) : okFor(path, 0),
    );
    const c = await startConsole();
    const client = new Client(c);
    await client.unlock();
    const tested = await client.post("/setup/owner", ownerFields(api.url, "test"));
    expect(tested.status).toBe(200);
    expectConnected(tested.body, 3);
    const done = await client.post("/setup/owner", ownerFields(api.url, "complete"));
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/account/authenticator");
    for (const r of client.responses) expect(r.body).not.toContain(TOKEN);
  });

  test("two admitted concurrent completions give one 303 and one 409", async () => {
    let waiting: (() => void)[] = [];
    const api = startApi(async (path) => {
      if (path.endsWith("/admin/config")) {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (waiting.length === 2) {
            for (const r of waiting) r();
            waiting = [];
          }
        });
      }
      return okFor(path, 1);
    });
    const c = await startConsole();
    const client = new Client(c);
    await client.unlock();
    const results = await Promise.all([
      client.post("/setup/owner", ownerFields(api.url, "complete")),
      client.post("/setup/owner", ownerFields(api.url, "complete")),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([303, 409]);
    expect(results.find((r) => r.status === 409)?.body).toContain("Setup is already complete");
    expect(userCount(c.dbPath)).toBe(1);
  });

  test("a throwing transaction is 500 and the same grant still completes", async () => {
    const api = startApi();
    let shouldThrow = true;
    const c = await startConsole({
      wrapStore: (store) => ({
        ...store,
        completeSetup: (owner, apiUrl, now) => {
          if (shouldThrow) throw new Error("disk full");
          return store.completeSetup(owner, apiUrl, now);
        },
      }),
    });
    const client = new Client(c);
    await client.unlock();
    const failed = await client.post("/setup/owner", ownerFields(api.url, "complete"));
    expect(failed.status).toBe(500);
    expect(failed.body).toContain("Setup could not be saved.");
    expect(failed.body).not.toContain(PASSWORD);
    expect(userCount(c.dbPath)).toBe(0);
    shouldThrow = false;
    const done = await client.post("/setup/owner", ownerFields(api.url, "complete"));
    expect(done.status).toBe(303);
    expect(userCount(c.dbPath)).toBe(1);
  });
});

type Recording = { status: number; headers: Headers; body: string };

/** Header and body text of one response without the parts that are intended for its client. */
function withoutIntended(r: Recording, cookies: string[], fields: string[]): string {
  const headers = [...r.headers]
    .filter(([name]) => name !== "set-cookie")
    .map(([name, v]) => `${name}: ${v}`);
  const setCookies = r.headers
    .getSetCookie()
    .filter((line) => !cookies.some((pair) => line.startsWith(`${pair};`)));
  let body = r.body;
  for (const f of fields)
    body = body.split(`<input type="hidden" name="csrf" value="${f}">`).join("");
  return [...headers, ...setCookies, body].join("\n");
}

function rawText(r: Recording): string {
  return [
    ...[...r.headers].map(([n, v]) => `${n}: ${v}`),
    ...r.headers.getSetCookie(),
    r.body,
  ].join("\n");
}

function sessionCsrfOf(body: string): string {
  const match =
    /action="\/account\/authenticator">\n<input type="hidden" name="csrf" value="([^"]+)">/.exec(
      body,
    );
  return match?.[1] ?? "";
}

describe("leak scan of the full flow", () => {
  test("secrets of each client appear only in their intended places of that client", async () => {
    const api = startApi();
    const c = await startConsole();
    const a = new Client(c);
    const b = new Client(c);
    await b.get("/setup");
    await a.unlock();
    await a.get("/setup/owner");
    expect((await a.post("/setup/owner", ownerFields(api.url, "test"))).status).toBe(200);
    expect((await a.post("/setup/owner", ownerFields(api.url, "complete"))).status).toBe(303);
    await a.get("/sign-in?setup=done");
    const signedIn = await a.post("/sign-in", {
      email: OWNER_EMAIL,
      password: PASSWORD,
      next: "/",
    });
    expect(signedIn.status).toBe(303);
    const sessionA = a.jar.get("pulse_console_session") ?? "";
    expect(signedIn.headers.get("location")).toBe("/account/authenticator");
    const landingA = await a.get("/account/authenticator");
    expect(landingA.status).toBe(200);
    const sessionCsrfA = sessionCsrfOf(landingA.body);
    expect(sessionCsrfA.length).toBeGreaterThan(20);

    expect(
      (await b.post("/sign-in", { email: OWNER_EMAIL, password: "wrong-password-1" })).status,
    ).toBe(401);
    expect((await b.post("/sign-in", { email: OWNER_EMAIL, password: PASSWORD })).status).toBe(303);
    const sessionB = b.jar.get("pulse_console_session") ?? "";
    const landingB = await b.get("/account/authenticator");
    const sessionCsrfB = sessionCsrfOf(landingB.body);
    expect(sessionCsrfB.length).toBeGreaterThan(20);
    expect(sessionCsrfB).not.toBe(sessionCsrfA);

    const out = await a.post("/sign-out", { csrf: sessionCsrfA });
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/sign-in");
    expect(out.headers.getSetCookie().some((l) => l.startsWith("pulse_console_session=;"))).toBe(
      true,
    );
    await a.get("/sign-in");
    const metrics = await b.get("/metrics");
    expect(metrics.status).toBe(200);

    const csrfA = a.jar.get("pulse_console_csrf") ?? "";
    const csrfB = b.jar.get("pulse_console_csrf") ?? "";
    // The grant cookie was deleted at completion; read it from its first Set-Cookie.
    const grantLine = a.responses
      .flatMap((r) => r.headers.getSetCookie())
      .find((l) => /^pulse_console_setup=[^;]/.test(l));
    const grantA = (grantLine ?? "").slice("pulse_console_setup=".length).split(";")[0] ?? "";
    expect(grantA.length).toBeGreaterThan(20);
    const secretsA = [csrfA, grantA, sessionA, sessionCsrfA];
    const secretsB = [csrfB, sessionB, sessionCsrfB];
    for (const s of [...secretsA, ...secretsB]) expect(s.length).toBeGreaterThan(20);
    const sentinels = [TOKEN, PASSWORD, c.code, ...secretsA, ...secretsB];

    // Positive checks: each intended disclosure is present before it is removed.
    const loginPageA = a.responses.find((r) => r.body.includes('action="/sign-in"'));
    expect(loginPageA?.body).toContain(`<input type="hidden" name="csrf" value="${csrfA}">`);
    expect(landingA.body).toContain(`<input type="hidden" name="csrf" value="${sessionCsrfA}">`);
    expect(
      signedIn.headers
        .getSetCookie()
        .some((l) => l.startsWith(`pulse_console_session=${sessionA};`)),
    ).toBe(true);

    const intendedA = [
      `pulse_console_csrf=${csrfA}`,
      `pulse_console_setup=${grantA}`,
      `pulse_console_session=${sessionA}`,
    ];
    const intendedB = [`pulse_console_csrf=${csrfB}`, `pulse_console_session=${sessionB}`];
    for (const r of a.responses) {
      const rest = withoutIntended(r, intendedA, [csrfA, sessionCsrfA]);
      for (const s of sentinels) expect(rest.split(s).length - 1).toBe(0);
      for (const s of secretsB) expect(rawText(r).split(s).length - 1).toBe(0);
    }
    for (const r of b.responses) {
      const rest = withoutIntended(r, intendedB, [csrfB, sessionCsrfB]);
      for (const s of sentinels) expect(rest.split(s).length - 1).toBe(0);
      for (const s of secretsA) expect(rawText(r).split(s).length - 1).toBe(0);
    }
    expect(c.logs.some((l) => l.includes('"password accepted"'))).toBe(true);
    for (const line of c.logs) {
      for (const s of [...sentinels, OWNER_EMAIL]) expect(line).not.toContain(s);
    }
  });
});
