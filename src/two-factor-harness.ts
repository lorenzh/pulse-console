/* eslint-disable sonarjs/no-clear-text-protocols -- loopback test servers */
// The HTTP harness of the two-factor server tests: a console on port 0 with an injected clock,
// a cookie jar client and RFC 6238 helpers that do not use the code under test.
import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { createHmac } from "node:crypto";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
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
import { createTeamStore } from "./team-store.ts";

export const PASSWORD = "factor-password-sentinel-42";
export const EMAIL = "owner-factor@example.com";
export const KEY_HEX = "0123456789abcdef".repeat(4);
export const KEY = Uint8Array.from(Buffer.from(KEY_HEX, "hex"));
export const OTHER_KEY = Uint8Array.from(Buffer.from("fedcba9876543210".repeat(4), "hex"));
// A step boundary: 30000 * 56666667.
export const START = 1_700_000_010_000;
export const STEP_MS = 30_000;
export const SESSION = "pulse_console_session";
export const DECRYPT_TEXT =
  "The authenticator secret cannot be read. Sign in with a recovery code.";

const cleanups: (() => void | Promise<void>)[] = [];

/** Closes every server and removes every directory of the harness; call it in afterEach. */
export async function closeAll(): Promise<void> {
  for (const fn of cleanups.splice(0).reverse()) await fn();
}

/** RFC 4648 base32 decoding, written here so it does not depend on the code under test. */
export function base32Decode(text: string): Buffer {
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
export function totpCode(seed: Uint8Array, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", seed).update(counter).digest();
  const offset = (mac[19] ?? 0) & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export function stepAt(ms: number): number {
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

export type Console = {
  base: string;
  dbPath: string;
  clock: { now: number };
  logs: string[];
  metrics: Metrics;
};

export async function startConsole(
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
    instanceName: "pulse Console",
    metrics,
    log: createLogger({ level: "debug", write: (_level, line) => logs.push(line) }),
    mode: "loopback",
    publicOrigin: undefined,
    defaultApiUrl: "http://api.invalid:3000",
    adminToken: undefined,
    store,
    factorStore: createFactorStore(db),
    teamStore: createTeamStore(db),
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

export type Reply = { status: number; headers: Headers; body: string };

export function csrfIn(body: string): string {
  return /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? "";
}

export class Client {
  private readonly formTokens = new Map<string, string>();
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
    const body = await res.text();
    for (const form of body.matchAll(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
      const token = /name="form_token" value="([^"]+)"/.exec(form[2] ?? "")?.[1];
      if (token !== undefined) this.formTokens.set(form[1] ?? "", token);
    }
    return { status: res.status, headers: res.headers, body };
  }

  get(path: string): Promise<Reply> {
    return this.request("GET", path);
  }

  async post(path: string, fields: Record<string, string>): Promise<Reply> {
    if (!this.formTokens.has(path))
      await this.get(path === "/sign-out" ? "/account/sessions" : path);
    const token = this.formTokens.get(path);
    this.formTokens.delete(path);
    return this.request("POST", path, {
      ...(token === undefined ? {} : { form_token: token }),
      ...fields,
    });
  }

  async password(next = "/"): Promise<Reply> {
    const page = await this.get("/sign-in");
    return this.post("/sign-in", {
      csrf: csrfIn(page.body),
      form_token: /name="form_token" value="([^"]+)"/.exec(page.body)?.[1] ?? "",
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

export type Enrolled = { seed: Buffer; key: string; codes: string[]; confirmed: Reply };

/** Enrols from an `enrol` session: a new setup key, then the code of the injected time. */
export async function enrol(client: Client): Promise<Enrolled> {
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
export async function enrolledConsole(
  opts: { key?: Uint8Array } = {},
): Promise<{ c: Console } & Enrolled> {
  const c = await startConsole(opts);
  const owner = new Client(c);
  expect((await owner.password()).headers.get("location")).toBe("/account/authenticator");
  const enrolled = await enrol(owner);
  c.clock.now += STEP_MS;
  return { c, ...enrolled };
}

export function count(dbPath: string, sql: string): number {
  const db = new Database(dbPath, { readonly: true });
  const row = db.query<{ n: number }, []>(sql).get();
  db.close();
  return row?.n ?? -1;
}

export function storedSecret(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  const row = db.query<{ secret: string }, []>("SELECT secret FROM authenticators").get();
  db.close();
  return row?.secret ?? "";
}
