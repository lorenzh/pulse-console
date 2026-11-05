import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database.ts";
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
