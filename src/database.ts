import { Database } from "bun:sqlite";
import { StartupError } from "@lorenzh/pulse-kit";

export const SCHEMA_VERSION = 3;
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

// Schema 2 drops the schema-1 sessions: their rows have no stage, so every browser signs in again.
const MIGRATION_2 = `
DROP TABLE sessions;
CREATE TABLE sessions (
  id_digest TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('factor', 'enrol', 'full')),
  next_path TEXT
);
CREATE INDEX sessions_user_id ON sessions(user_id);
CREATE TABLE authenticators (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret TEXT NOT NULL,
  last_step INTEGER NOT NULL,
  confirmed_at INTEGER NOT NULL
);
CREATE TABLE pending_authenticators (
  session_digest TEXT PRIMARY KEY REFERENCES sessions(id_digest) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE recovery_codes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
  used_at INTEGER,
  UNIQUE (user_id, digest)
);
CREATE INDEX recovery_codes_user_id ON recovery_codes(user_id);
`;

// Schema 3 adds team roles, invites, reset links and the append-only People log.
const MIGRATION_3 = `
CREATE TRIGGER users_role_insert BEFORE INSERT ON users
WHEN NEW.role NOT IN ('owner', 'admin', 'member', 'viewer')
BEGIN SELECT RAISE(ABORT, 'invalid role'); END;
CREATE TRIGGER users_role_update BEFORE UPDATE OF role ON users
WHEN NEW.role NOT IN ('owner', 'admin', 'member', 'viewer')
BEGIN SELECT RAISE(ABORT, 'invalid role'); END;
ALTER TABLE instance ADD COLUMN require_2fa_all INTEGER NOT NULL DEFAULT 0
  CHECK (require_2fa_all IN (0, 1));
CREATE TABLE invites (
  id INTEGER PRIMARY KEY,
  token_digest TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  accepted_user_id INTEGER
);
CREATE TABLE reset_links (
  id INTEGER PRIMARY KEY,
  token_digest TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('team', 'owner-recovery')),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_role TEXT NOT NULL,
  issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE people_events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'container')),
  actor_user_id INTEGER,
  actor_email TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id INTEGER,
  target_email TEXT,
  target_name TEXT,
  from_role TEXT,
  to_role TEXT,
  value TEXT
);
CREATE TRIGGER people_events_no_update BEFORE UPDATE ON people_events
BEGIN SELECT RAISE(ABORT, 'people_events is append-only'); END;
CREATE TRIGGER people_events_no_delete BEFORE DELETE ON people_events
BEGIN SELECT RAISE(ABORT, 'people_events is append-only'); END;
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
      db.run("PRAGMA user_version = 1");
    }).immediate();
  }
  if (version <= 1) {
    db.transaction(() => {
      db.run(MIGRATION_2);
      db.run("PRAGMA user_version = 2");
    }).immediate();
  }
  if (version <= 2) {
    db.transaction(() => {
      db.run(MIGRATION_3);
      db.run("PRAGMA user_version = 3");
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
