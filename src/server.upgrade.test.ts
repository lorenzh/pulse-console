import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PASSWORD_HASH_OPTIONS } from "./passwords.ts";
import {
  Client,
  closeAll,
  count,
  EMAIL,
  PASSWORD,
  SESSION,
  START,
  startConsole,
} from "./two-factor-harness.ts";

const dirs: string[] = [];
afterEach(async () => {
  await closeAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The literal migration-1 SQL of schema 1 (#562).
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
const API_URL = "http://api.example:3000/pulse";
const OLD_COOKIE = "legacy-session-cookie-value-of-schema-one-0001";

describe("upgrade of a #562 database", () => {
  test("keeps the owner, ends the old session and leads the password to enrolment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "console-upgrade-"));
    dirs.push(dir);
    const dbPath = join(dir, "console.db");
    const hash = await Bun.password.hash(PASSWORD, PASSWORD_HASH_OPTIONS);
    const old = new Database(dbPath, { create: true });
    old.run("PRAGMA journal_mode = WAL");
    old.run(SCHEMA_1_SQL);
    old
      .query("INSERT INTO instance (id, api_url, setup_completed_at) VALUES (1, ?, ?)")
      .run(API_URL, START);
    old
      .query(
        "INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (1, ?, 'Owner', ?, 'owner', ?)",
      )
      .run(EMAIL, hash, START);
    const digest = createHash("sha256").update(OLD_COOKIE).digest("hex");
    old
      .query(
        "INSERT INTO sessions (id_digest, user_id, csrf_token, created_at, last_seen_at) VALUES (?, 1, 'csrf', ?, ?)",
      )
      .run(digest, START, START);
    old.run("PRAGMA user_version = 1");
    old.close();

    const c = await startConsole({ dbPath });
    const check = new Database(dbPath, { readonly: true });
    expect(
      check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
    ).toBe(2);
    const user = check
      .query<{ email: string; password_hash: string }, []>("SELECT email, password_hash FROM users")
      .get();
    const instance = check.query<{ api_url: string }, []>("SELECT api_url FROM instance").get();
    check.close();
    expect(user?.email).toBe(EMAIL);
    expect(user?.password_hash).toBe(hash);
    expect(instance?.api_url).toBe(API_URL);
    expect(count(dbPath, "SELECT count(*) AS n FROM sessions")).toBe(0);

    const client = new Client(c);
    expect((await client.get("/setup")).status).toBe(404);
    client.jar.set(SESSION, OLD_COOKIE);
    const refused = await client.get("/");
    expect(refused.status).toBe(303);
    expect(refused.headers.get("location")).toBe("/sign-in?next=%2F");
    const password = await client.password();
    expect(password.status).toBe(303);
    expect(password.headers.get("location")).toBe("/account/authenticator");
  });
});
