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
  test("a new file runs migrations 1 and 2 and sets the pragmas", () => {
    const db = opened(tempPath());
    expect(pragma(db, "user_version")).toBe(2);
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
      "pending_authenticators",
      "recovery_codes",
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
      "instance.setup_completed_at",
      "pending_authenticators.created_at",
      "pending_authenticators.secret",
      "pending_authenticators.session_digest",
      "pending_authenticators.user_id",
      "recovery_codes.digest",
      "recovery_codes.id",
      "recovery_codes.used_at",
      "recovery_codes.user_id",
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
    db.run("PRAGMA user_version = 3");
    db.close();
    expect(failure(path)).toBe(
      `PULSE_CONSOLE_DB=${path}: schema version 3 is newer than this console (2)`,
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
    expect(pragma(db, "user_version")).toBe(2);
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
});
