import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionDigest } from "./account-store.ts";
import { openDatabase } from "./database.ts";
import { PeopleLogError } from "./people-log.ts";
import { InvalidRoleError } from "./roles.ts";
import { createTeamStore } from "./team-store.ts";

const dirs: string[] = [];
const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fresh(): Database {
  const dir = mkdtempSync(join(tmpdir(), "console-team-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "console.db"), {
    createFile: (path, mode) => closeSync(openSync(path, "wx", mode)),
    chmod: chmodSync,
  });
  dbs.push(db);
  return db;
}

function addUser(db: Database, email: string, name: string, role: string, at: number): number {
  const row = db
    .query<{ id: number }, [string, string, string, number]>(
      "INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, 'h', ?, ?) RETURNING id",
    )
    .get(email, name, role, at);
  return row?.id ?? 0;
}

test("members: Owner first, then by role; revision and 2FA state", () => {
  const db = fresh();
  const viewer = addUser(db, "v@example.com", "Vi", "viewer", 4);
  const owner = addUser(db, "o@example.com", "Ow", "owner", 1);
  const admin = addUser(db, "a@example.com", "Ad", "admin", 2);
  db.query(
    "INSERT INTO authenticators (user_id, secret, last_step, confirmed_at) VALUES (?, 's', -1, 1)",
  ).run(admin);
  expect(createTeamStore(db).members()).toEqual([
    {
      id: owner,
      email: "o@example.com",
      name: "Ow",
      role: "owner",
      hasAuthenticator: false,
      revision: "1-owner",
    },
    {
      id: admin,
      email: "a@example.com",
      name: "Ad",
      role: "admin",
      hasAuthenticator: true,
      revision: "2-admin",
    },
    {
      id: viewer,
      email: "v@example.com",
      name: "Vi",
      role: "viewer",
      hasAuthenticator: false,
      revision: "4-viewer",
    },
  ]);
});

test("pendingInvites lists only unused, unrevoked invites with the creator name", () => {
  const db = fresh();
  const admin = addUser(db, "a@example.com", "Ad", "admin", 2);
  const insert = db.query(
    "INSERT INTO invites (token_digest, email, role, created_by, created_at, expires_at, used_at, revoked_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
  );
  insert.run("d1", "x@example.com", "member", admin, 100, null, null);
  insert.run("d2", "y@example.com", "viewer", null, 200, null, null);
  insert.run("d3", "z@example.com", "viewer", admin, 300, 5, null);
  insert.run("d4", "w@example.com", "admin", admin, 400, null, 6);
  expect(createTeamStore(db).pendingInvites()).toEqual([
    { id: 1, email: "x@example.com", role: "member", createdByName: "Ad", expiresAt: 100 },
    { id: 2, email: "y@example.com", role: "viewer", createdByName: undefined, expiresAt: 200 },
  ]);
});

test("a stored role outside the four throws a named error instead of becoming a role", () => {
  const db = fresh();
  addUser(db, "a@example.com", "Ad", "admin", 2);
  // The trigger refuses such a value; drop it to simulate a corrupt row.
  db.run("DROP TRIGGER users_role_update");
  db.run("UPDATE users SET role = 'superuser'");
  expect(() => createTeamStore(db).members()).toThrow(InvalidRoleError);
});

type InviteWorld = {
  db: Database;
  owner: number;
  admin: number;
  ownerGuard: { sessionId: string; userId: number };
  adminGuard: { sessionId: string; userId: number };
};

function inviteWorld(): InviteWorld {
  const db = fresh();
  const owner = addUser(db, "o@example.com", "Ow", "owner", 1);
  const admin = addUser(db, "a@example.com", "Ad", "admin", 2);
  const session = db.query(
    "INSERT INTO sessions (id_digest, user_id, csrf_token, created_at, last_seen_at, stage) VALUES (?, ?, 'c', 1, 1, 'full')",
  );
  session.run(sessionDigest("owner-session"), owner);
  session.run(sessionDigest("admin-session"), admin);
  return {
    db,
    owner,
    admin,
    ownerGuard: { sessionId: "owner-session", userId: owner },
    adminGuard: { sessionId: "admin-session", userId: admin },
  };
}

function counts(db: Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of ["users", "invites", "people_events", "sessions"]) {
    out[table] = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1;
  }
  return out;
}

const NEW = {
  email: "new@example.com",
  role: "member",
  tokenDigest: "digest-1",
  now: 1000,
} as const;

describe("invites", () => {
  test("create stores the invite with a 604800000 ms life and one invite.create event", () => {
    const w = inviteWorld();
    const result = createTeamStore(w.db).createInvite(w.adminGuard, NEW);
    expect(result).toEqual({ ok: true, id: 1, expiresAt: 604_801_000 });
    expect(
      w.db
        .query("SELECT token_digest, email, role, created_by, created_at, expires_at FROM invites")
        .all(),
    ).toEqual([
      {
        token_digest: "digest-1",
        email: "new@example.com",
        role: "member",
        created_by: w.admin,
        created_at: 1000,
        expires_at: 604_801_000,
      },
    ]);
    expect(
      w.db
        .query(
          "SELECT action, actor_user_id, target_kind, target_id, target_email, to_role FROM people_events",
        )
        .all(),
    ).toEqual([
      {
        action: "invite.create",
        actor_user_id: w.admin,
        target_kind: "invite",
        target_id: 1,
        target_email: "new@example.com",
        to_role: "member",
      },
    ]);
  });

  test("a deleted actor session is session-gone and changes nothing", () => {
    const w = inviteWorld();
    const store = createTeamStore(w.db);
    expect(store.createInvite(w.adminGuard, NEW).ok).toBe(true);
    w.db.query("DELETE FROM sessions WHERE id_digest = ?").run(sessionDigest("admin-session"));
    const before = counts(w.db);
    expect(
      store.createInvite(w.adminGuard, { ...NEW, email: "x@example.com", tokenDigest: "d2" }),
    ).toEqual({
      ok: false,
      reason: "session-gone",
    });
    expect(store.revokeInvite(w.adminGuard, 1, 2000)).toEqual({
      ok: false,
      reason: "session-gone",
    });
    // A session id of another user does not hold either.
    expect(
      store.createInvite(
        { sessionId: "owner-session", userId: w.admin },
        { ...NEW, tokenDigest: "d3" },
      ),
    ).toEqual({ ok: false, reason: "session-gone" });
    expect(counts(w.db)).toEqual(before);
  });

  test("the actor's stored role is re-read: an Admin may not invite an Admin, a demoted Admin no one", () => {
    const w = inviteWorld();
    const store = createTeamStore(w.db);
    expect(store.createInvite(w.adminGuard, { ...NEW, role: "admin" })).toEqual({
      ok: false,
      reason: "forbidden",
      denial: { isAllowed: false, reason: "role", requiredRole: "owner" },
    });
    w.db.query("UPDATE users SET role = 'member' WHERE id = ?").run(w.admin);
    expect(store.createInvite(w.adminGuard, NEW)).toEqual({
      ok: false,
      reason: "forbidden",
      denial: { isAllowed: false, reason: "role", requiredRole: "admin" },
    });
    expect(counts(w.db).invites).toBe(0);
  });

  test("an existing account or a live invite for the email is refused; an expired one is not", () => {
    const w = inviteWorld();
    const store = createTeamStore(w.db);
    expect(store.createInvite(w.ownerGuard, { ...NEW, email: "a@example.com" })).toEqual({
      ok: false,
      reason: "account-exists",
    });
    expect(store.createInvite(w.ownerGuard, NEW).ok).toBe(true);
    expect(
      store.createInvite(w.ownerGuard, { ...NEW, tokenDigest: "d2", now: 604_800_999 }),
    ).toEqual({
      ok: false,
      reason: "invite-pending",
    });
    expect(
      store.createInvite(w.ownerGuard, { ...NEW, tokenDigest: "d3", now: 604_801_000 }).ok,
    ).toBe(true);
  });

  test("revoke: Admin only member and viewer invites; used or revoked is not-found", () => {
    const w = inviteWorld();
    const store = createTeamStore(w.db);
    store.createInvite(w.ownerGuard, { ...NEW, role: "admin", email: "b@example.com" });
    store.createInvite(w.ownerGuard, { ...NEW, tokenDigest: "d2" });
    expect(store.revokeInvite(w.adminGuard, 1, 2000)).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
    expect(store.revokeInvite(w.adminGuard, 2, 2000)).toEqual({ ok: true, id: 2 });
    expect(store.revokeInvite(w.adminGuard, 2, 2000)).toEqual({ ok: false, reason: "not-found" });
    expect(store.revokeInvite(w.ownerGuard, 99, 2000)).toEqual({ ok: false, reason: "not-found" });
    expect(store.pendingInvite(2)).toBeUndefined();
    expect(store.pendingInvite(1)).toMatchObject({ email: "b@example.com", createdByName: "Ow" });
    expect(w.db.query("SELECT action FROM people_events ORDER BY id").all()).toEqual([
      { action: "invite.create" },
      { action: "invite.create" },
      { action: "invite.revoke" },
    ]);
  });

  test("accept: live until expires_at, once, only while the creator may still make it", () => {
    const w = inviteWorld();
    const store = createTeamStore(w.db);
    store.createInvite(w.adminGuard, { ...NEW, now: 0 });
    const accept = { tokenDigest: "digest-1", name: "Newt", passwordHash: "hash" };
    expect(store.liveInvite("digest-1", 604_799_999)).toEqual({
      id: 1,
      email: "new@example.com",
      role: "member",
      expiresAt: 604_800_000,
    });
    expect(store.liveInvite("digest-1", 604_800_000)).toBeUndefined();
    expect(store.acceptInvite({ ...accept, now: 604_800_000 })).toEqual({
      ok: false,
      reason: "invalid",
    });
    w.db.query("UPDATE users SET role = 'member' WHERE id = ?").run(w.admin);
    expect(store.liveInvite("digest-1", 5)).toBeUndefined();
    expect(store.acceptInvite({ ...accept, now: 5 })).toEqual({ ok: false, reason: "invalid" });
    w.db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(w.admin);
    const ok = store.acceptInvite({ ...accept, now: 604_799_999 });
    expect(ok).toMatchObject({ ok: true, role: "member" });
    expect(store.acceptInvite({ ...accept, now: 6 })).toEqual({ ok: false, reason: "invalid" });
    expect(
      w.db.query("SELECT email, name, role, password_hash FROM users WHERE name = 'Newt'").get(),
    ).toEqual({
      email: "new@example.com",
      name: "Newt",
      role: "member",
      password_hash: "hash",
    });
    expect(
      w.db
        .query(
          "SELECT action, actor_email, target_kind, target_name, to_role FROM people_events WHERE action = 'invite.accept'",
        )
        .all(),
    ).toEqual([
      {
        action: "invite.accept",
        actor_email: "new@example.com",
        target_kind: "user",
        target_name: "Newt",
        to_role: "member",
      },
    ]);
  });

  test("accept refuses an email that got an account; a removed creator voids the link", () => {
    const w = inviteWorld();
    const store = createTeamStore(w.db);
    store.createInvite(w.adminGuard, NEW);
    store.createInvite(w.adminGuard, { ...NEW, email: "c@example.com", tokenDigest: "d2" });
    addUser(w.db, "new@example.com", "Other", "viewer", 3);
    const accept = { name: "N", passwordHash: "h", now: 2000 };
    expect(store.acceptInvite({ ...accept, tokenDigest: "digest-1" })).toEqual({
      ok: false,
      reason: "account-exists",
    });
    w.db.query("DELETE FROM users WHERE id = ?").run(w.admin);
    expect(store.acceptInvite({ ...accept, tokenDigest: "d2" })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test("a failed People-log insert rolls back create, revoke and accept", () => {
    const w = inviteWorld();
    const store = createTeamStore(w.db);
    store.createInvite(w.ownerGuard, NEW);
    w.db.run(
      "CREATE TRIGGER fail_people BEFORE INSERT ON people_events BEGIN SELECT RAISE(ABORT, 'test'); END",
    );
    const before = counts(w.db);
    expect(() =>
      store.createInvite(w.ownerGuard, { ...NEW, email: "z@example.com", tokenDigest: "d2" }),
    ).toThrow(PeopleLogError);
    expect(() => store.revokeInvite(w.ownerGuard, 1, 2000)).toThrow(PeopleLogError);
    expect(() =>
      store.acceptInvite({ tokenDigest: "digest-1", name: "N", passwordHash: "h", now: 2000 }),
    ).toThrow(PeopleLogError);
    expect(counts(w.db)).toEqual(before);
    expect(store.pendingInvite(1)).toBeDefined();
  });
});
