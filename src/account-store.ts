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

export type SessionStage = "factor" | "enrol" | "full";

export interface Session {
  userId: number;
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
  stage: SessionStage;
  /** The path after sign-in; only partial stages store one. */
  nextPath: string | undefined;
}

/** A row of the sessions page: a live `full` session, without its id or token. */
export interface SessionListing {
  createdAt: number;
  lastSeenAt: number;
  isCurrent: boolean;
}

export interface NewSessionOptions {
  stage: SessionStage;
  nextPath?: string;
}

/** A `full` session lives this long after its last use. */
export const SESSION_IDLE_MS = 2_592_000_000;
/** A `factor` or `enrol` session and a pending authenticator live this long after creation. */
export const PARTIAL_SESSION_MS = 900_000;

/** The first instant at which the session is no longer live. Partial stages are never touched. */
export function sessionExpiresAt(session: Session): number {
  return session.stage === "full"
    ? session.lastSeenAt + SESSION_IDLE_MS
    : session.createdAt + PARTIAL_SESSION_MS;
}

/** Whether the session is live at `now`. */
export function isSessionLive(session: Session, now: number): boolean {
  return now < sessionExpiresAt(session);
}

export type SetupResult = { ok: true; userId: number } | { ok: false; reason: "already-complete" };

export interface AccountStore {
  instance: () => Instance | undefined;
  /** In one BEGIN IMMEDIATE transaction: refuse when set up, else insert the owner and the instance row. */
  completeSetup: (owner: NewOwner, apiUrl: string, now: number) => SetupResult;
  userByEmail: (email: string) => User | undefined;
  userById: (id: number) => User | undefined;
  /** Stores only the SHA-256 digest of `sessionId`. Without `options` the stage is `full`. */
  createSession: (
    sessionId: string,
    userId: number,
    csrfToken: string,
    now: number,
    options?: NewSessionOptions,
  ) => void;
  session: (sessionId: string) => Session | undefined;
  /** Updates `last_seen_at` of a `full` row only; it never inserts. */
  touchSession: (sessionId: string, now: number) => void;
  deleteSession: (sessionId: string) => void;
  /**
   * Deletes `full` rows with `last_seen_at + idleMs <= now`, partial rows and pending
   * authenticators with `created_at + 900000 <= now`; returns how many sessions went.
   */
  deleteExpiredSessions: (now: number, idleMs: number) => number;
  /** Live `full` sessions of the user, newest last use first. Deletes expired rows first. */
  listSessions: (userId: number, currentId: string, now: number) => SessionListing[];
  /** One DELETE of every other session row of the user, in every stage; returns how many. */
  deleteOtherSessions: (userId: number, currentId: string) => number;
}

/** The row key of a session: the SHA-256 hex digest of its id. */
export function sessionDigest(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

/** The insert of a new session row; the factor store uses it inside its commit transactions. */
export const INSERT_SESSION_SQL =
  "INSERT INTO sessions (id_digest, user_id, csrf_token, created_at, last_seen_at, stage, next_path) VALUES (?, ?, ?, ?, ?, ?, ?)";

interface SessionRow {
  user_id: number;
  csrf_token: string;
  created_at: number;
  last_seen_at: number;
  stage: string;
  next_path: string | null;
}

function toStage(value: string): SessionStage {
  // The CHECK constraint of migration 2 allows only these values; anything else is the most limited.
  if (value === "full" || value === "enrol") return value;
  return "factor";
}

function toSession(row: SessionRow): Session {
  return {
    userId: row.user_id,
    csrfToken: row.csrf_token,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    stage: toStage(row.stage),
    nextPath: row.next_path ?? undefined,
  };
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
  const insertSession = db.query<
    unknown,
    [string, number, string, number, number, SessionStage, string | null]
  >(INSERT_SESSION_SQL);
  const selectSession = db.query<SessionRow, [string]>(
    "SELECT user_id, csrf_token, created_at, last_seen_at, stage, next_path FROM sessions WHERE id_digest = ?",
  );
  const updateLastSeen = db.query<unknown, [number, string]>(
    "UPDATE sessions SET last_seen_at = ? WHERE id_digest = ? AND stage = 'full'",
  );
  const removeSession = db.query<unknown, [string]>("DELETE FROM sessions WHERE id_digest = ?");
  const removeExpired = db.query<unknown, [number, number, number, number]>(
    "DELETE FROM sessions WHERE (stage = 'full' AND last_seen_at + ? <= ?) OR (stage <> 'full' AND created_at + ? <= ?)",
  );
  const removeExpiredPending = db.query<unknown, [number, number]>(
    "DELETE FROM pending_authenticators WHERE created_at + ? <= ?",
  );
  const selectFullSessions = db.query<
    { id_digest: string; created_at: number; last_seen_at: number },
    [number]
  >(
    "SELECT id_digest, created_at, last_seen_at FROM sessions WHERE user_id = ? AND stage = 'full' ORDER BY last_seen_at DESC, created_at DESC",
  );
  const removeOthers = db.query<unknown, [number, string]>(
    "DELETE FROM sessions WHERE user_id = ? AND id_digest <> ?",
  );
  const expire = (now: number, idleMs: number): number => {
    removeExpiredPending.run(PARTIAL_SESSION_MS, now);
    return removeExpired.run(idleMs, now, PARTIAL_SESSION_MS, now).changes;
  };

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
    createSession: (sessionId, userId, csrfToken, now, options) => {
      const stage = options?.stage ?? "full";
      // Only partial stages carry the path; a full session has already been sent there.
      const nextPath = stage === "full" ? null : (options?.nextPath ?? null);
      insertSession.run(sessionDigest(sessionId), userId, csrfToken, now, now, stage, nextPath);
    },
    session: (sessionId) => {
      const row = selectSession.get(sessionDigest(sessionId));
      return row === null ? undefined : toSession(row);
    },
    touchSession: (sessionId, now) => {
      updateLastSeen.run(now, sessionDigest(sessionId));
    },
    deleteSession: (sessionId) => {
      removeSession.run(sessionDigest(sessionId));
    },
    deleteExpiredSessions: expire,
    listSessions: (userId, currentId, now) => {
      expire(now, SESSION_IDLE_MS);
      const current = sessionDigest(currentId);
      return selectFullSessions.all(userId).map((row) => ({
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        isCurrent: row.id_digest === current,
      }));
    },
    deleteOtherSessions: (userId, currentId) =>
      removeOthers.run(userId, sessionDigest(currentId)).changes,
  };
}
