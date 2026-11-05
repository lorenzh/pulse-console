/* eslint-disable sonarjs/no-clear-text-protocols -- loopback test servers */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@lorenzh/pulse-kit";
import { type AccountStore, createAccountStore } from "./account-store.ts";
import { openDatabase } from "./database.ts";
import { createFactorStore } from "./factor-store.ts";
import { createMetrics, type Metrics } from "./metrics.ts";
import { createCredentialVerifier, PASSWORD_HASH_OPTIONS } from "./passwords.ts";
import { sealSecret } from "./secret-box.ts";
import { createConsoleServer, listen } from "./server.ts";

const TEST_SECRET_KEY = Uint8Array.from(Buffer.from("0123456789abcdef".repeat(4), "hex"));

const PASSWORD = "sign-in-password-sentinel-42";
const EMAIL = "owner-sentinel@example.com";
const START = 5_000_000;
const SESSION = "pulse_console_session";
const SEED = Buffer.from("12345678901234567890", "ascii");

/** RFC 6238 SHA-1, 6 digits, written here so it does not depend on the code under test. */
function totpCode(step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", SEED).update(counter).digest();
  const offset = (mac[19] ?? 0) & 0xf;
  return String((mac.readUInt32BE(offset) % 2_147_483_648) % 1_000_000).padStart(6, "0");
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

let ownerHash: string | undefined;
async function hashOnce(): Promise<string> {
  ownerHash ??= await Bun.password.hash(PASSWORD, PASSWORD_HASH_OPTIONS);
  return ownerHash;
}

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "console-sign-in-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "console.db");
}

type Console = {
  base: string;
  store: AccountStore;
  dbPath: string;
  logs: string[];
  clock: { now: number };
  verifications: { count: number };
  metrics: Metrics;
  lastStep: { step: number };
};

async function startConsole(
  opts: {
    dbPath?: string;
    clock?: { now: number };
    failing?: { method: keyof AccountStore | undefined };
  } = {},
): Promise<Console> {
  const dbPath = opts.dbPath ?? tempDb();
  const db = openDatabase(dbPath, {
    createFile: (path, mode) => closeSync(openSync(path, "wx", mode)),
    chmod: chmodSync,
  });
  const realStore = createAccountStore(db);
  const failing = opts.failing;
  const store: AccountStore =
    failing === undefined
      ? realStore
      : new Proxy(realStore, {
          get(target, key, receiver) {
            if (typeof key === "string" && key === String(failing.method)) {
              return () => {
                throw new Error("database is locked");
              };
            }
            return Reflect.get(target, key, receiver);
          },
        });
  if (store.instance() === undefined) {
    const passwordHash = await hashOnce();
    store.completeSetup(
      { email: EMAIL, name: "Owner <Sentinel>", passwordHash },
      "http://api.example:3000/pulse",
      START,
    );
    // An enrolled owner, so a password leads to the factor step.
    const secret = sealSecret(TEST_SECRET_KEY, 1, SEED, (n) => new Uint8Array(n).fill(9));
    db.query(
      "INSERT INTO authenticators (user_id, secret, last_step, confirmed_at) VALUES (1, ?, 0, ?)",
    ).run(secret, START);
  }
  const clock = opts.clock ?? { now: START };
  const verifications = { count: 0 };
  const verifier = await createCredentialVerifier({
    hash: (pw) => Bun.password.hash(pw, PASSWORD_HASH_OPTIONS),
    verify: (pw, hash) => {
      verifications.count += 1;
      return Bun.password.verify(pw, hash);
    },
    dummySecret: "dummy secret for tests",
  });
  const logs: string[] = [];
  const metrics = createMetrics();
  const server: Server = createConsoleServer({
    metrics,
    log: createLogger({ level: "debug", write: (_level, line) => logs.push(line) }),
    mode: "loopback",
    publicOrigin: undefined,
    defaultApiUrl: "http://api.invalid:3000",
    adminToken: undefined,
    store,
    factorStore: createFactorStore(db),
    secretKey: TEST_SECRET_KEY,
    gate: undefined,
    now: () => clock.now,
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
    hashPassword: (pw) => Bun.password.hash(pw, PASSWORD_HASH_OPTIONS),
    verifier,
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
  verifications.count = 0;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    dbPath,
    logs,
    clock,
    verifications,
    metrics,
    lastStep: { step: 0 },
  };
}

type Reply = { status: number; headers: Headers; body: string };

class Client {
  readonly jar = new Map<string, string>();
  readonly c: Console;
  constructor(c: Console) {
    this.c = c;
  }

  private remember(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const index = pair.indexOf("=");
      if (line.includes("Max-Age=0")) this.jar.delete(pair.slice(0, index));
      else this.jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  private cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async get(path: string): Promise<Reply> {
    const res = await fetch(this.c.base + path, {
      redirect: "manual",
      headers: { cookie: this.cookieHeader() },
    });
    this.remember(res);
    return { status: res.status, headers: res.headers, body: await res.text() };
  }

  async post(
    path: string,
    fields: Record<string, string>,
    extra: Record<string, string> = {},
  ): Promise<Reply> {
    const body = new URLSearchParams({ csrf: this.jar.get("pulse_console_csrf") ?? "", ...fields });
    const res = await fetch(this.c.base + path, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: this.cookieHeader(),
        origin: this.c.base,
        "content-type": "application/x-www-form-urlencoded",
        ...extra,
      },
      body: body.toString(),
    });
    this.remember(res);
    return { status: res.status, headers: res.headers, body: await res.text() };
  }

  async signIn(email = EMAIL, password = PASSWORD, next = "/"): Promise<Reply> {
    if (!this.jar.has("pulse_console_csrf")) await this.get("/sign-in");
    return this.post("/sign-in", { email, password, next });
  }

  /** Password, then a fresh TOTP code; the clock moves to the next step when one was used. */
  async signInFull(next = "/"): Promise<Reply> {
    const password = await this.signIn(EMAIL, PASSWORD, next);
    expect(password.headers.get("location")).toBe("/sign-in/factor");
    const page = await this.get("/sign-in/factor");
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? "";
    let step = Math.floor(this.c.clock.now / 30_000);
    if (step <= this.c.lastStep.step) {
      step = this.c.lastStep.step + 1;
      this.c.clock.now = step * 30_000;
    }
    this.c.lastStep.step = step;
    return this.post("/sign-in/factor", { csrf, code: totpCode(step) });
  }
}

function withoutCsrf(html: string): string {
  return html.replace(/name="csrf" value="[^"]*"/, "");
}

function sessionRows(dbPath: string): string[] {
  const db = openDatabase(dbPath, { createFile: () => undefined, chmod: chmodSync });
  const rows = db.query("SELECT id_digest AS d FROM sessions").all();
  db.close();
  return rows.map((r) => String(typeof r === "object" && r !== null ? Reflect.get(r, "d") : ""));
}

describe("credentials", () => {
  test("wrong and unknown accounts get the same 401 page and both run verification", async () => {
    const c = await startConsole();
    const client = new Client(c);
    const wrong = await client.signIn(EMAIL, "wrong-password-123");
    expect(c.verifications.count).toBe(1);
    const unknown = await client.signIn("nobody@example.com", "wrong-password-123");
    expect(c.verifications.count).toBe(2);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toContain("Wrong email or password.");
    expect(withoutCsrf(unknown.body)).toBe(withoutCsrf(wrong.body));
    const all = c.logs.join("\n");
    expect(all).toContain('"sign-in failed"');
    expect(all).toContain('"reason":"credentials"');
    expect(all).not.toContain(EMAIL);
    expect(all).not.toContain("nobody@example.com");
    expect(all).not.toContain("wrong-password-123");
  });

  test("empty fields and over-128-code-point passwords are 422 and not counted", async () => {
    const c = await startConsole();
    const client = new Client(c);
    const inputs = [
      { email: "", password: PASSWORD },
      { email: EMAIL, password: "" },
      { email: "  ", password: PASSWORD },
      { email: EMAIL, password: "😀".repeat(129) },
    ];
    for (let i = 0; i < 2; i += 1) {
      for (const input of inputs) {
        expect((await client.signIn(input.email, input.password)).status).toBe(422);
      }
    }
    expect(c.verifications.count).toBe(0);
    expect((await client.signIn(EMAIL, "😀".repeat(128))).status).toBe(401);
    const ok = await client.signIn();
    expect(ok.status).toBe(303);
  });

  test("an email with spaces and capitals is normalized", async () => {
    const c = await startConsole();
    const res = await new Client(c).signIn("  Owner-Sentinel@Example.COM ");
    expect(res.status).toBe(303);
    expect(c.logs.some((l) => l.includes('"password accepted"') && l.includes('"userId":1'))).toBe(
      true,
    );
  });
});

describe("throttle", () => {
  for (const method of ["deleteSession", "deleteExpiredSessions", "createSession"] as const) {
    test(`a failed ${method} releases the reservation and never locks the owner`, async () => {
      const failing: { method: keyof AccountStore | undefined } = { method };
      const c = await startConsole({ failing });
      const client = new Client(c);
      await client.get("/sign-in");
      client.jar.set(SESSION, "stale-session-id");
      for (let i = 0; i < 6; i += 1) {
        expect((await client.signIn()).status).toBe(500);
      }
      failing.method = undefined;
      expect((await client.signIn()).status).toBe(303);
    });
  }

  test("five failures lock the account for 900 s, also for correct credentials", async () => {
    const c = await startConsole();
    const client = new Client(c);
    for (let i = 0; i < 5; i += 1) {
      expect((await client.signIn(EMAIL, "wrong-password-123")).status).toBe(401);
    }
    const t5 = c.clock.now;
    const locked = await client.signIn();
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("900");
    expect(c.verifications.count).toBe(5);
    c.clock.now = t5 + 899_999;
    expect((await client.signIn()).status).toBe(429);
    c.clock.now = t5 + 900_000;
    expect((await client.signIn()).status).toBe(303);
    expect(c.logs.some((l) => l.includes('"reason":"throttled"'))).toBe(true);
    const metrics = c.metrics.render();
    expect(metrics).toContain(
      'pulse_console_auth_attempts_total{kind="sign-in",result="failure"} 5',
    );
    expect(metrics).toContain(
      'pulse_console_auth_attempts_total{kind="sign-in",result="throttled"} 2',
    );
    expect(metrics).toContain(
      'pulse_console_auth_attempts_total{kind="sign-in",result="success"} 1',
    );
  });

  test("ten concurrent wrong attempts give exactly 5 x 401 and 5 x 429", async () => {
    const c = await startConsole();
    const client = new Client(c);
    await client.get("/sign-in");
    const replies = await Promise.all(
      Array.from({ length: 10 }, () => client.signIn(EMAIL, "wrong-password-123")),
    );
    const statuses = replies.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429, 429, 429]);
  });

  test("the client key locks across accounts and ignores forwarding headers", async () => {
    const c = await startConsole();
    const client = new Client(c);
    for (let i = 0; i < 5; i += 1) {
      expect((await client.signIn(`user${i}@example.com`, "wrong-password-123")).status).toBe(401);
    }
    await client.get("/sign-in");
    const spoofed = await client.post(
      "/sign-in",
      { email: EMAIL, password: PASSWORD, next: "/" },
      { "x-forwarded-for": "203.0.113.9", forwarded: "for=203.0.113.9" },
    );
    expect(spoofed.status).toBe(429);
  });

  test("success clears only the account failures, not the client ones", async () => {
    const c = await startConsole();
    const client = new Client(c);
    for (let i = 0; i < 4; i += 1) await client.signIn(EMAIL, "wrong-password-123");
    expect((await client.signIn()).status).toBe(303);
    expect((await client.signIn("other@example.com", "wrong-password-123")).status).toBe(401);
    // The client now holds 5 live failures; the account only 1.
    expect((await client.signIn("third@example.com", "wrong-password-123")).status).toBe(429);
  });

  test("failures spread over more than 15 minutes do not lock", async () => {
    const c = await startConsole();
    const client = new Client(c);
    const t0 = c.clock.now;
    expect((await client.signIn(EMAIL, "wrong-password-123")).status).toBe(401);
    c.clock.now = t0 + 1000;
    for (let i = 0; i < 3; i += 1) await client.signIn(EMAIL, "wrong-password-123");
    c.clock.now = t0 + 900_000;
    expect((await client.signIn(EMAIL, "wrong-password-123")).status).toBe(401);
    expect((await client.signIn()).status).toBe(303);
  });
});

describe("sessions", () => {
  test("sign-in sets a session cookie, rotates the old one and prunes expired rows", async () => {
    const c = await startConsole();
    c.store.createSession("expired-session-id", 1, "csrf-x", START - 2_592_000_000);
    const client = new Client(c);
    const password = await client.signIn();
    expect(password.headers.get("location")).toBe("/sign-in/factor");
    const partial = password.headers.getSetCookie().find((l) => l.startsWith(`${SESSION}=`)) ?? "";
    expect(partial).toMatch(
      /^pulse_console_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=900$/,
    );
    const first = await client.signInFull();
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/");
    const cookie = first.headers.getSetCookie().find((l) => l.startsWith(`${SESSION}=`)) ?? "";
    expect(cookie).toMatch(
      /^pulse_console_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/,
    );
    const firstId = client.jar.get(SESSION) ?? "";
    const firstDigest = createHash("sha256").update(firstId).digest("hex");
    expect(sessionRows(c.dbPath)).toEqual([firstDigest]);
    const second = await client.signInFull();
    expect(second.status).toBe(303);
    const secondId = client.jar.get(SESSION) ?? "";
    expect(secondId).not.toBe(firstId);
    expect(sessionRows(c.dbPath)).toEqual([createHash("sha256").update(secondId).digest("hex")]);
  });

  test("next is followed only when it is a safe path", async () => {
    const c = await startConsole();
    const cases: [string, string][] = [
      ["/checks?x=1", "/checks?x=1"],
      ["//evil.example", "/"],
      ["/\\evil.example", "/"],
      ["https://evil.example/", "/"],
      ["/a b", "/"],
      [`/${"a".repeat(511)}`, `/${"a".repeat(511)}`],
      [`/${"a".repeat(512)}`, "/"],
    ];
    for (const [next, location] of cases) {
      const res = await new Client(c).signInFull(next);
      expect(res.headers.get("location")).toBe(location);
    }
  });

  test("the landing page shows the owner; fabricated and revoked cookies do not", async () => {
    const c = await startConsole();
    const client = new Client(c);
    await client.signInFull();
    const landing = await client.get("/");
    expect(landing.status).toBe(200);
    expect(landing.body).toContain("Signed in as Owner &lt;Sentinel&gt;");
    expect(landing.body).toContain(EMAIL);
    expect(landing.body).toContain("http://api.example:3000");
    expect(landing.body).toContain('action="/sign-out"');
    expect((await client.get("/sign-in")).headers.get("location")).toBe("/");

    const fake = new Client(c);
    fake.jar.set(SESSION, "A".repeat(43));
    const refused = await fake.get("/");
    expect(refused.status).toBe(303);
    expect(refused.headers.get("location")).toBe("/sign-in?next=%2F");
    const notice = await fake.get("/sign-in?next=%2F");
    expect(notice.body).toContain("Your session has expired.");
    expect(fake.jar.has(SESSION)).toBe(false);

    const id = client.jar.get(SESSION) ?? "";
    c.store.deleteSession(id);
    expect((await client.get("/")).status).toBe(303);
  });

  test("idle expiry at 30 days and cookie refresh after 60 s", async () => {
    const c = await startConsole();
    const client = new Client(c);
    await client.signInFull();
    const t = c.clock.now;
    c.clock.now = t + 59_999;
    const quiet = await client.get("/");
    expect(quiet.status).toBe(200);
    expect(quiet.headers.getSetCookie().some((l) => l.startsWith(SESSION))).toBe(false);
    c.clock.now = t + 60_000;
    const id = client.jar.get(SESSION) ?? "";
    const refreshed = await client.get("/");
    expect(refreshed.headers.getSetCookie()).toContain(
      `${SESSION}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
    );
    const last = t + 60_000;
    c.clock.now = last + 2_591_999_999;
    expect((await client.get("/")).status).toBe(200);

    const idle = new Client(c);
    await idle.signInFull();
    const s = c.clock.now;
    c.clock.now = s + 2_592_000_000;
    const expired = await idle.get("/");
    expect(expired.status).toBe(303);
  });

  test("an active session lives past 30 days after sign-in", async () => {
    const c = await startConsole();
    const client = new Client(c);
    await client.signInFull();
    const id = client.jar.get(SESSION) ?? "";
    const t = c.clock.now;
    c.clock.now = t + 2_505_600_000;
    const day29 = await client.get("/");
    expect(day29.status).toBe(200);
    expect(day29.headers.getSetCookie()).toContain(
      `${SESSION}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
    );
    c.clock.now = t + 2_678_400_000;
    expect((await client.get("/")).status).toBe(200);
  });

  test("sessions survive a new server on the same file", async () => {
    const first = await startConsole();
    const client = new Client(first);
    await client.signInFull();
    const second = await startConsole({ dbPath: first.dbPath, clock: first.clock });
    const again = new Client(second);
    for (const [k, v] of client.jar) again.jar.set(k, v);
    expect((await again.get("/")).status).toBe(200);
  });
});

describe("sign-out", () => {
  test("the session CSRF signs out; the anonymous token fails 403", async () => {
    const c = await startConsole();
    const client = new Client(c);
    await client.signInFull();
    const landing = await client.get("/");
    const csrf = /name="csrf" value="([^"]+)"/.exec(landing.body)?.[1] ?? "";
    expect(csrf).not.toBe(client.jar.get("pulse_console_csrf"));

    const anonymous = await client.post("/sign-out", {});
    expect(anonymous.status).toBe(403);
    expect(sessionRows(c.dbPath)).toHaveLength(1);

    const out = await client.post("/sign-out", { csrf });
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/sign-in");
    expect(out.headers.getSetCookie()).toContain(
      `${SESSION}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
    expect(sessionRows(c.dbPath)).toHaveLength(0);
    expect((await client.get("/")).status).toBe(303);
  });

  test("sign-out without a session changes nothing", async () => {
    const c = await startConsole();
    const owner = new Client(c);
    await owner.signInFull();
    const other = new Client(c);
    await other.get("/sign-in");
    const res = await other.post("/sign-out", {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sign-in");
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(sessionRows(c.dbPath)).toHaveLength(1);
  });
});
