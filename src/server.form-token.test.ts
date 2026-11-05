/* eslint-disable sonarjs/no-clear-text-protocols -- loopback test servers */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@lorenzh/pulse-kit";
import { createFixtureRoutes, type Recorder } from "../test/fixture-routes.ts";
import {
  START as FIXTURE_START,
  formTokenOf,
  getPage,
  postForm,
  SESSION_CSRF,
  type SignedInConsole,
  startSignedInConsole,
} from "../test/signed-in-console.ts";
import { selfToken } from "../test/token-fixtures.ts";
import { type AccountStore, createAccountStore } from "./account-store.ts";
import { openDatabase } from "./database.ts";
import { createFactorStore } from "./factor-store.ts";
import { createMetrics, type Metrics } from "./metrics.ts";
import { createCredentialVerifier, PASSWORD_HASH_OPTIONS } from "./passwords.ts";
import { createConsoleServer, listen } from "./server.ts";
import { createSetupGate } from "./setup-code.ts";
import { createTeamStore } from "./team-store.ts";

const PASSWORD = "form-token-password-sentinel-42";
const EMAIL = "owner@example.com";
const TOKEN = "form-token-admin-token-sentinel-0123456789";
const START = 5_000_000;
const RECOVERY_CODE = "0123456789abcdef0123456789abcdef";
const EXPIRED_RESEND = "This form has expired. Send it again.";
const EXPIRED_KEPT = "This form has expired. Your input is kept below. Send it again.";
const TOKEN_LINE = /<input type="hidden" name="form_token" value="([A-Za-z0-9_-]{43})">/g;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

let ownerHash: string | undefined;
async function hashOnce(): Promise<string> {
  ownerHash ??= await Bun.password.hash(PASSWORD, PASSWORD_HASH_OPTIONS);
  return ownerHash;
}

/** A pulse-api that accepts the setup connection test. */
function startApi(): string {
  const headers = { "content-type": "application/json", "x-pulse-contract": "1" };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/admin/config")) {
        const revision = `sha256-${"a".repeat(64)}`;
        return Response.json(
          { revision, checks: [], components: [], maintenance: [] },
          { headers },
        );
      }
      if (path.endsWith("/admin/tokens/self")) {
        return Response.json(selfToken(), { headers });
      }
      return Response.json({ tokens: [] }, { headers });
    },
  });
  cleanups.push(() => {
    void server.stop(true);
  });
  return `http://127.0.0.1:${server.port}`;
}

type Console = {
  base: string;
  code: string;
  store: AccountStore;
  dbPath: string;
  logs: string[];
  metrics: Metrics;
};

async function startConsole(isSetUp: boolean): Promise<Console> {
  const dir = mkdtempSync(join(tmpdir(), "console-form-token-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "console.db");
  const db = openDatabase(dbPath, {
    createFile: (path, mode) => closeSync(openSync(path, "wx", mode)),
    chmod: chmodSync,
  });
  const store = createAccountStore(db);
  if (isSetUp) {
    const passwordHash = await hashOnce();
    store.completeSetup(
      { email: EMAIL, name: "Owner", passwordHash },
      "http://api.example:3000",
      START,
    );
    db.query(
      "INSERT INTO authenticators (user_id, secret, last_step, confirmed_at) VALUES (1, ?, -1, ?)",
    ).run("fixture-secret", START);
    db.query("INSERT INTO recovery_codes (user_id, digest) VALUES (1, ?)").run(
      createHash("sha256").update(RECOVERY_CODE).digest("hex"),
    );
  }
  const randomBytes = (size: number): Uint8Array => crypto.getRandomValues(new Uint8Array(size));
  const setup = createSetupGate({ now: () => START, randomBytes });
  const logs: string[] = [];
  const metrics = createMetrics();
  const server: Server = createConsoleServer({
    instanceName: "pulse Console",
    metrics,
    log: createLogger({ level: "debug", write: (_level, line) => logs.push(line) }),
    mode: "loopback",
    publicOrigin: undefined,
    defaultApiUrl: "http://api.invalid:3000",
    adminToken: TOKEN,
    store,
    factorStore: createFactorStore(db),
    teamStore: createTeamStore(db),
    secretKey: undefined,
    gate: isSetUp ? undefined : setup.gate,
    now: () => START,
    randomBytes,
    hashPassword: (pw) => Bun.password.hash(pw, PASSWORD_HASH_OPTIONS),
    verifier: await createCredentialVerifier({
      hash: (pw) => Bun.password.hash(pw, PASSWORD_HASH_OPTIONS),
      verify: (pw, hash) => Bun.password.verify(pw, hash),
      dummySecret: "dummy secret for tests",
    }),
    // The Overview reads of the saved api.example URL must not reach the network.
    fetch: (input, init) =>
      String(input).startsWith("http://api.example")
        ? Promise.reject(new Error("no network in this test"))
        : fetch(input, init),
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
  return { base: `http://127.0.0.1:${port}`, code: setup.code, store, dbPath, logs, metrics };
}

type Reply = { status: number; headers: Headers; body: string };

async function reply(res: Response): Promise<Reply> {
  return { status: res.status, headers: res.headers, body: await res.text() };
}

function get(c: Console, path: string, cookie = ""): Promise<Reply> {
  return fetch(c.base + path, { redirect: "manual", headers: { cookie } }).then(reply);
}

function post(
  c: Console,
  path: string,
  cookie: string,
  fields: Record<string, string>,
  origin = c.base,
): Promise<Reply> {
  return fetch(c.base + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  }).then(reply);
}

function tokenOf(body: string): string {
  return [...body.matchAll(TOKEN_LINE)][0]?.[1] ?? "";
}

function cookieValue(r: Reply, name: string): string {
  const line = r.headers.getSetCookie().find((l) => l.startsWith(`${name}=`)) ?? "";
  return line.slice(name.length + 1).split(";")[0] ?? "";
}

function rowCount(dbPath: string, sql: string): number {
  const db = openDatabase(dbPath, { createFile: () => undefined, chmod: chmodSync });
  const rows = db.query(sql).all();
  db.close();
  return rows.length;
}

const sessionRows = (c: Console): number => rowCount(c.dbPath, "SELECT id_digest FROM sessions");
const userRows = (c: Console): number => rowCount(c.dbPath, "SELECT id FROM users");

/** A sign-in page: its CSRF cookie and form token. */
async function signInForm(c: Console): Promise<{ cookie: string; csrf: string; token: string }> {
  const page = await get(c, "/sign-in");
  const csrf = cookieValue(page, "pulse_console_csrf");
  return { cookie: `pulse_console_csrf=${csrf}`, csrf, token: tokenOf(page.body) };
}

async function signedIn(c: Console): Promise<{ cookie: string; csrf: string; token: string }> {
  const form = await signInForm(c);
  const fields = { csrf: form.csrf, form_token: form.token, email: EMAIL, password: PASSWORD };
  const res = await post(c, "/sign-in", form.cookie, { ...fields, next: "/" });
  expect(res.status).toBe(303);
  const partial = `pulse_console_session=${cookieValue(res, "pulse_console_session")}`;
  const factor = await get(c, "/sign-in/factor", partial);
  const factorCsrf = /name="csrf" value="([^"]+)"/.exec(factor.body)?.[1] ?? "";
  const full = await post(c, "/sign-in/factor", partial, {
    csrf: factorCsrf,
    form_token: tokenOf(factor.body),
    recovery_code: RECOVERY_CODE,
  });
  expect(full.status).toBe(303);
  const cookie = `pulse_console_session=${cookieValue(full, "pulse_console_session")}`;
  const home = await get(c, "/", cookie);
  const csrf = /name="csrf" value="([^"]+)"/.exec(home.body)?.[1] ?? "";
  return { cookie, csrf, token: tokenOf(home.body) };
}

describe("sign-in form token", () => {
  test("GET /sign-in has one form_token line after csrf, fresh per GET; HEAD has no body", async () => {
    const c = await startConsole(true);
    const first = await get(c, "/sign-in", "pulse_console_csrf=fixed-csrf-value");
    const second = await get(c, "/sign-in", "pulse_console_csrf=fixed-csrf-value");
    expect([...first.body.matchAll(TOKEN_LINE)]).toHaveLength(1);
    expect(first.body).toContain(
      `<input type="hidden" name="csrf" value="fixed-csrf-value">\n<input type="hidden" name="form_token" value="${tokenOf(first.body)}">`,
    );
    expect(tokenOf(first.body)).not.toBe(tokenOf(second.body));
    expect(first.body).not.toContain("<script");
    const head = await fetch(`${c.base}/sign-in`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("the sign-in page without the form_token line equals the page of main", async () => {
    const c = await startConsole(true);
    const page = await get(c, "/sign-in", "pulse_console_csrf=fixed-csrf-value");
    const frozen =
      '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1">\n    <title>Sign in · pulse Console</title>\n    <link rel="stylesheet" href="/console.css">\n  </head>\n  <body class="plain">\n<header class="plain-head"><p class="wordmark"><span class="wordmark-name">pulse</span><span class="cursor" aria-hidden="true"></span><span class="pill">self-hosted</span></p></header>\n<main class="plain-main"><div class="panel plain-panel">\n<h1>Sign in</h1>\n<form method="post" action="/sign-in">\n<input type="hidden" name="csrf" value="fixed-csrf-value">\n<input type="hidden" name="next" value="/">\n<label for="field-email">Email\n<input id="field-email" name="email" type="email" autocomplete="username" required>\n</label>\n<label for="field-password">Password\n<input id="field-password" name="password" type="password" autocomplete="current-password" required>\n</label>\n<div class="actions"><button type="submit">Sign in</button></div>\n</form>\n</div></main>\n  </body>\n</html>\n';
    expect(page.body.replace(TOKEN_LINE, "").replace("\n\n", "\n")).toBe(frozen);
  });

  test("a replayed sign-in is 409 Already submitted without a second session", async () => {
    const c = await startConsole(true);
    const form = await signInForm(c);
    const fields = { csrf: form.csrf, form_token: form.token, email: EMAIL, password: PASSWORD };
    const first = await post(c, "/sign-in", form.cookie, { ...fields, next: "/" });
    expect(first.status).toBe(303);
    expect(cookieValue(first, "pulse_console_session")).not.toBe("");
    const second = await post(c, "/sign-in", form.cookie, { ...fields, next: "/" });
    expect(second.status).toBe(409);
    expect(second.body).toContain("Already submitted");
    expect(second.body).toContain('href="/sign-in"');
    expect(second.body).not.toContain("<script");
    expect(second.headers.getSetCookie()).toEqual([]);
    expect(sessionRows(c)).toBe(1);
    const metrics = c.metrics.render();
    expect(metrics).toContain(
      'pulse_console_auth_attempts_total{kind="sign-in",result="success"} 1',
    );
    expect(metrics).not.toContain('result="failure"');
    const refused = c.logs.filter((l) => l.includes("form token refused"));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("replayed");
    for (const line of c.logs) expect(line).not.toContain(form.token);
  });

  test("two concurrent sign-ins with one token give one 303 and one 409", async () => {
    const c = await startConsole(true);
    const form = await signInForm(c);
    const fields = { csrf: form.csrf, form_token: form.token, email: EMAIL, password: PASSWORD };
    const answers = await Promise.all([
      post(c, "/sign-in", form.cookie, fields),
      post(c, "/sign-in", form.cookie, fields),
    ]);
    expect(answers.map((a) => a.status).sort((x, y) => x - y)).toEqual([303, 409]);
    expect(sessionRows(c)).toBe(1);
    expect(c.metrics.render()).toContain(
      'pulse_console_auth_attempts_total{kind="sign-in",result="success"} 1',
    );
  });

  test("a sign-in without a token is 409 with next kept, then a fresh token signs in", async () => {
    const c = await startConsole(true);
    const form = await signInForm(c);
    const fields = { csrf: form.csrf, email: EMAIL, password: PASSWORD, next: "/kept" };
    const missing = await post(c, "/sign-in", form.cookie, fields);
    expect(missing.status).toBe(409);
    expect(missing.body).toContain(EXPIRED_RESEND);
    expect(missing.body).toContain('<input type="hidden" name="next" value="/kept">');
    expect(missing.headers.getSetCookie()).toEqual([]);
    expect(sessionRows(c)).toBe(0);
    expect(c.metrics.render()).not.toContain('result="failure"');
    const fresh = tokenOf(missing.body);
    expect(fresh).not.toBe("");
    const ok = await post(c, "/sign-in", form.cookie, { ...fields, form_token: fresh });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/sign-in/factor");
    const sessionId = cookieValue(ok, "pulse_console_session");
    expect(c.store.session(sessionId)?.nextPath).toBe("/kept");
    expect(c.logs.some((l) => l.includes("form token refused") && l.includes("invalid"))).toBe(
      true,
    );
  });

  test("five wrong passwords with one token give 401 five times, then 429", async () => {
    const c = await startConsole(true);
    const form = await signInForm(c);
    const base = { csrf: form.csrf, form_token: form.token, email: EMAIL };
    for (let i = 0; i < 5; i++) {
      const res = await post(c, "/sign-in", form.cookie, { ...base, password: `wrong-${i}` });
      expect(res.status).toBe(401);
      expect(tokenOf(res.body)).not.toBe(form.token);
    }
    const locked = await post(c, "/sign-in", form.cookie, { ...base, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(sessionRows(c)).toBe(0);
  });

  test("a token of another CSRF cookie, or of another path, is refused as expired", async () => {
    const c = await startConsole(true);
    const a = await signInForm(c);
    const b = await signInForm(c);
    const fields = { csrf: b.csrf, form_token: a.token, email: EMAIL, password: PASSWORD };
    const res = await post(c, "/sign-in", b.cookie, fields);
    expect(res.status).toBe(409);
    expect(res.body).toContain(EXPIRED_RESEND);
    expect(sessionRows(c)).toBe(0);
  });

  test("a POST refused by the CSRF check does not use up its token", async () => {
    const c = await startConsole(true);
    const form = await signInForm(c);
    const fields = { form_token: form.token, email: EMAIL, password: PASSWORD };
    const refused = await post(c, "/sign-in", form.cookie, { ...fields, csrf: "wrong" });
    expect(refused.status).toBe(403);
    const ok = await post(c, "/sign-in", form.cookie, { ...fields, csrf: form.csrf });
    expect(ok.status).toBe(303);
  });

  test("a repeated form_token field is 400", async () => {
    const c = await startConsole(true);
    const form = await signInForm(c);
    const res = await fetch(`${c.base}/sign-in`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: form.cookie,
        origin: c.base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `csrf=${form.csrf}&form_token=${form.token}&form_token=${form.token}`,
    });
    expect(res.status).toBe(400);
  });
});

describe("sign-out form token", () => {
  test("the shell carries the sign-out token after csrf and the one script element", async () => {
    const c = await startConsole(true);
    const s = await signedIn(c);
    const home = await get(c, "/", s.cookie);
    expect(home.status).toBe(200);
    expect(home.body).toContain(
      `<form method="post" action="/sign-out" class="sign-out">\n<input type="hidden" name="csrf" value="${s.csrf}">\n<input type="hidden" name="form_token" value="${tokenOf(home.body)}">`,
    );
    expect(home.body.split("<script")).toHaveLength(2);
    expect(home.body).toContain('<script src="/console.js" defer></script>');
    expect(home.body).toContain("pulse-api: http://api.example:3000");
    expect(home.body).not.toMatch(/\son[a-z]+=/);
    expect(home.body).not.toContain("style=");
  });

  test("a replayed sign-out is 409 with the old cookie and with none", async () => {
    const c = await startConsole(true);
    const s = await signedIn(c);
    const fields = { csrf: s.csrf, form_token: s.token };
    const first = await post(c, "/sign-out", s.cookie, fields);
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/sign-in");
    const again = await post(c, "/sign-out", s.cookie, fields);
    expect(again.status).toBe(409);
    expect(again.body).toContain("Already submitted");
    expect(again.body).toContain('href="/sign-in"');
    const noCookie = await post(c, "/sign-out", "", fields);
    expect(noCookie.status).toBe(409);
    expect(noCookie.body).toContain("Already submitted");
    expect(sessionRows(c)).toBe(0);
  });

  test("two concurrent sign-outs with one token give one 303 and one 409", async () => {
    const c = await startConsole(true);
    const s = await signedIn(c);
    const fields = { csrf: s.csrf, form_token: s.token };
    const answers = await Promise.all([
      post(c, "/sign-out", s.cookie, fields),
      post(c, "/sign-out", s.cookie, fields),
    ]);
    expect(answers.map((a) => a.status).sort((x, y) => x - y)).toEqual([303, 409]);
    expect(sessionRows(c)).toBe(0);
  });

  test("a sign-out with a live session and no token shows the shell page Sign out", async () => {
    const c = await startConsole(true);
    const s = await signedIn(c);
    const res = await post(c, "/sign-out", s.cookie, { csrf: s.csrf });
    expect(res.status).toBe(409);
    expect(res.body).toContain("<h1>Sign out</h1>");
    expect(res.body).toContain(EXPIRED_RESEND);
    expect(tokenOf(res.body)).not.toBe("");
    expect(sessionRows(c)).toBe(1);
  });

  test("without a session: no token is 303 without Set-Cookie, a bad Origin is 403", async () => {
    const c = await startConsole(true);
    const plain = await post(c, "/sign-out", "", {});
    expect(plain.status).toBe(303);
    expect(plain.headers.get("location")).toBe("/sign-in");
    expect(plain.headers.getSetCookie()).toEqual([]);
    const evil = await post(c, "/sign-out", "", {}, "http://evil.example");
    expect(evil.status).toBe(403);
    expect(evil.body).toContain("Request refused");
  });
});

/** Unlocks setup and returns the cookies of the owner form and its token. */
async function unlocked(c: Console): Promise<{ cookie: string; csrf: string; token: string }> {
  const page = await get(c, "/setup");
  const csrf = cookieValue(page, "pulse_console_csrf");
  const cookie = `pulse_console_csrf=${csrf}`;
  const fields = { csrf, form_token: tokenOf(page.body), code: c.code };
  const unlock = await post(c, "/setup", cookie, fields);
  expect(unlock.status).toBe(303);
  const grant = `pulse_console_setup=${cookieValue(unlock, "pulse_console_setup")}`;
  const owner = await get(c, "/setup/owner", `${cookie}; ${grant}`);
  return { cookie: `${cookie}; ${grant}`, csrf, token: tokenOf(owner.body) };
}

function ownerFields(apiUrl: string, action: string): Record<string, string> {
  return {
    api_url: apiUrl,
    email: EMAIL,
    name: "Owner",
    password: PASSWORD,
    password_confirm: PASSWORD,
    action,
  };
}

describe("setup form token", () => {
  test("GET /setup and /setup/owner have one fresh form_token line after csrf", async () => {
    const c = await startConsole(false);
    const page = await get(c, "/setup");
    const csrf = cookieValue(page, "pulse_console_csrf");
    const again = await get(c, "/setup", `pulse_console_csrf=${csrf}`);
    expect([...page.body.matchAll(TOKEN_LINE)]).toHaveLength(1);
    expect(page.body).toContain(
      `name="csrf" value="${csrf}">\n<input type="hidden" name="form_token" value="${tokenOf(page.body)}">`,
    );
    expect(tokenOf(again.body)).not.toBe(tokenOf(page.body));
    const owner = await unlocked(c);
    const ownerPage = await get(c, "/setup/owner", owner.cookie);
    expect([...ownerPage.body.matchAll(TOKEN_LINE)]).toHaveLength(1);
    expect(ownerPage.body).toContain(
      `name="csrf" value="${owner.csrf}">\n<input type="hidden" name="form_token" value="${tokenOf(ownerPage.body)}">`,
    );
    expect(ownerPage.body).not.toContain("<script");
  });

  test("a replayed setup code is 409 Already submitted and sets no second grant", async () => {
    const c = await startConsole(false);
    const page = await get(c, "/setup");
    const csrf = cookieValue(page, "pulse_console_csrf");
    const cookie = `pulse_console_csrf=${csrf}`;
    const fields = { csrf, form_token: tokenOf(page.body), code: c.code };
    const first = await post(c, "/setup", cookie, fields);
    expect(first.status).toBe(303);
    expect(cookieValue(first, "pulse_console_setup")).not.toBe("");
    const second = await post(c, "/setup", cookie, fields);
    expect(second.status).toBe(409);
    expect(second.body).toContain("Already submitted");
    expect(second.headers.getSetCookie()).toEqual([]);
  });

  test("a token of another page with the right code is refused as expired", async () => {
    const c = await startConsole(false);
    const owner = await unlocked(c);
    const csrfCookie = `pulse_console_csrf=${owner.csrf}`;
    const fields = { csrf: owner.csrf, form_token: owner.token, code: c.code };
    const res = await post(c, "/setup", csrfCookie, fields);
    expect(res.status).toBe(409);
    expect(res.body).toContain(EXPIRED_RESEND);
    expect(res.body).not.toContain(c.code);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("action=test twice with one token gives 200 both times", async () => {
    const api = startApi();
    const c = await startConsole(false);
    const o = await unlocked(c);
    const fields = { csrf: o.csrf, form_token: o.token, ...ownerFields(api, "test") };
    expect((await post(c, "/setup/owner", o.cookie, fields)).status).toBe(200);
    expect((await post(c, "/setup/owner", o.cookie, fields)).status).toBe(200);
    expect(userRows(c)).toBe(0);
  });

  test("a complete without a token is 409 with the input kept and passwords empty", async () => {
    const api = startApi();
    const c = await startConsole(false);
    const o = await unlocked(c);
    const res = await post(c, "/setup/owner", o.cookie, {
      csrf: o.csrf,
      ...ownerFields(api, "complete"),
    });
    expect(res.status).toBe(409);
    expect(res.body).toContain(EXPIRED_KEPT);
    expect(res.body).toContain(`value="${EMAIL}"`);
    expect(res.body).not.toContain(PASSWORD);
    expect(userRows(c)).toBe(0);
  });

  test("one token completed twice at once gives one 303 and one 409 Already submitted", async () => {
    const api = startApi();
    const c = await startConsole(false);
    const o = await unlocked(c);
    const fields = { csrf: o.csrf, form_token: o.token, ...ownerFields(api, "complete") };
    const answers = await Promise.all([
      post(c, "/setup/owner", o.cookie, fields),
      post(c, "/setup/owner", o.cookie, fields),
    ]);
    expect(answers.map((a) => a.status).sort((x, y) => x - y)).toEqual([303, 409]);
    expect(answers.find((a) => a.status === 409)?.body).toContain("Already submitted");
    expect(userRows(c)).toBe(1);
    const after = await post(c, "/setup/owner", o.cookie, fields);
    expect(after.status).toBe(404);
    expect(after.body).toBe("not found\n");
  });

  test("two tokens completed at once keep the database guard 409", async () => {
    const api = startApi();
    const c = await startConsole(false);
    const o = await unlocked(c);
    const second = tokenOf((await get(c, "/setup/owner", o.cookie)).body);
    const fields = { csrf: o.csrf, ...ownerFields(api, "complete") };
    const answers = await Promise.all([
      post(c, "/setup/owner", o.cookie, { ...fields, form_token: o.token }),
      post(c, "/setup/owner", o.cookie, { ...fields, form_token: second }),
    ]);
    expect(answers.map((a) => a.status).sort((x, y) => x - y)).toEqual([303, 409]);
    expect(answers.find((a) => a.status === 409)?.body).toContain("Setup is already complete");
    expect(userRows(c)).toBe(1);
  });
});

describe("form tokens on protected routes", () => {
  const BUSY = "/__test/states/busy";
  type Fixture = {
    c: SignedInConsole;
    recorder: Recorder;
    setRole: (r: "viewer" | "owner") => void;
  };

  async function fixtures(): Promise<Fixture> {
    const recorder: Recorder = { actions: [] };
    let role: "viewer" | "owner" = "owner";
    const c = await startSignedInConsole({
      apiUrl: "http://127.0.0.1:9",
      testRoutes: createFixtureRoutes({ recorder }),
      roleOf: () => role,
    });
    cleanups.push(() => c.close());
    return { c, recorder, setRole: (r) => (role = r) };
  }

  async function busyToken(c: SignedInConsole, cookie = c.cookie): Promise<string> {
    return formTokenOf((await getPage(c, BUSY, cookie)).body, BUSY);
  }

  function busyBody(token: string): Record<string, string> {
    return { csrf: SESSION_CSRF, form_token: token, choice: "kept-choice", action: "go" };
  }

  test("the same body twice: 200 Submitted: go, then 409 Already submitted", async () => {
    const { c, recorder } = await fixtures();
    const token = await busyToken(c);
    const first = await postForm(c, BUSY, busyBody(token));
    expect(first.status).toBe(200);
    expect(first.body).toContain("Submitted: go");
    expect(formTokenOf(first.body, BUSY)).not.toBe(token);
    const second = await postForm(c, BUSY, busyBody(token));
    expect(second.status).toBe(409);
    expect(second.body).toContain('<h2 class="callout-title">Already submitted</h2>');
    expect(second.body).toContain(`<a href="${BUSY}">Open the page again</a>`);
    expect(recorder.actions).toEqual([{ action: "go", choice: "kept-choice" }]);
    const refused = c.logs.filter((l) => l.includes("form token refused"));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain('"reason":"replayed","path":"/__test/states/busy"');
    for (const line of c.logs) expect(line).not.toContain(token);
  });

  test("two concurrent POSTs with one token give one 200 and one 409", async () => {
    const { c, recorder } = await fixtures();
    const token = await busyToken(c);
    const answers = await Promise.all([
      postForm(c, BUSY, busyBody(token)),
      postForm(c, BUSY, busyBody(token)),
    ]);
    expect(answers.map((a) => a.status).sort((x, y) => x - y)).toEqual([200, 409]);
    expect(recorder.actions).toHaveLength(1);
  });

  const refusals: Array<[string, (f: Fixture) => Promise<string>]> = [
    ["missing", () => Promise.resolve("")],
    ["empty", () => Promise.resolve("")],
    [
      "wrong session",
      async ({ c }) => {
        const owner = c.store.userByEmail("owner@example.com");
        if (owner === undefined) throw new Error("owner missing");
        c.store.createSession(
          "other-session-id-0123456789abcdefghijklmno",
          owner.id,
          "x",
          FIXTURE_START,
        );
        return busyToken(c, "pulse_console_session=other-session-id-0123456789abcdefghijklmno");
      },
    ],
    [
      "wrong path",
      async ({ c }) => {
        const path = "/__test/states/conflict-409";
        return formTokenOf((await getPage(c, path)).body, path);
      },
    ],
    [
      "expired",
      async ({ c }) => {
        const token = await busyToken(c);
        c.setNow(FIXTURE_START + 43_200_000);
        return token;
      },
    ],
    [
      "evicted",
      async ({ c }) => {
        const token = await busyToken(c);
        for (let i = 0; i < 100; i++) await busyToken(c);
        return token;
      },
    ],
  ];
  for (const [name, tokenFor] of refusals) {
    test(`a ${name} token gives 409 with the form again and no action`, async () => {
      const f = await fixtures();
      const token = await tokenFor(f);
      const body = busyBody(token);
      if (name === "missing") delete body.form_token;
      const res = await postForm(f.c, BUSY, body);
      expect(res.status).toBe(409);
      expect(res.body).toContain("This form has expired. Your input is kept below. Send it again.");
      expect(res.body).toContain('value="kept-choice"');
      expect(formTokenOf(res.body, BUSY)).toHaveLength(43);
      expect(f.recorder.actions).toHaveLength(0);
      const refused = f.c.logs.filter((l) => l.includes("form token refused"));
      expect(refused).toHaveLength(1);
      expect(refused[0]).toContain('"reason":"invalid"');
      if (token !== "") for (const line of f.c.logs) expect(line).not.toContain(token);
    });
  }

  test("expiry boundary: 43_199_999 ms is still accepted", async () => {
    const { c, recorder } = await fixtures();
    const token = await busyToken(c);
    c.setNow(FIXTURE_START + 43_199_999);
    expect((await postForm(c, BUSY, busyBody(token))).status).toBe(200);
    expect(recorder.actions).toHaveLength(1);
  });

  test("a re-rendered form submits with its fresh token", async () => {
    const { c, recorder } = await fixtures();
    const stale = await postForm(c, BUSY, busyBody("unknown-token"));
    expect(stale.status).toBe(409);
    const res = await postForm(c, BUSY, busyBody(formTokenOf(stale.body, BUSY)));
    expect(res.status).toBe(200);
    expect(recorder.actions).toHaveLength(1);
  });

  test("a wrong CSRF or Origin 403 leaves the token usable", async () => {
    const { c, recorder } = await fixtures();
    const token = await busyToken(c);
    const wrongCsrf = await postForm(c, BUSY, { ...busyBody(token), csrf: "wrong" });
    expect(wrongCsrf.status).toBe(403);
    expect(wrongCsrf.body).toContain("Request refused");
    const badOrigin = await postForm(c, BUSY, busyBody(token), { origin: "http://evil.example" });
    expect(badOrigin.status).toBe(403);
    expect(recorder.actions).toHaveLength(0);
    expect((await postForm(c, BUSY, busyBody(token))).status).toBe(200);
    expect(recorder.actions).toHaveLength(1);
  });

  test("a role 403 runs after CSRF and leaves the token usable", async () => {
    const recorder: Recorder = { actions: [] };
    const routes = createFixtureRoutes({ recorder });
    const busy = routes.get(BUSY);
    if (busy === undefined) throw new Error("busy fixture missing");
    const ADMIN = "/__test/admin-busy";
    let role: "viewer" | "admin" = "viewer";
    const c = await startSignedInConsole({
      apiUrl: "http://127.0.0.1:9",
      testRoutes: new Map([[ADMIN, { ...busy, path: ADMIN, requiredRole: "admin" }]]),
      roleOf: () => role,
    });
    cleanups.push(() => c.close());
    role = "admin";
    const token = formTokenOf((await getPage(c, ADMIN)).body, ADMIN);
    role = "viewer";
    const crossSite = await postForm(c, ADMIN, { ...busyBody(token), csrf: "wrong" });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body).toContain("Request refused");
    const forged = await postForm(c, ADMIN, { ...busyBody(token), role: "owner" });
    expect(forged.status).toBe(403);
    expect(forged.body).toContain("This page needs the Admin role or higher. Your role is Viewer.");
    expect(recorder.actions).toHaveLength(0);
    role = "admin";
    expect((await postForm(c, ADMIN, busyBody(token))).status).toBe(200);
    expect(recorder.actions).toHaveLength(1);
  });

  test("2001 anonymous sign-in views do not evict a session form token", async () => {
    const { c, recorder } = await fixtures();
    const token = await busyToken(c);
    for (let i = 0; i < 2001; i++) {
      await fetch(`${c.base}/sign-in`, { headers: { cookie: "pulse_console_csrf=same-anon" } });
    }
    expect((await postForm(c, BUSY, busyBody(token))).status).toBe(200);
    expect(recorder.actions).toHaveLength(1);
  });
});
