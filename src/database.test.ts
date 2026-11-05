/* eslint-disable sonarjs/no-clear-text-protocols -- the URLs are stored values under test; no request is made */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StartupError } from "@lorenzh/pulse-kit";
import { type DatabaseFiles, openDatabase } from "./database.ts";

const dirs: string[] = [];
const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "console-db-"));
  dirs.push(dir);
  return join(dir, "console.db");
}

const realFiles: DatabaseFiles = {
  createFile: (path, mode) => closeSync(openSync(path, "wx", mode)),
  chmod: (path, mode) => chmodSync(path, mode),
};

function opened(path: string, files: DatabaseFiles = realFiles): Database {
  const db = openDatabase(path, files);
  open.push(db);
  return db;
}

function failure(path: string, files: DatabaseFiles = realFiles): string {
  try {
    open.push(openDatabase(path, files));
  } catch (err) {
    expect(err).toBeInstanceOf(StartupError);
    return err instanceof Error ? err.message : "";
  }
  throw new Error("openDatabase did not throw");
}

// The literal migration-1 SQL of schema 1 (#562); it must never change.
const SCHEMA_1_SQL = `
CREATE TABLE instance (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  api_url TEXT NOT NULL,
  setup_completed_at INTEGER NOT NULL
);
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX users_one_owner ON users(role) WHERE role = 'owner';
CREATE TABLE sessions (
  id_digest TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
`;

function pragma(db: Database, name: string): unknown {
  const row = db.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get();
  return row === null ? undefined : Object.values(row)[0];
}

describe("openDatabase", () => {
  test("a new file runs migrations 1 to 3 and sets the pragmas", () => {
    const db = opened(tempPath());
    expect(pragma(db, "user_version")).toBe(3);
    expect(pragma(db, "journal_mode")).toBe("wal");
    expect(pragma(db, "foreign_keys")).toBe(1);
    expect(pragma(db, "busy_timeout")).toBe(5000);
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual([
      "authenticators",
      "instance",
      "invites",
      "pending_authenticators",
      "people_events",
      "recovery_codes",
      "reset_links",
      "sessions",
      "users",
    ]);
  });

  test("no column can hold a token, a setup code, a grant, a password or a plain session id", () => {
    const db = opened(tempPath());
    const columns = db
      .query<{ c: string }, []>(
        "SELECT m.name || '.' || p.name AS c FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' ORDER BY c",
      )
      .all()
      .map((r) => r.c);
    expect(columns).toEqual([
      "authenticators.confirmed_at",
      "authenticators.last_step",
      "authenticators.secret",
      "authenticators.user_id",
      "instance.api_url",
      "instance.id",
      "instance.require_2fa_all",
      "instance.setup_completed_at",
      "invites.accepted_user_id",
      "invites.created_at",
      "invites.created_by",
      "invites.email",
      "invites.expires_at",
      "invites.id",
      "invites.revoked_at",
      "invites.role",
      "invites.token_digest",
      "invites.used_at",
      "pending_authenticators.created_at",
      "pending_authenticators.secret",
      "pending_authenticators.session_digest",
      "pending_authenticators.user_id",
      "people_events.action",
      "people_events.actor_email",
      "people_events.actor_kind",
      "people_events.actor_name",
      "people_events.actor_user_id",
      "people_events.at",
      "people_events.from_role",
      "people_events.id",
      "people_events.target_email",
      "people_events.target_id",
      "people_events.target_kind",
      "people_events.target_name",
      "people_events.to_role",
      "people_events.value",
      "recovery_codes.digest",
      "recovery_codes.id",
      "recovery_codes.used_at",
      "recovery_codes.user_id",
      "reset_links.created_at",
      "reset_links.expires_at",
      "reset_links.id",
      "reset_links.issued_by",
      "reset_links.kind",
      "reset_links.target_role",
      "reset_links.token_digest",
      "reset_links.used_at",
      "reset_links.user_id",
      "sessions.created_at",
      "sessions.csrf_token",
      "sessions.id_digest",
      "sessions.last_seen_at",
      "sessions.next_path",
      "sessions.stage",
      "sessions.user_id",
      "users.created_at",
      "users.email",
      "users.id",
      "users.name",
      "users.password_hash",
      "users.role",
    ]);
  });

  test("a new file is created with mode 0600 before SQLite opens it", () => {
    const path = tempPath();
    const calls: string[] = [];
    const files: DatabaseFiles = {
      createFile: (p, mode) => {
        calls.push(`create ${mode.toString(8)}`);
        realFiles.createFile(p, mode);
      },
      chmod: (_p, mode) => calls.push(`chmod ${mode.toString(8)}`),
    };
    opened(path, files);
    expect(calls).toEqual(["create 600"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("an existing file is set to 0600 and reopened without a new migration", () => {
    const path = tempPath();
    const first = opened(path);
    first.run(
      "INSERT INTO instance (id, api_url, setup_completed_at) VALUES (1, 'http://api:3000', 1)",
    );
    first.close();
    open.splice(0);
    chmodSync(path, 0o644);
    const db = opened(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(db.query("SELECT count(*) AS n FROM instance").get()).toEqual({ n: 1 });
  });

  test("a missing directory is a start failure with the path and the code", () => {
    const path = join(tempPath(), "missing", "console.db");
    expect(failure(path)).toBe(`PULSE_CONSOLE_DB=${path}: cannot open (ENOENT)`);
  });

  test("a failed chmod is a start failure with the code", () => {
    const path = tempPath();
    writeFileSync(path, "");
    const files: DatabaseFiles = {
      createFile: realFiles.createFile,
      chmod: () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
    };
    expect(failure(path, files)).toBe(`PULSE_CONSOLE_DB=${path}: cannot open (EPERM)`);
  });

  test("a file that is not a database fails and is not initialized", () => {
    const path = tempPath();
    const junk = Buffer.alloc(8192, 0x5a);
    writeFileSync(path, junk);
    expect(failure(path)).toBe(`PULSE_CONSOLE_DB=${path}: cannot open (SQLITE_NOTADB)`);
    expect(Buffer.compare(readFileSync(path), junk)).toBe(0);
  });

  test("a newer schema version fails with the literal text", () => {
    const path = tempPath();
    const db = new Database(path);
    db.run("PRAGMA user_version = 4");
    db.close();
    expect(failure(path)).toBe(
      `PULSE_CONSOLE_DB=${path}: schema version 4 is newer than this console (3)`,
    );
  });

  test("a schema-1 file migrates to 2: sessions go, owner and instance stay byte-equal", () => {
    const path = tempPath();
    const legacy = new Database(path);
    legacy.run(SCHEMA_1_SQL);
    legacy.run("PRAGMA user_version = 1");
    legacy.run(
      "INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (1, 'owner@example.com', 'Owner', '$argon2id$v=19$fixture', 'owner', 5)",
    );
    legacy.run(
      "INSERT INTO instance (id, api_url, setup_completed_at) VALUES (1, 'http://api:3000', 5)",
    );
    legacy.run(
      "INSERT INTO sessions (id_digest, user_id, csrf_token, created_at, last_seen_at) VALUES ('d1', 1, 'c1', 5, 5)",
    );
    legacy.close();
    const db = opened(path);
    expect(pragma(db, "user_version")).toBe(3);
    expect(db.query("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(db.query("SELECT email, password_hash, role FROM users").all()).toEqual([
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a fixture hash, not a password
      { email: "owner@example.com", password_hash: "$argon2id$v=19$fixture", role: "owner" },
    ]);
    expect(db.query("SELECT api_url, setup_completed_at FROM instance").all()).toEqual([
      { api_url: "http://api:3000", setup_completed_at: 5 },
    ]);
    const stageColumn = db
      .query<{ notnull: number }, []>(
        "SELECT \"notnull\" FROM pragma_table_info('sessions') WHERE name = 'stage'",
      )
      .get();
    expect(stageColumn).toEqual({ notnull: 1 });
    expect(() =>
      db.run(
        "INSERT INTO sessions (id_digest, user_id, csrf_token, created_at, last_seen_at, stage) VALUES ('d2', 1, 'c', 1, 1, 'other')",
      ),
    ).toThrow();
  });

  test("a recovery-code digest must be 64 lowercase hex characters", () => {
    const db = opened(tempPath());
    db.run(
      "INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (1, 'a@example.com', 'A', 'h', 'owner', 1)",
    );
    expect(() =>
      db.run(`INSERT INTO recovery_codes (user_id, digest) VALUES (1, '${"A".repeat(64)}')`),
    ).toThrow();
    expect(() =>
      db.run(`INSERT INTO recovery_codes (user_id, digest) VALUES (1, '${"a".repeat(63)}')`),
    ).toThrow();
    db.run(`INSERT INTO recovery_codes (user_id, digest) VALUES (1, '${"a".repeat(64)}')`);
    expect(db.query("SELECT count(*) AS n FROM recovery_codes").get()).toEqual({ n: 1 });
  });

  test("a schema-2 file migrates to 3 and keeps owner, hash, sessions and factors", () => {
    const path = tempPath();
    const legacy = new Database(path);
    legacy.run(SCHEMA_1_SQL);
    legacy.run("PRAGMA user_version = 1");
    legacy.close();
    // Migration 2 runs on this open; then the file is put back to version 2 with data in it.
    const two = opened(path);
    two.run("DROP TRIGGER users_role_insert");
    two.run("DROP TRIGGER users_role_update");
    two.run("DROP TRIGGER people_events_no_update");
    two.run("DROP TRIGGER people_events_no_delete");
    two.run("DROP TABLE invites");
    two.run("DROP TABLE reset_links");
    two.run("DROP TABLE people_events");
    two.run("ALTER TABLE instance DROP COLUMN require_2fa_all");
    two.run("PRAGMA user_version = 2");
    two.run(
      "INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (1, 'owner@example.com', 'Owner', '$argon2id$v=19$fixture', 'owner', 5)",
    );
    two.run(
      "INSERT INTO instance (id, api_url, setup_completed_at) VALUES (1, 'http://api:3000', 5)",
    );
    two.run(
      "INSERT INTO sessions (id_digest, user_id, csrf_token, created_at, last_seen_at, stage) VALUES ('d1', 1, 'c1', 5, 6, 'full')",
    );
    two.run(
      "INSERT INTO authenticators (user_id, secret, last_step, confirmed_at) VALUES (1, 'sealed', 7, 5)",
    );
    two.run(`INSERT INTO recovery_codes (user_id, digest) VALUES (1, '${"b".repeat(64)}')`);
    open.splice(open.indexOf(two), 1);
    two.close();
    const db = opened(path);
    expect(pragma(db, "user_version")).toBe(3);
    expect(db.query("SELECT email, password_hash, role FROM users").all()).toEqual([
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a fixture hash, not a password
      { email: "owner@example.com", password_hash: "$argon2id$v=19$fixture", role: "owner" },
    ]);
    expect(db.query("SELECT id_digest, stage, last_seen_at FROM sessions").all()).toEqual([
      { id_digest: "d1", stage: "full", last_seen_at: 6 },
    ]);
    expect(db.query("SELECT secret, last_step FROM authenticators").all()).toEqual([
      { secret: "sealed", last_step: 7 },
    ]);
    expect(db.query("SELECT digest FROM recovery_codes").all()).toEqual([
      { digest: "b".repeat(64) },
    ]);
    expect(db.query("SELECT require_2fa_all FROM instance").all()).toEqual([
      { require_2fa_all: 0 },
    ]);
  });

  test("migration 3 refuses an unknown role, a second owner and an owner invite", () => {
    const db = opened(tempPath());
    const insert = (email: string, role: string) =>
      db.run(
        `INSERT INTO users (email, name, password_hash, role, created_at) VALUES ('${email}', 'N', 'h', '${role}', 1)`,
      );
    expect(() => insert("s@example.com", "superuser")).toThrow("invalid role");
    insert("o@example.com", "owner");
    insert("m@example.com", "member");
    expect(() => insert("o2@example.com", "owner")).toThrow();
    expect(() => db.run("UPDATE users SET role = 'superuser' WHERE role = 'member'")).toThrow(
      "invalid role",
    );
    expect(() =>
      db.run(
        "INSERT INTO invites (token_digest, email, role, created_at, expires_at) VALUES ('d', 'x@example.com', 'owner', 1, 2)",
      ),
    ).toThrow();
    db.run(
      "INSERT INTO instance (id, api_url, setup_completed_at) VALUES (1, 'http://api:3000', 1)",
    );
    expect(() => db.run("UPDATE instance SET require_2fa_all = 2")).toThrow();
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_sequence'",
        )
        .get(),
    ).toEqual({ n: 0 });
  });
});
