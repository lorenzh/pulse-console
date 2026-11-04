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

function pragma(db: Database, name: string): unknown {
  const row = db.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get();
  return row === null ? undefined : Object.values(row)[0];
}

describe("openDatabase", () => {
  test("migration 1 sets the version and the pragmas", () => {
    const db = opened(tempPath());
    expect(pragma(db, "user_version")).toBe(1);
    expect(pragma(db, "journal_mode")).toBe("wal");
    expect(pragma(db, "foreign_keys")).toBe(1);
    expect(pragma(db, "busy_timeout")).toBe(5000);
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(["instance", "sessions", "users"]);
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
      "instance.api_url",
      "instance.id",
      "instance.setup_completed_at",
      "sessions.created_at",
      "sessions.csrf_token",
      "sessions.id_digest",
      "sessions.last_seen_at",
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
    db.run("PRAGMA user_version = 2");
    db.close();
    expect(failure(path)).toBe(
      `PULSE_CONSOLE_DB=${path}: schema version 2 is newer than this console (1)`,
    );
  });
});
