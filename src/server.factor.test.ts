/* eslint-disable sonarjs/no-clear-text-protocols -- loopback test servers */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@lorenzh/pulse-kit";
import { createAccountStore } from "./account-store.ts";
import { openDatabase } from "./database.ts";
import { createFactorStore } from "./factor-store.ts";
import { createMetrics, type Metrics } from "./metrics.ts";
import { createCredentialVerifier, PASSWORD_HASH_OPTIONS } from "./passwords.ts";
import { createConsoleServer, listen } from "./server.ts";
import { isSecondFactorRequired, signInStage } from "./two-factor-policy.ts";

const PASSWORD = "factor-password-sentinel-42";
const EMAIL = "owner-factor@example.com";
const KEY_HEX = "0123456789abcdef".repeat(4);
const KEY = Uint8Array.from(Buffer.from(KEY_HEX, "hex"));
const OTHER_KEY = Uint8Array.from(Buffer.from("fedcba9876543210".repeat(4), "hex"));
// A step boundary: 30000 * 56666667.
const START = 1_700_000_010_000;
const STEP_MS = 30_000;
const SESSION = "pulse_console_session";
const DECRYPT_TEXT = "The authenticator secret cannot be read. Sign in with a recovery code.";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** RFC 4648 base32 decoding, written here so it does not depend on the code under test. */
function base32Decode(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of text.replaceAll(" ", ""))
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 SHA-1, 6 digits, over node:crypto. */
function totpCode(seed: Uint8Array, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", seed).update(counter).digest();
  const offset = (mac[19] ?? 0) & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

function stepAt(ms: number): number {
  return Math.floor(ms / STEP_MS);
}

let ownerHash: string | undefined;
async function hashOnce(): Promise<string> {
  ownerHash ??= await Bun.password.hash(PASSWORD, PASSWORD_HASH_OPTIONS);
  return ownerHash;
}

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "console-factor-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "console.db");
}

type Console = {
  base: string;
  dbPath: string;
  clock: { now: number };
  logs: string[];
  metrics: Metrics;
};

async function startConsole(
  opts: { dbPath?: string; clock?: { now: number }; key?: Uint8Array | null } = {},
): Promise<Console> {
  const dbPath = opts.dbPath ?? tempDb();
  const db = openDatabase(dbPath, {
    createFile: (path, mode) => closeSync(openSync(path, "wx", mode)),
    chmod: chmodSync,
  });
  const store = createAccountStore(db);
  if (store.instance() === undefined) {
    store.completeSetup(
      { email: EMAIL, name: "Owner", passwordHash: await hashOnce() },
      "http://api.example:3000",
      START,
    );
  }
  const clock = opts.clock ?? { now: START };
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
    secretKey: opts.key === null ? undefined : (opts.key ?? KEY),
    gate: undefined,
    now: () => clock.now,
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
    hashPassword: (pw) => Bun.password.hash(pw, PASSWORD_HASH_OPTIONS),
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
  return { base: `http://127.0.0.1:${port}`, dbPath, clock, logs, metrics };
}

type Reply = { status: number; headers: Headers; body: string };

function csrfIn(body: string): string {
  return /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? "";
}

class Client {
  readonly jar = new Map<string, string>();
  c: Console;
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

  async request(method: string, path: string, fields?: Record<string, string>): Promise<Reply> {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers: Record<string, string> = { cookie };
    if (fields !== undefined) {
      headers.origin = this.c.base;
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    const res = await fetch(this.c.base + path, {
      method,
      redirect: "manual",
      headers,
      ...(fields === undefined ? {} : { body: new URLSearchParams(fields).toString() }),
    });
    this.remember(res);
    return { status: res.status, headers: res.headers, body: await res.text() };
  }

  get(path: string): Promise<Reply> {
    return this.request("GET", path);
  }

  post(path: string, fields: Record<string, string>): Promise<Reply> {
    return this.request("POST", path, fields);
  }

  async password(next = "/"): Promise<Reply> {
    const page = await this.get("/sign-in");
    return this.post("/sign-in", {
      csrf: csrfIn(page.body),
      email: EMAIL,
      password: PASSWORD,
      next,
    });
  }

  /** Posts one second factor with the CSRF token of the factor page. */
  async factor(fields: { code?: string; recovery_code?: string }): Promise<Reply> {
    const page = await this.get("/sign-in/factor");
    return this.post("/sign-in/factor", { csrf: csrfIn(page.body), ...fields });
  }
}

type Enrolled = { seed: Buffer; key: string; codes: string[]; confirmed: Reply };

/** Enrols from an `enrol` session: a new setup key, then the code of the injected time. */
async function enrol(client: Client): Promise<Enrolled> {
  const start = await client.get("/account/authenticator");
  expect(start.status).toBe(200);
  const created = await client.post("/account/authenticator", {
    csrf: csrfIn(start.body),
    action: "new",
  });
  expect(created.status).toBe(303);
  const page = await client.get("/account/authenticator");
  const key = /id="totp-secret">([A-Z2-7 ]+)</.exec(page.body)?.[1] ?? "";
  const seed = base32Decode(key);
  const confirmed = await client.post("/account/authenticator", {
    csrf: csrfIn(page.body),
    action: "confirm",
    code: totpCode(seed, stepAt(client.c.clock.now)),
  });
  expect(confirmed.status).toBe(200);
  const codes = [...confirmed.body.matchAll(/<li><code>([^<]+)<\/code><\/li>/g)].map(
    (m) => m[1] ?? "",
  );
  return { seed, key, codes, confirmed };
}

/** A console with an enrolled owner; the clock moves one step past the enrolment. */
async function enrolledConsole(
  opts: { key?: Uint8Array } = {},
): Promise<{ c: Console } & Enrolled> {
  const c = await startConsole(opts);
  const owner = new Client(c);
  expect((await owner.password()).headers.get("location")).toBe("/account/authenticator");
  const enrolled = await enrol(owner);
  c.clock.now += STEP_MS;
  return { c, ...enrolled };
}

function count(dbPath: string, sql: string): number {
  const db = new Database(dbPath, { readonly: true });
  const row = db.query<{ n: number }, []>(sql).get();
  db.close();
  return row?.n ?? -1;
}

function storedSecret(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  const row = db.query<{ secret: string }, []>("SELECT secret FROM authenticators").get();
  db.close();
  return row?.secret ?? "";
}

describe("policy", () => {
  test("the owner must have a second factor; signInStage covers every branch", () => {
    expect(isSecondFactorRequired({ role: "owner" })).toBe(true);
    expect(signInStage({ isRequired: false, hasAuthenticator: false })).toBe("full");
    expect(signInStage({ isRequired: true, hasAuthenticator: false })).toBe("enrol");
    expect(signInStage({ isRequired: true, hasAuthenticator: true })).toBe("factor");
    expect(signInStage({ isRequired: false, hasAuthenticator: true })).toBe("factor");
  });
});

describe("access gate", () => {
  test("an enrol session reaches no protected page and changes nothing", async () => {
    const c = await startConsole();
    const owner = new Client(c);
    const password = await owner.password();
    expect(password.status).toBe(303);
    expect(password.headers.get("location")).toBe("/account/authenticator");
    const cookie = password.headers.getSetCookie().find((l) => l.startsWith(`${SESSION}=`)) ?? "";
    expect(cookie).toEndWith("Max-Age=900");
    for (const [method, path] of [
      ["GET", "/"],
      ["HEAD", "/"],
      ["GET", "/account/security"],
      ["GET", "/account/sessions"],
      ["GET", "/account/recovery-codes"],
      ["GET", "/sign-in/factor"],
    ] as const) {
      const res = await owner.request(method, path);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/account/authenticator");
    }
    const sessions = count(c.dbPath, "SELECT count(*) AS n FROM sessions");
    for (const path of ["/account/sessions/sign-out-all", "/account/recovery-codes"]) {
      const res = await owner.post(path, { csrf: "x", password: PASSWORD });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/account/authenticator");
    }
    expect(count(c.dbPath, "SELECT count(*) AS n FROM sessions")).toBe(sessions);
    expect(count(c.dbPath, "SELECT count(*) AS n FROM recovery_codes")).toBe(0);

    await enrol(owner);
    const landing = await owner.get("/");
    expect(landing.status).toBe(200);
    expect(landing.body).toContain("Signed in as");
  });

  test("anonymous, factor and full sessions are sent to their step", async () => {
    const { c } = await enrolledConsole();
    const anonymous = new Client(c);
    expect((await anonymous.get("/account/authenticator")).headers.get("location")).toBe(
      "/sign-in?next=%2Faccount%2Fauthenticator",
    );
    expect((await anonymous.get("/")).headers.get("location")).toBe("/sign-in?next=%2F");
    expect((await anonymous.get("/sign-in/factor")).headers.get("location")).toBe("/sign-in");
    const noSession = await anonymous.post("/sign-in/factor", { csrf: "x", code: "123456" });
    expect(noSession.headers.get("location")).toBe("/sign-in");
    anonymous.jar.set(SESSION, "A".repeat(43));
    const forged = await anonymous.post("/sign-in/factor", { csrf: "x", code: "123456" });
    expect(forged.status).toBe(303);
    expect(forged.headers.get("location")).toBe("/sign-in");

    const partial = new Client(c);
    expect((await partial.password()).headers.get("location")).toBe("/sign-in/factor");
    for (const path of ["/", "/account/authenticator", "/account/security"]) {
      expect((await partial.get(path)).headers.get("location")).toBe("/sign-in/factor");
    }
    const page = await partial.get("/sign-in/factor");
    expect(page.status).toBe(200);
    expect(page.body).toContain('autocomplete="one-time-code"');
    expect(page.body).toContain('inputmode="numeric"');
    expect(page.body).toContain('name="recovery_code"');
    expect(page.body).toContain('action="/sign-out"');
  });

  test("a partial session expires 900000 ms after creation and is never extended", async () => {
    const { c } = await enrolledConsole();
    const client = new Client(c);
    await client.password();
    const t = c.clock.now;
    c.clock.now = t + 899_999;
    expect((await client.get("/sign-in/factor")).status).toBe(200);
    c.clock.now = t + 900_000;
    expect((await client.get("/sign-in/factor")).headers.get("location")).toBe("/sign-in");
  });
});

describe("enrolment", () => {
  test("the setup key page shows the key, the parameters and the URI, and no seed is stored plain", async () => {
    const c = await startConsole();
    const owner = new Client(c);
    await owner.password();
    const start = await owner.get("/account/authenticator");
    expect(start.body).toContain("Create a setup key");
    await owner.post("/account/authenticator", { csrf: csrfIn(start.body), action: "new" });
    const page = await owner.get("/account/authenticator");
    const key = /id="totp-secret">([A-Z2-7 ]+)</.exec(page.body)?.[1] ?? "";
    expect(key).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{4}){7}$/);
    const plain = key.replaceAll(" ", "");
    expect(page.body).toContain("SHA-1, 6 digits, 30 seconds");
    expect(page.body).toContain(
      `otpauth://totp/pulse%20Console:owner-factor%40example.com?secret=${plain}&amp;issuer=pulse%20Console&amp;algorithm=SHA1&amp;digits=6&amp;period=30`,
    );
    const wrong = await owner.post("/account/authenticator", {
      csrf: csrfIn(page.body),
      action: "confirm",
      code: totpCode(base32Decode(key), stepAt(c.clock.now) + 3),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toContain("Wrong code.");
    expect(
      (
        await owner.post("/account/authenticator", {
          csrf: csrfIn(page.body),
          action: "confirm",
          code: "12345",
        })
      ).status,
    ).toBe(422);
    expect(
      (await owner.post("/account/authenticator", { csrf: csrfIn(page.body), action: "other" }))
        .status,
    ).toBe(422);
  });

  test("confirmation shows 10 codes, rotates the session and records the authenticator", async () => {
    const c = await startConsole();
    const owner = new Client(c);
    await owner.password("/account/security");
    const enrolCookie = owner.jar.get(SESSION) ?? "";
    const { codes, confirmed } = await enrol(owner);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/);
    expect(confirmed.body).toContain('<a href="/account/security">Continue</a>');
    const full = confirmed.headers.getSetCookie().find((l) => l.startsWith(`${SESSION}=`)) ?? "";
    expect(full).toEndWith("Max-Age=2592000");
    expect(owner.jar.get(SESSION)).not.toBe(enrolCookie);
    expect(count(c.dbPath, "SELECT count(*) AS n FROM sessions")).toBe(1);
    expect(count(c.dbPath, "SELECT count(*) AS n FROM pending_authenticators")).toBe(0);
    expect(c.logs.some((l) => l.includes('"authenticator confirmed"'))).toBe(true);
  });

  test("an expired setup key answers 409 and the reservation is released", async () => {
    const c = await startConsole();
    const owner = new Client(c);
    await owner.password();
    const start = await owner.get("/account/authenticator");
    await owner.post("/account/authenticator", { csrf: csrfIn(start.body), action: "new" });
    const page = await owner.get("/account/authenticator");
    const seed = base32Decode(/id="totp-secret">([A-Z2-7 ]+)</.exec(page.body)?.[1] ?? "");
    // The pending row lives 900000 ms, as the session; a second session of this browser is new.
    c.clock.now += 899_999;
    const db = new Database(c.dbPath);
    db.query("UPDATE pending_authenticators SET created_at = created_at - 1").run();
    db.close();
    const expired = await owner.post("/account/authenticator", {
      csrf: csrfIn(page.body),
      action: "confirm",
      code: totpCode(seed, stepAt(c.clock.now)),
    });
    expect(expired.status).toBe(409);
    expect(expired.body).toContain("The setup key expired. Create a new one.");
    expect(expired.body).toContain('name="action" value="new"');
  });

  test("without the key enrolment answers 503 and nothing opens", async () => {
    const c = await startConsole({ key: null });
    const owner = new Client(c);
    await owner.password();
    const page = await owner.get("/account/authenticator");
    expect(page.status).toBe(503);
    expect(page.body).toContain(
      "Two-factor setup needs PULSE_CONSOLE_SECRET_KEY_FILE. Ask the operator to set it.",
    );
    const sign = await owner.get("/sign-in");
    const created = await owner.post("/account/authenticator", {
      csrf: csrfIn(sign.body),
      action: "new",
    });
    expect(created.status).toBe(403);
    expect((await owner.get("/")).headers.get("location")).toBe("/account/authenticator");
  });

  test("a full session replaces the authenticator only with the password", async () => {
    const { c, seed } = await enrolledConsole();
    const owner = new Client(c);
    await owner.password();
    await owner.factor({ code: totpCode(seed, stepAt(c.clock.now)) });
    const page = await owner.get("/account/authenticator");
    expect(page.status).toBe(200);
    expect(page.body).toContain("Replace authenticator");
    expect(page.body).toContain("ends every other session");
    const csrf = csrfIn(page.body);
    expect((await owner.post("/account/authenticator", { csrf, action: "new" })).status).toBe(422);
    const wrong = await owner.post("/account/authenticator", {
      csrf,
      action: "new",
      password: "wrong-password-123",
    });
    expect(wrong.status).toBe(401);
    const ok = await owner.post("/account/authenticator", {
      csrf,
      action: "new",
      password: PASSWORD,
    });
    expect(ok.status).toBe(303);
    const before = storedSecret(c.dbPath);
    const pending = await owner.get("/account/authenticator");
    expect(pending.body).toContain('id="totp-secret"');
    // The confirmed authenticator is not replaced before confirmation.
    expect(storedSecret(c.dbPath)).toBe(before);
    const other = new Client(c);
    await other.password();
    const replaced = await enrolFrom(owner, pending.body);
    expect(replaced.status).toBe(200);
    expect(storedSecret(c.dbPath)).not.toBe(before);
    // Every other session ended, this browser goes on.
    expect((await other.get("/sign-in/factor")).headers.get("location")).toBe("/sign-in");
    expect((await owner.get("/")).status).toBe(200);
  });
});

async function enrolFrom(client: Client, pageBody: string): Promise<Reply> {
  const seed = base32Decode(/id="totp-secret">([A-Z2-7 ]+)</.exec(pageBody)?.[1] ?? "");
  return client.post("/account/authenticator", {
    csrf: csrfIn(pageBody),
    action: "confirm",
    code: totpCode(seed, stepAt(client.c.clock.now)),
  });
}

describe("TOTP sign-in", () => {
  test("a correct code rotates the cookie to the next path; the factor cookie stops working", async () => {
    const { c, seed } = await enrolledConsole();
    const client = new Client(c);
    const password = await client.password("/account/security");
    expect(password.headers.get("location")).toBe("/sign-in/factor");
    expect((await client.get("/")).headers.get("location")).toBe("/sign-in/factor");
    const factorCookie = client.jar.get(SESSION) ?? "";
    const ok = await client.factor({ code: totpCode(seed, stepAt(c.clock.now)) });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/account/security");
    expect(client.jar.get(SESSION)).not.toBe(factorCookie);
    const stale = new Client(c);
    stale.jar.set(SESSION, factorCookie);
    expect((await stale.get("/sign-in/factor")).headers.get("location")).toBe("/sign-in");
    expect((await client.get("/")).status).toBe(200);
    expect(c.logs.some((l) => l.includes('"signed in"') && l.includes('"factor":"totp"'))).toBe(
      true,
    );
  });

  test("the same code from a second factor session in the same step is 401", async () => {
    const { c, seed } = await enrolledConsole();
    const code = totpCode(seed, stepAt(c.clock.now));
    const first = new Client(c);
    await first.password();
    expect((await first.factor({ code })).status).toBe(303);
    const second = new Client(c);
    await second.password();
    const replay = await second.factor({ code });
    expect(replay.status).toBe(401);
    expect(replay.body).toContain("Wrong code.");
  });

  test("two sessions posting one fresh code concurrently give one 303 and one 401", async () => {
    const { c, seed } = await enrolledConsole();
    const code = totpCode(seed, stepAt(c.clock.now));
    const a = new Client(c);
    const b = new Client(c);
    await a.password();
    await b.password();
    const [pa, pb] = await Promise.all([a.get("/sign-in/factor"), b.get("/sign-in/factor")]);
    const replies = await Promise.all([
      a.post("/sign-in/factor", { csrf: csrfIn(pa.body), code }),
      b.post("/sign-in/factor", { csrf: csrfIn(pb.body), code }),
    ]);
    expect(replies.map((r) => r.status).sort()).toEqual([303, 401]);
  });

  test("after a reopen the used step is 401 and the next step is 303", async () => {
    const { c, seed } = await enrolledConsole();
    const step = stepAt(c.clock.now);
    const first = new Client(c);
    await first.password();
    expect((await first.factor({ code: totpCode(seed, step) })).status).toBe(303);
    const again = await startConsole({ dbPath: c.dbPath, clock: c.clock });
    const client = new Client(again);
    await client.password();
    expect((await client.factor({ code: totpCode(seed, step) })).status).toBe(401);
    c.clock.now += STEP_MS;
    expect((await client.factor({ code: totpCode(seed, step + 1) })).status).toBe(303);
  });

  test("a clock set back 120 s refuses the earlier step", async () => {
    const { c, seed } = await enrolledConsole();
    const client = new Client(c);
    await client.password();
    expect((await client.factor({ code: totpCode(seed, stepAt(c.clock.now)) })).status).toBe(303);
    c.clock.now -= 120_000;
    const fresh = new Client(c);
    expect((await fresh.password()).headers.get("location")).toBe("/sign-in/factor");
    const res = await fresh.factor({ code: totpCode(seed, stepAt(c.clock.now)) });
    expect(res.status).toBe(401);
  });

  test("the window accepts c - 1 and c + 1 and refuses c - 2 and c + 2", async () => {
    const { c, seed } = await enrolledConsole();
    c.clock.now += 10 * STEP_MS;
    const step = stepAt(c.clock.now);
    const client = new Client(c);
    await client.password();
    expect((await client.factor({ code: totpCode(seed, step - 2) })).status).toBe(401);
    expect((await client.factor({ code: totpCode(seed, step + 2) })).status).toBe(401);
    expect((await client.factor({ code: totpCode(seed, step - 1) })).status).toBe(303);
    const next = new Client(c);
    await next.password();
    expect((await next.factor({ code: totpCode(seed, step + 1) })).status).toBe(303);
  });

  test("invalid input is 422 without counting", async () => {
    const { c, seed } = await enrolledConsole();
    const client = new Client(c);
    await client.password();
    for (const fields of [
      {},
      { code: "12345" },
      { code: "1234567" },
      { code: "12a456" },
      { code: "123456", recovery_code: "0000-0000-0000-0000-0000-0000-0000-0000" },
      { recovery_code: "0000" },
      { code: `${" ".repeat(60)}123456` },
    ]) {
      const res = await client.factor(fields);
      expect(res.status).toBe(422);
    }
    const res = await client.factor({ code: " 123 456 " });
    expect(res.status).not.toBe(422);
    expect(res.status).not.toBe(429);
    const ok = new Client(c);
    await ok.password();
    expect((await ok.factor({ code: totpCode(seed, stepAt(c.clock.now)) })).status).toBe(303);
  });
});

describe("factor throttle", () => {
  test("5 failures lock for 900 s; a password does not reset it; a success after the lock", async () => {
    const { c, seed } = await enrolledConsole();
    const wrong = (step: number): string => totpCode(seed, step + 5);
    const t0 = c.clock.now;
    const s1 = new Client(c);
    expect((await s1.password()).status).toBe(303);
    for (let i = 0; i < 4; i += 1) {
      expect((await s1.factor({ code: wrong(stepAt(t0)) })).status).toBe(401);
    }
    const t1 = t0 + 60_000;
    c.clock.now = t1;
    expect((await s1.password()).headers.get("location")).toBe("/sign-in/factor");
    const t5 = t1 + 1000;
    c.clock.now = t5;
    expect((await s1.factor({ code: wrong(stepAt(t5)) })).status).toBe(401);
    const locked = await s1.factor({ code: totpCode(seed, stepAt(t5)) });
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("900");

    c.clock.now = t5 + 899_999;
    expect((await s1.password()).headers.get("location")).toBe("/sign-in/factor");
    const still = await s1.factor({ code: totpCode(seed, stepAt(c.clock.now)) });
    expect(still.status).toBe(429);
    expect(still.headers.get("retry-after")).toBe("1");

    c.clock.now = t5 + 900_000;
    expect((await s1.password()).headers.get("location")).toBe("/sign-in/factor");
    expect((await s1.factor({ code: totpCode(seed, stepAt(c.clock.now)) })).status).toBe(303);
    const metrics = c.metrics.render();
    expect(metrics).toContain('pulse_console_auth_attempts_total{kind="totp",result="failure"} 5');
    expect(metrics).toContain(
      'pulse_console_auth_attempts_total{kind="totp",result="throttled"} 2',
    );
    expect(
      c.logs.some(
        (l) => l.includes('"second factor failed"') && l.includes('"reason":"throttled"'),
      ),
    ).toBe(true);
  });

  test("recovery codes and TOTP share one budget", async () => {
    const { c, seed, codes } = await enrolledConsole();
    const client = new Client(c);
    await client.password();
    const unused = codes[0] ?? "";
    const wrong = `${unused.slice(0, -1)}${unused.endsWith("0") ? "1" : "0"}`;
    for (let i = 0; i < 5; i += 1) {
      expect((await client.factor({ recovery_code: wrong })).status).toBe(401);
    }
    expect((await client.factor({ code: totpCode(seed, stepAt(c.clock.now)) })).status).toBe(429);
  });

  test("client failures survive a success of the account", async () => {
    const { c, seed } = await enrolledConsole();
    const client = new Client(c);
    await client.password();
    for (let i = 0; i < 4; i += 1) {
      expect((await client.factor({ code: totpCode(seed, stepAt(c.clock.now) + 5) })).status).toBe(
        401,
      );
    }
    expect((await client.factor({ code: totpCode(seed, stepAt(c.clock.now)) })).status).toBe(303);
    c.clock.now += STEP_MS;
    const next = new Client(c);
    await next.password();
    expect((await next.factor({ code: totpCode(seed, stepAt(c.clock.now) + 5) })).status).toBe(401);
    expect((await next.factor({ code: totpCode(seed, stepAt(c.clock.now)) })).status).toBe(429);
  });
});

function filesOf(dbPath: string): Buffer {
  const dir = join(dbPath, "..");
  return Buffer.concat(readdirSync(dir).map((name) => readFileSync(join(dir, name))));
}

describe("encryption at rest", () => {
  test("the stored envelope has the literal format and the files hold no seed or key", async () => {
    const { c, seed, key } = await enrolledConsole();
    expect(storedSecret(c.dbPath)).toMatch(
      /^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{27}:[A-Za-z0-9_-]{22}$/,
    );
    const bytes = filesOf(c.dbPath);
    expect(bytes.includes(Buffer.from(EMAIL))).toBe(true);
    for (const sentinel of [
      Buffer.from(key.replaceAll(" ", "")),
      seed,
      Buffer.from(KEY_HEX),
      Buffer.from(KEY),
    ]) {
      expect(bytes.includes(sentinel)).toBe(false);
    }
  });

  test("the same key signs in after a restart; another key answers 500 and recovery still works", async () => {
    const { c, seed, codes } = await enrolledConsole();
    const same = await startConsole({ dbPath: c.dbPath, clock: c.clock });
    const client = new Client(same);
    await client.password();
    expect((await client.factor({ code: totpCode(seed, stepAt(c.clock.now)) })).status).toBe(303);

    c.clock.now += STEP_MS;
    const before = storedSecret(c.dbPath);
    const other = await startConsole({ dbPath: c.dbPath, clock: c.clock, key: OTHER_KEY });
    const browser = new Client(other);
    await browser.password();
    const broken = await browser.factor({ code: totpCode(seed, stepAt(c.clock.now)) });
    expect(broken.status).toBe(500);
    expect(broken.body).toContain(DECRYPT_TEXT);
    expect(other.logs.some((l) => l.includes('"authenticator secret cannot be decrypted"'))).toBe(
      true,
    );
    expect(storedSecret(c.dbPath)).toBe(before);
    expect((await browser.factor({ recovery_code: codes[0] ?? "" })).status).toBe(303);
    expect(storedSecret(c.dbPath)).toBe(before);
  });

  test("without the key a TOTP code is 503 and nothing opens", async () => {
    const { c, seed } = await enrolledConsole();
    const none = await startConsole({ dbPath: c.dbPath, clock: c.clock, key: null });
    const client = new Client(none);
    await client.password();
    expect((await client.factor({ code: totpCode(seed, stepAt(c.clock.now)) })).status).toBe(503);
    expect((await client.get("/")).headers.get("location")).toBe("/sign-in/factor");
  });
});
