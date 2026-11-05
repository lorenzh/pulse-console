// A real console server on 127.0.0.1 port 0 with a temp database, a completed setup and a
// signed-in owner session, for the protected-route tests.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@lorenzh/pulse-kit";
import type { User } from "../src/account-store.ts";
import { type AccountStore, createAccountStore } from "../src/account-store.ts";
import { openDatabase } from "../src/database.ts";
import { createFactorStore } from "../src/factor-store.ts";
import { createMetrics, type Metrics } from "../src/metrics.ts";
import { createCredentialVerifier, PASSWORD_HASH_OPTIONS } from "../src/passwords.ts";
import type { ProtectedRoute } from "../src/protected-route.ts";
import type { ConsoleRole } from "../src/roles.ts";
import { createConsoleServer, listen } from "../src/server.ts";
import { createTeamStore } from "../src/team-store.ts";

export const OWNER_EMAIL = "owner@example.com";
export const OWNER_PASSWORD = "signed-in-console-password-42";
export const SESSION_ID = "session-id-for-tests-0123456789abcdefghijk";
export const SESSION_CSRF = "session-csrf-for-tests-0123456789abcdefghij";
export const START = 9_000_000;

export type SignedInConsole = {
  base: string;
  /** The cookie header of the signed-in owner. */
  cookie: string;
  recoveryCodes: string[];
  store: AccountStore;
  logs: string[];
  metrics: Metrics;
  /** Moves the console clock. */
  setNow: (ms: number) => void;
  close: () => Promise<void>;
};

export type SignedInOptions = {
  apiUrl: string;
  adminToken?: string | undefined;
  fetch?: typeof fetch | undefined;
  schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
  testRoutes?: ReadonlyMap<string, ProtectedRoute> | undefined;
  roleOf?: ((user: User) => ConsoleRole) | undefined;
  /** Adds rows (more people, sessions) after setup, before the server starts. */
  prepare?: ((db: Database) => void) | undefined;
};

let ownerHash: string | undefined;

export async function startSignedInConsole(options: SignedInOptions): Promise<SignedInConsole> {
  const dir = mkdtempSync(join(tmpdir(), "console-signed-in-"));
  const db = openDatabase(join(dir, "console.db"), {
    createFile: (path, mode) => closeSync(openSync(path, "wx", mode)),
    chmod: chmodSync,
  });
  const store = createAccountStore(db);
  ownerHash ??= await Bun.password.hash(OWNER_PASSWORD, PASSWORD_HASH_OPTIONS);
  store.completeSetup(
    { email: OWNER_EMAIL, name: "Owner", passwordHash: ownerHash },
    options.apiUrl,
    START,
  );
  const owner = store.userByEmail(OWNER_EMAIL);
  if (owner === undefined) throw new Error("owner missing");
  // Protected-page fixtures start with an enrolled owner, just as production requires.
  db.query(
    "INSERT INTO authenticators (user_id, secret, last_step, confirmed_at) VALUES (?, ?, ?, ?)",
  ).run(owner.id, "fixture-secret", -1, START);
  const recoveryCodes = Array.from({ length: 10 }, (_, i) =>
    (i + 1).toString(16).padStart(32, "0"),
  );
  for (const code of recoveryCodes) {
    db.query("INSERT INTO recovery_codes (user_id, digest) VALUES (?, ?)").run(
      owner.id,
      createHash("sha256").update(code).digest("hex"),
    );
  }
  store.createSession(SESSION_ID, owner.id, SESSION_CSRF, START);
  options.prepare?.(db);
  let now = START;
  const logs: string[] = [];
  const metrics = createMetrics();
  const server: Server = createConsoleServer({
    instanceName: "pulse Console",
    metrics,
    log: createLogger({ level: "debug", write: (_level, line) => logs.push(line) }),
    mode: "loopback",
    publicOrigin: undefined,
    defaultApiUrl: options.apiUrl,
    adminToken: options.adminToken,
    store,
    factorStore: createFactorStore(db),
    teamStore: createTeamStore(db),
    secretKey: new Uint8Array(32).fill(7),
    gate: undefined,
    now: () => now,
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
    hashPassword: (pw) => Bun.password.hash(pw, PASSWORD_HASH_OPTIONS),
    verifier: await createCredentialVerifier({
      hash: (pw) => Bun.password.hash(pw, PASSWORD_HASH_OPTIONS),
      verify: (pw, hash) => Bun.password.verify(pw, hash),
      dummySecret: "dummy secret for tests",
    }),
    fetch: options.fetch ?? fetch,
    schedule: options.schedule,
    testRoutes: options.testRoutes,
    roleOf: options.roleOf,
  });
  const port = await listen(server, "127.0.0.1", 0);
  return {
    base: `http://127.0.0.1:${port}`,
    cookie: `pulse_console_session=${SESSION_ID}`,
    recoveryCodes,
    store,
    logs,
    metrics,
    setNow: (ms) => {
      now = ms;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

export type Reply = { status: number; headers: Headers; body: string };

export async function replyOf(res: Response): Promise<Reply> {
  return { status: res.status, headers: res.headers, body: await res.text() };
}

export function getPage(c: SignedInConsole, path: string, cookie = c.cookie): Promise<Reply> {
  return fetch(c.base + path, { redirect: "manual", headers: { cookie } }).then(replyOf);
}

export function postForm(
  c: SignedInConsole,
  path: string,
  fields: Record<string, string>,
  options: { cookie?: string; origin?: string } = {},
): Promise<Reply> {
  return fetch(c.base + path, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: options.cookie ?? c.cookie,
      origin: options.origin ?? c.base,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
  }).then(replyOf);
}

/** The value of the first form's `form_token` field after `action="<path>"`. */
export function formTokenOf(html: string, action: string): string {
  const start = html.indexOf(`action="${action}"`);
  const match = /name="form_token" value="([^"]*)"/.exec(html.slice(Math.max(start, 0)));
  return match?.[1] ?? "";
}

/** Completes the fixture owner's required second factor after a password POST. */
export async function completeSignIn(c: SignedInConsole, passwordReply: Reply): Promise<Reply> {
  const cookie = (passwordReply.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const page = await getPage(c, "/sign-in/factor", cookie);
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? "";
  return postForm(
    c,
    "/sign-in/factor",
    {
      csrf,
      form_token: formTokenOf(page.body, "/sign-in/factor"),
      recovery_code: c.recoveryCodes.shift() ?? "",
    },
    { cookie },
  );
}
