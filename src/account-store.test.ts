/* eslint-disable sonarjs/no-clear-text-protocols -- the URLs are stored values under test; no request is made */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAccountStore,
  isSessionLive,
  sessionDigest,
  sessionExpiresAt,
} from "./account-store.ts";
import { type DatabaseFiles, openDatabase } from "./database.ts";

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

function fresh(): { db: Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "console-store-"));
  dirs.push(dir);
  const path = join(dir, "console.db");
  const db = openDatabase(path, files);
  dbs.push(db);
  return { db, path };
}

function count(db: Database, table: string): number {
  return db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1;
}

const OWNER = { email: "owner@example.com", name: "Owner", passwordHash: "$argon2id$fake" };
const API = "http://api:3000";

describe("setup transaction", () => {
  test("a fresh database has no instance; setup writes exactly 1 owner and 1 instance", () => {
    const { db } = fresh();
    const store = createAccountStore(db);
    expect(store.instance()).toBeUndefined();
    const result = store.completeSetup(OWNER, API, 1000);
    expect(result.ok).toBe(true);
    expect(store.instance()).toEqual({
      apiUrl: API,
      setupCompletedAt: 1000,
      isTwoFactorRequiredForAll: false,
    });
    expect(count(db, "users")).toBe(1);
    expect(count(db, "instance")).toBe(1);
    const user = store.userByEmail("owner@example.com");
    expect(user).toEqual({
      id: 1,
      email: OWNER.email,
      name: "Owner",
      passwordHash: OWNER.passwordHash,
      role: "owner",
    });
    expect(store.userById(1)).toEqual({
      id: 1,
      email: "owner@example.com",
      name: "Owner",
      passwordHash: "$argon2id$fake",
      role: "owner",
    });
    expect(store.userByEmail("other@example.com")).toBeUndefined();
  });

  test("a second completion, also from a second connection, changes nothing", () => {
    const { db, path } = fresh();
    const first = createAccountStore(db);
    const other = openDatabase(path, files);
    dbs.push(other);
    const second = createAccountStore(other);
    expect(first.completeSetup(OWNER, API, 1000).ok).toBe(true);
    expect(
      second.completeSetup({ ...OWNER, email: "late@example.com" }, "http://other:1", 2000),
    ).toEqual({
      ok: false,
      reason: "already-complete",
    });
    expect(count(db, "users")).toBe(1);
    expect(first.instance()).toEqual({
      apiUrl: API,
      setupCompletedAt: 1000,
      isTwoFactorRequiredForAll: false,
    });
  });

  test("a failed transaction writes neither the owner nor the instance", () => {
    const { db } = fresh();
    db.run(
      "CREATE TRIGGER refuse BEFORE INSERT ON instance BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    const store = createAccountStore(db);
    expect(() => store.completeSetup(OWNER, API, 1000)).toThrow();
    expect(count(db, "users")).toBe(0);
    expect(count(db, "instance")).toBe(0);
  });

  test("the schema allows one owner and one instance row only", () => {
    const { db } = fresh();
    createAccountStore(db).completeSetup(OWNER, API, 1);
    expect(() =>
      db.run(
        "INSERT INTO users (email, name, password_hash, role, created_at) VALUES ('b@x.io', 'B', 'h', 'owner', 1)",
      ),
    ).toThrow();
    expect(() =>
      db.run("INSERT INTO instance (id, api_url, setup_completed_at) VALUES (2, 'x', 1)"),
    ).toThrow();
  });
});

describe("sessions", () => {
  const SESSION_ID = "session-id-sentinel-0123456789abcdefghijklmnop";

  function signedUp(): {
    db: Database;
    path: string;
    store: ReturnType<typeof createAccountStore>;
    userId: number;
  } {
    const { db, path } = fresh();
    const store = createAccountStore(db);
    const result = store.completeSetup(OWNER, API, 0);
    if (!result.ok) throw new Error("setup failed");
    return { db, path, store, userId: result.userId };
  }

  test("a session row is keyed by the SHA-256 digest and holds no plain id", () => {
    const { db, path, store, userId } = signedUp();
    store.createSession(SESSION_ID, userId, "csrf-token", 5000);
    expect(store.session(SESSION_ID)).toEqual({
      userId,
      csrfToken: "csrf-token",
      createdAt: 5000,
      lastSeenAt: 5000,
      stage: "full",
      nextPath: undefined,
    });
    const row = db.query<{ id_digest: string }, []>("SELECT id_digest FROM sessions").get();
    // SHA-256 of the id above, computed independently with `printf %s <id> | sha256sum`.
    expect(row?.id_digest).toBe("dfddb488a468be2c51d698d1d2fc1d88bd3babf1d81419597f544a6a08caa854");
    expect(row?.id_digest).toMatch(/^[0-9a-f]{64}$/);
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(readFileSync(path).includes(SESSION_ID)).toBe(false);
    expect(readFileSync(path).includes("csrf-token")).toBe(true);
    expect(store.session("other")).toBeUndefined();
  });

  test("touch, delete and expiry", () => {
    const { store, userId } = signedUp();
    store.createSession("a", userId, "c1", 0);
    store.createSession("b", userId, "c2", 0);
    store.touchSession("a", 100);
    expect(store.session("a")?.lastSeenAt).toBe(100);
    expect(store.session("a")?.createdAt).toBe(0);
    expect(store.deleteExpiredSessions(99, 100)).toBe(0);
    expect(store.deleteExpiredSessions(100, 100)).toBe(1);
    expect(store.session("b")).toBeUndefined();
    store.deleteSession("a");
    expect(store.session("a")).toBeUndefined();
  });

  test("full idle expiry is 2592000000 ms; partial expiry is 900000 ms and never touched", () => {
    const { store, userId } = signedUp();
    store.createSession("full", userId, "c1", 0);
    store.createSession("factor", userId, "c2", 0, {
      stage: "factor",
      nextPath: "/account/security",
    });
    store.createSession("enrol", userId, "c3", 0, { stage: "enrol" });
    const factor = store.session("factor");
    expect(factor).toEqual({
      userId,
      csrfToken: "c2",
      createdAt: 0,
      lastSeenAt: 0,
      stage: "factor",
      nextPath: "/account/security",
    });
    store.touchSession("factor", 600_000);
    expect(store.session("factor")?.lastSeenAt).toBe(0);
    if (factor === undefined) throw new Error("no factor session");
    expect(sessionExpiresAt(factor)).toBe(900_000);
    expect(isSessionLive(factor, 899_999)).toBe(true);
    expect(isSessionLive(factor, 900_000)).toBe(false);
    const full = store.session("full");
    if (full === undefined) throw new Error("no full session");
    expect(sessionExpiresAt(full)).toBe(2_592_000_000);
    expect(store.deleteExpiredSessions(899_999, 2_592_000_000)).toBe(0);
    expect(store.deleteExpiredSessions(900_000, 2_592_000_000)).toBe(2);
    expect(store.session("enrol")).toBeUndefined();
    expect(store.session("full")?.stage).toBe("full");
    expect(store.deleteExpiredSessions(2_592_000_000, 2_592_000_000)).toBe(1);
  });

  test("a full session stores no next path", () => {
    const { store, userId } = signedUp();
    store.createSession("f", userId, "c", 0, { stage: "full", nextPath: "/x" });
    expect(store.session("f")?.nextPath).toBeUndefined();
  });

  test("listSessions: live full rows only, newest last use first, current marked", () => {
    const { store, userId } = signedUp();
    store.createSession("old", userId, "c1", 0);
    store.createSession("a", userId, "c2", 1000);
    store.createSession("b", userId, "c3", 2000);
    store.createSession("p", userId, "c4", 2000, { stage: "factor" });
    store.touchSession("a", 3000);
    expect(store.listSessions(userId, "b", 2_592_000_000)).toEqual([
      { createdAt: 1000, lastSeenAt: 3000, isCurrent: false },
      { createdAt: 2000, lastSeenAt: 2000, isCurrent: true },
    ]);
    expect(store.session("old")).toBeUndefined();
  });

  test("deleteOtherSessions deletes every other row of the user in one statement", () => {
    const { db, store, userId } = signedUp();
    db.run(
      "INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (2, 'second@example.com', 'S', 'h', 'member', 0)",
    );
    store.createSession("kept", userId, "kept-csrf", 10);
    store.createSession("full-2", userId, "c2", 10);
    store.createSession("factor", userId, "c3", 10, { stage: "factor" });
    store.createSession("enrol", userId, "c4", 10, { stage: "enrol" });
    store.createSession("second", 2, "c5", 10);
    const before = store.session("kept");
    expect(store.deleteOtherSessions(userId, "kept")).toBe(3);
    expect(store.session("kept")).toEqual(before);
    expect(store.session("second")?.userId).toBe(2);
    expect(store.session("full-2")).toBeUndefined();
    expect(store.session("factor")).toBeUndefined();
    expect(store.session("enrol")).toBeUndefined();
    expect(store.deleteOtherSessions(userId, "kept")).toBe(0);
  });

  test("a session for an unknown user is refused by the foreign key", () => {
    const { store } = signedUp();
    expect(() => store.createSession("x", 999, "c", 0)).toThrow();
  });
});

test("sessionDigest is the SHA-256 hex digest", () => {
  // printf %s abc | sha256sum
  expect(sessionDigest("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

describe("stored roles and the instance switch", () => {
  test("users carry their stored role; the switch reads live", () => {
    const { db } = fresh();
    const store = createAccountStore(db);
    store.completeSetup(OWNER, API, 1000);
    db.run(
      "INSERT INTO users (email, name, password_hash, role, created_at) VALUES ('v@example.com', 'V', 'h', 'viewer', 1)",
    );
    expect(store.userByEmail("v@example.com")?.role).toBe("viewer");
    expect(store.userByEmail(OWNER.email)?.role).toBe("owner");
    db.run("UPDATE instance SET require_2fa_all = 1");
    expect(store.instance()?.isTwoFactorRequiredForAll).toBe(true);
  });

  test("an unknown stored role throws instead of being cast", () => {
    const { db } = fresh();
    const store = createAccountStore(db);
    store.completeSetup(OWNER, API, 1000);
    db.run("DROP TRIGGER users_role_update");
    db.run("UPDATE users SET role = 'superuser'");
    expect(() => store.userByEmail(OWNER.email)).toThrow("invalid role");
  });
});
