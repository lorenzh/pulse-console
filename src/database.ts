import { Database } from "bun:sqlite";
import { StartupError } from "@lorenzh/pulse-kit";

export const SCHEMA_VERSION = 1;
export const DB_FILE_MODE = 0o600;

/** File operations that `openDatabase` needs; `main.ts` wires the real `node:fs` ones. */
export interface DatabaseFiles {
  /** Creates the file with `mode` and fails with code `EEXIST` when it exists. */
  createFile: (path: string, mode: number) => void;
  chmod: (path: string, mode: number) => void;
}

const MIGRATION_1 = `
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

function codeOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return "UNKNOWN";
}

function cannotOpen(path: string, err: unknown): StartupError {
  // Only the path and the error code: SQLite messages can hold file content.
  return new StartupError(`PULSE_CONSOLE_DB=${path}: cannot open (${codeOf(err)})`, {
    setting: "PULSE_CONSOLE_DB",
  });
}

function ensureFileMode(path: string, files: DatabaseFiles): void {
  try {
    files.createFile(path, DB_FILE_MODE);
  } catch (err) {
    if (codeOf(err) !== "EEXIST") throw cannotOpen(path, err);
    try {
      files.chmod(path, DB_FILE_MODE);
    } catch (chmodErr) {
      throw cannotOpen(path, chmodErr);
    }
  }
}

function userVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

function migrate(db: Database, path: string): void {
  const version = userVersion(db);
  if (version > SCHEMA_VERSION) {
    throw new StartupError(
      `PULSE_CONSOLE_DB=${path}: schema version ${version} is newer than this console (${SCHEMA_VERSION})`,
      { setting: "PULSE_CONSOLE_DB" },
    );
  }
  if (version === 0) {
    db.transaction(() => {
      db.run(MIGRATION_1);
      db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }).immediate();
  }
}

/**
 * Opens the console database: sets the file mode to 0600 (a new file is created with it before
 * SQLite opens it), sets WAL, foreign keys and the busy timeout, and runs the migrations. A file
 * that cannot be opened or read is a StartupError, never a fresh database.
 */
export function openDatabase(path: string, files: DatabaseFiles): Database {
  ensureFileMode(path, files);
  let db: Database;
  try {
    db = new Database(path, { create: false, readwrite: true, strict: true });
  } catch (err) {
    throw cannotOpen(path, err);
  }
  try {
    // busy_timeout first, so a concurrent writer waits instead of failing the next pragmas.
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, path);
  } catch (err) {
    db.close();
    if (err instanceof StartupError) throw err;
    throw cannotOpen(path, err);
  }
  return db;
}
