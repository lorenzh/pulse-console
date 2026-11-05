/* eslint-disable sonarjs/no-clear-text-protocols -- the URL is a stored value; no request is made */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AccountStore, createAccountStore } from "./account-store.ts";
import { type DatabaseFiles, openDatabase } from "./database.ts";
import { createFactorStore, type FactorStore } from "./factor-store.ts";

const files: DatabaseFiles = {
  createFile: (path, mode) => closeSync(openSync(path, "wx", mode)),
  chmod: (path, mode) => chmodSync(path, mode),
};
const dirs: string[] = [];
const dbs: Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  db: Database;
  path: string;
  accounts: AccountStore;
  factors: FactorStore;
  userId: number;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "console-factor-"));
  dirs.push(dir);
  const path = join(dir, "console.db");
  const db = openDatabase(path, files);
  dbs.push(db);
  const accounts = createAccountStore(db);
  const result = accounts.completeSetup(
    { email: "owner@example.com", name: "Owner", passwordHash: "h" },
    "http://api:3000",
    0,
  );
  if (!result.ok) throw new Error("setup failed");
  return { db, path, accounts, factors: createFactorStore(db), userId: result.userId };
}

function reopen(path: string): { accounts: AccountStore; factors: FactorStore } {
  const db = openDatabase(path, files);
  dbs.push(db);
  return { accounts: createAccountStore(db), factors: createFactorStore(db) };
}

function count(db: Database, sql: string): number {
  return db.query<{ n: number }, []>(sql).get()?.n ?? -1;
}

const CODES = Array.from({ length: 10 }, (_, i) => i.toString(16).repeat(32));
// SHA-256 hex of each normalised code, computed here with node:crypto, not by the code under test.
const DIGESTS = CODES.map((c) => createHash("sha256").update(c).digest("hex"));
const candidate = (code: string): Buffer => createHash("sha256").update(code).digest();

function enrolled(f: Fixture): void {
  f.accounts.createSession("enrol", f.userId, "ce", 0, { stage: "enrol" });
  f.factors.savePendingAuthenticator("enrol", f.userId, "v1:seed-1", 0);
  const result = f.factors.confirmAuthenticator({
    sessionId: "enrol",
    userId: f.userId,
    secret: "v1:seed-1",
    step: 10,
    recoveryDigests: DIGESTS,
    newSession: { id: "full-1", csrfToken: "cf" },
    now: 1000,
  });
  expect(result).toEqual({ ok: true });
}

describe("pending authenticators", () => {
  test("live for 900000 ms, replaced per session, deleted with the session", () => {
    const f = fixture();
    f.accounts.createSession("s", f.userId, "c", 0, { stage: "enrol" });
    f.factors.savePendingAuthenticator("s", f.userId, "v1:a", 0);
    f.factors.savePendingAuthenticator("s", f.userId, "v1:b", 100);
    expect(f.factors.pendingAuthenticator("s", 900_099)).toEqual({
      secret: "v1:b",
      createdAt: 100,
    });
    expect(f.factors.pendingAuthenticator("s", 900_100)).toBeUndefined();
    expect(f.factors.pendingAuthenticator("other", 0)).toBeUndefined();
    f.accounts.deleteSession("s");
    expect(count(f.db, "SELECT count(*) AS n FROM pending_authenticators")).toBe(0);
  });

  test("expiry at session creation removes pending rows 900000 ms after creation", () => {
    const f = fixture();
    f.accounts.createSession("s", f.userId, "c", 0);
    f.factors.savePendingAuthenticator("s", f.userId, "v1:a", 0);
    f.accounts.deleteExpiredSessions(899_999, 2_592_000_000);
    expect(count(f.db, "SELECT count(*) AS n FROM pending_authenticators")).toBe(1);
    f.accounts.deleteExpiredSessions(900_000, 2_592_000_000);
    expect(count(f.db, "SELECT count(*) AS n FROM pending_authenticators")).toBe(0);
    expect(f.accounts.session("s")?.stage).toBe("full");
  });
});

describe("confirmAuthenticator", () => {
  test("stores the factor and codes, ends every session and starts a full one", () => {
    const f = fixture();
    f.accounts.createSession("other", f.userId, "co", 0);
    enrolled(f);
    expect(f.factors.authenticator(f.userId)).toEqual({
      secret: "v1:seed-1",
      lastStep: 10,
      confirmedAt: 1000,
    });
    expect(f.factors.unusedRecoveryCodeCount(f.userId)).toBe(10);
    expect(f.accounts.session("enrol")).toBeUndefined();
    expect(f.accounts.session("other")).toBeUndefined();
    expect(f.accounts.session("full-1")).toMatchObject({ stage: "full", csrfToken: "cf" });
    expect(count(f.db, "SELECT count(*) AS n FROM pending_authenticators")).toBe(0);
  });

  test("replacement discards the old factor, codes and other sessions", () => {
    const f = fixture();
    enrolled(f);
    f.accounts.createSession("other", f.userId, "co", 2000);
    f.factors.savePendingAuthenticator("full-1", f.userId, "v1:seed-2", 2000);
    const newDigests = CODES.map((c) =>
      createHash("sha256").update(c.replace(/^./, "f")).digest("hex"),
    );
    const result = f.factors.confirmAuthenticator({
      sessionId: "full-1",
      userId: f.userId,
      secret: "v1:seed-2",
      step: 3,
      recoveryDigests: newDigests,
      newSession: { id: "full-2", csrfToken: "c2" },
      now: 2000 + 899_999,
    });
    expect(result).toEqual({ ok: true });
    expect(f.factors.authenticator(f.userId)).toEqual({
      secret: "v1:seed-2",
      lastStep: 3,
      confirmedAt: 2000 + 899_999,
    });
    const stored = f.db
      .query<{ digest: string }, []>("SELECT digest FROM recovery_codes ORDER BY digest")
      .all()
      .map((r) => r.digest);
    expect(stored).toEqual([...newDigests].sort((a, b) => a.localeCompare(b)));
    expect(f.accounts.session("other")).toBeUndefined();
    expect(f.accounts.session("full-1")).toBeUndefined();
    expect(count(f.db, "SELECT count(*) AS n FROM sessions")).toBe(1);
  });

  test("an expired or changed pending row rolls back and changes nothing", () => {
    const f = fixture();
    enrolled(f);
    f.factors.savePendingAuthenticator("full-1", f.userId, "v1:seed-2", 2000);
    const base = {
      sessionId: "full-1",
      userId: f.userId,
      step: 3,
      recoveryDigests: [],
      newSession: { id: "full-2", csrfToken: "c2" },
    };
    expect(
      f.factors.confirmAuthenticator({ ...base, secret: "v1:seed-2", now: 2000 + 900_000 }),
    ).toEqual({ ok: false, reason: "no-pending" });
    expect(f.factors.confirmAuthenticator({ ...base, secret: "v1:other", now: 2001 })).toEqual({
      ok: false,
      reason: "no-pending",
    });
    expect(f.factors.authenticator(f.userId)?.secret).toBe("v1:seed-1");
    expect(f.factors.unusedRecoveryCodeCount(f.userId)).toBe(10);
    expect(f.accounts.session("full-1")?.stage).toBe("full");
    expect(f.accounts.session("full-2")).toBeUndefined();
  });

  test("a failing insert rolls back the whole commit", () => {
    const f = fixture();
    enrolled(f);
    f.factors.savePendingAuthenticator("full-1", f.userId, "v1:seed-2", 2000);
    expect(() =>
      f.factors.confirmAuthenticator({
        sessionId: "full-1",
        userId: f.userId,
        secret: "v1:seed-2",
        step: 3,
        recoveryDigests: ["not-a-digest"],
        newSession: { id: "full-2", csrfToken: "c2" },
        now: 2001,
      }),
    ).toThrow();
    expect(f.factors.authenticator(f.userId)?.secret).toBe("v1:seed-1");
    expect(f.factors.pendingAuthenticator("full-1", 2001)?.secret).toBe("v1:seed-2");
    expect(f.factors.unusedRecoveryCodeCount(f.userId)).toBe(10);
  });
});

describe("completeTotpSignIn", () => {
  test("rotates the factor session, stores the step and refuses a replay", () => {
    const f = fixture();
    enrolled(f);
    f.accounts.createSession("p1", f.userId, "c", 5000, { stage: "factor", nextPath: "/n" });
    f.accounts.createSession("p2", f.userId, "c", 5000, { stage: "factor" });
    const ok = f.factors.completeTotpSignIn({
      sessionId: "p1",
      userId: f.userId,
      step: 11,
      newSession: { id: "f1", csrfToken: "x" },
      now: 6000,
    });
    expect(ok).toEqual({ ok: true, nextPath: "/n", remaining: 10 });
    expect(f.accounts.session("p1")).toBeUndefined();
    expect(f.accounts.session("f1")?.stage).toBe("full");
    expect(f.factors.authenticator(f.userId)?.lastStep).toBe(11);
    for (const step of [11, 10]) {
      expect(
        f.factors.completeTotpSignIn({
          sessionId: "p2",
          userId: f.userId,
          step,
          newSession: { id: "f2", csrfToken: "x" },
          now: 6000,
        }),
      ).toEqual({ ok: false, reason: "factor" });
    }
    expect(f.accounts.session("p2")?.stage).toBe("factor");
    expect(f.accounts.session("f2")).toBeUndefined();
  });

  test("a missing, full or expired session is no-session and changes nothing", () => {
    const f = fixture();
    enrolled(f);
    f.accounts.createSession("p", f.userId, "c", 0, { stage: "factor" });
    for (const [sessionId, now] of [
      ["missing", 1],
      ["full-1", 1],
      ["p", 900_000],
    ] as const) {
      expect(
        f.factors.completeTotpSignIn({
          sessionId,
          userId: f.userId,
          step: 50,
          newSession: { id: "n", csrfToken: "x" },
          now,
        }),
      ).toEqual({ ok: false, reason: "no-session" });
    }
    expect(f.factors.authenticator(f.userId)?.lastStep).toBe(10);
    expect(f.accounts.session("full-1")?.stage).toBe("full");
    expect(f.accounts.session("n")).toBeUndefined();
  });
});

describe("completeRecoverySignIn", () => {
  function recover(stores: { factors: FactorStore }, f: Fixture, sessionId: string, code: string) {
    return stores.factors.completeRecoverySignIn({
      sessionId,
      userId: f.userId,
      candidate: candidate(code),
      newSession: { id: `full-${sessionId}`, csrfToken: "x" },
      now: 5000,
    });
  }

  test("one code consumed twice on one store: one success, one failure", () => {
    const f = fixture();
    enrolled(f);
    f.accounts.createSession("p1", f.userId, "c", 4000, { stage: "factor" });
    f.accounts.createSession("p2", f.userId, "c", 4000, { stage: "factor" });
    expect(recover(f, f, "p1", CODES[3] ?? "")).toEqual({
      ok: true,
      nextPath: undefined,
      remaining: 9,
    });
    expect(recover(f, f, "p2", CODES[3] ?? "")).toEqual({ ok: false, reason: "factor" });
    expect(f.accounts.session("p2")?.stage).toBe("factor");
    expect(count(f.db, "SELECT count(*) AS n FROM recovery_codes WHERE used_at = 5000")).toBe(1);
  });

  test("one code consumed on two stores over one file: one success, one failure", () => {
    const f = fixture();
    enrolled(f);
    const second = reopen(f.path);
    f.accounts.createSession("p1", f.userId, "c", 4000, { stage: "factor" });
    f.accounts.createSession("p2", f.userId, "c", 4000, { stage: "factor" });
    expect(recover(f, f, "p1", CODES[0] ?? "").ok).toBe(true);
    expect(recover(second, f, "p2", CODES[0] ?? "")).toEqual({ ok: false, reason: "factor" });
    expect(recover(second, f, "p2", CODES[1] ?? "")).toMatchObject({ ok: true, remaining: 8 });
  });

  test("an unknown code changes no row; a missing session is no-session", () => {
    const f = fixture();
    enrolled(f);
    f.accounts.createSession("p", f.userId, "c", 4000, { stage: "factor" });
    expect(recover(f, f, "p", `${"a".repeat(31)}b`)).toEqual({ ok: false, reason: "factor" });
    expect(recover(f, f, "gone", CODES[0] ?? "")).toEqual({ ok: false, reason: "no-session" });
    expect(f.factors.unusedRecoveryCodeCount(f.userId)).toBe(10);
    expect(f.accounts.session("p")?.stage).toBe("factor");
  });

  test("replaceRecoveryCodes makes the old codes fail", () => {
    const f = fixture();
    enrolled(f);
    f.factors.replaceRecoveryCodes(f.userId, [DIGESTS[9] ?? ""]);
    f.accounts.createSession("p", f.userId, "c", 4000, { stage: "factor" });
    expect(recover(f, f, "p", CODES[0] ?? "").ok).toBe(false);
    expect(recover(f, f, "p", CODES[9] ?? "")).toMatchObject({ ok: true, remaining: 0 });
  });
});
