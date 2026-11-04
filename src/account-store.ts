import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export interface Instance {
  apiUrl: string;
  setupCompletedAt: number;
}

export interface User {
  id: number;
  email: string;
  name: string;
  passwordHash: string;
  role: "owner";
}

export interface NewOwner {
  email: string;
  name: string;
  passwordHash: string;
}

export interface Session {
  userId: number;
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
}

export type SetupResult = { ok: true; userId: number } | { ok: false; reason: "already-complete" };

export interface AccountStore {
  instance: () => Instance | undefined;
  /** In one BEGIN IMMEDIATE transaction: refuse when set up, else insert the owner and the instance row. */
  completeSetup: (owner: NewOwner, apiUrl: string, now: number) => SetupResult;
  userByEmail: (email: string) => User | undefined;
  userById: (id: number) => User | undefined;
  /** Stores only the SHA-256 digest of `sessionId`. */
  createSession: (sessionId: string, userId: number, csrfToken: string, now: number) => void;
  session: (sessionId: string) => Session | undefined;
  touchSession: (sessionId: string, now: number) => void;
  deleteSession: (sessionId: string) => void;
  /** Deletes the sessions with `last_seen_at + idleMs <= now`; returns how many. */
  deleteExpiredSessions: (now: number, idleMs: number) => number;
}

/** The row key of a session: the SHA-256 hex digest of its id. */
export function sessionDigest(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

interface UserRow {
  id: number;
  email: string;
  name: string;
  password_hash: string;
}

function toUser(row: UserRow | null): User | undefined {
  if (row === null) return undefined;
  // Migration 1 allows only the owner role, which completeSetup writes.
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    role: "owner",
  };
}

/** The account store over an open console database. */
export function createAccountStore(db: Database): AccountStore {
  const selectInstance = db.query<{ api_url: string; setup_completed_at: number }, []>(
    "SELECT api_url, setup_completed_at FROM instance WHERE id = 1",
  );
  const insertOwner = db.query<{ id: number }, [string, string, string, number]>(
    "INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'owner', ?) RETURNING id",
  );
  const insertInstance = db.query<unknown, [string, number]>(
    "INSERT INTO instance (id, api_url, setup_completed_at) VALUES (1, ?, ?)",
  );
  const userColumns = "SELECT id, email, name, password_hash FROM users";
  const selectUserByEmail = db.query<UserRow, [string]>(`${userColumns} WHERE email = ?`);
  const selectUserById = db.query<UserRow, [number]>(`${userColumns} WHERE id = ?`);
  const insertSession = db.query<unknown, [string, number, string, number, number]>(
    "INSERT INTO sessions (id_digest, user_id, csrf_token, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  );
  const selectSession = db.query<
    { user_id: number; csrf_token: string; created_at: number; last_seen_at: number },
    [string]
  >("SELECT user_id, csrf_token, created_at, last_seen_at FROM sessions WHERE id_digest = ?");
  const updateLastSeen = db.query<unknown, [number, string]>(
    "UPDATE sessions SET last_seen_at = ? WHERE id_digest = ?",
  );
  const removeSession = db.query<unknown, [string]>("DELETE FROM sessions WHERE id_digest = ?");
  const removeExpired = db.query<unknown, [number, number]>(
    "DELETE FROM sessions WHERE last_seen_at + ? <= ?",
  );

  const setup = db.transaction((owner: NewOwner, apiUrl: string, now: number): SetupResult => {
    if (selectInstance.get() !== null) return { ok: false, reason: "already-complete" };
    const row = insertOwner.get(owner.email, owner.name, owner.passwordHash, now);
    if (row === null) throw new Error("owner insert returned no id");
    insertInstance.run(apiUrl, now);
    return { ok: true, userId: row.id };
  });

  return {
    instance: () => {
      const row = selectInstance.get();
      return row === null
        ? undefined
        : { apiUrl: row.api_url, setupCompletedAt: row.setup_completed_at };
    },
    completeSetup: (owner, apiUrl, now) => setup.immediate(owner, apiUrl, now),
    userByEmail: (email) => toUser(selectUserByEmail.get(email)),
    userById: (id) => toUser(selectUserById.get(id)),
    createSession: (sessionId, userId, csrfToken, now) => {
      insertSession.run(sessionDigest(sessionId), userId, csrfToken, now, now);
    },
    session: (sessionId) => {
      const row = selectSession.get(sessionDigest(sessionId));
      if (row === null) return undefined;
      return {
        userId: row.user_id,
        csrfToken: row.csrf_token,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
      };
    },
    touchSession: (sessionId, now) => {
      updateLastSeen.run(now, sessionDigest(sessionId));
    },
    deleteSession: (sessionId) => {
      removeSession.run(sessionDigest(sessionId));
    },
    deleteExpiredSessions: (now, idleMs) => removeExpired.run(idleMs, now).changes,
  };
}
