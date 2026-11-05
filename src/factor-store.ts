import type { Database } from "bun:sqlite";
import { INSERT_SESSION_SQL, PARTIAL_SESSION_MS, sessionDigest } from "./account-store.ts";
import { matchRecoveryCode, type RecoveryCodeRow } from "./recovery-codes.ts";

/**
 * The actor of a guarded write: the write runs only while a session row with the digest of
 * `sessionId` and `user_id = userId` exists, and, when set, the stored password hash still
 * equals `passwordHash`.
 */
export type CredentialGuard = {
  sessionId: string;
  userId: number;
  passwordHash?: string | undefined;
};

/** Whether the guard still holds. Call it first inside the write's BEGIN IMMEDIATE transaction. */
export function isCredentialGuardHeld(db: Database, guard: CredentialGuard): boolean {
  const session = db
    .query<{ found: number }, [string, number]>(
      "SELECT 1 AS found FROM sessions WHERE id_digest = ? AND user_id = ?",
    )
    .get(sessionDigest(guard.sessionId), guard.userId);
  if (session === null) return false;
  if (guard.passwordHash === undefined) return true;
  const user = db
    .query<{ password_hash: string }, [number]>("SELECT password_hash FROM users WHERE id = ?")
    .get(guard.userId);
  return user?.password_hash === guard.passwordHash;
}

export interface Authenticator {
  /** The sealed seed envelope; never the plain seed. */
  secret: string;
  lastStep: number;
  confirmedAt: number;
}

export interface PendingAuthenticator {
  secret: string;
  createdAt: number;
}

/** The id and CSRF token of the `full` session that a commit inserts. */
export interface NewFullSession {
  id: string;
  csrfToken: string;
}

export interface ConfirmInput {
  sessionId: string;
  userId: number;
  /** The envelope that the caller checked the code against; it must still be the pending one. */
  secret: string;
  step: number;
  /** SHA-256 hex digests of the new recovery codes. */
  recoveryDigests: readonly string[];
  newSession: NewFullSession;
  now: number;
}

export type ConfirmResult = { ok: true } | { ok: false; reason: "no-pending" };

export interface FactorSignInBase {
  sessionId: string;
  userId: number;
  newSession: NewFullSession;
  now: number;
}

export type FactorSignInResult =
  | { ok: true; nextPath: string | undefined; remaining: number }
  | { ok: false; reason: "no-session" | "factor" | "form" };

export interface FactorStore {
  authenticator: (userId: number) => Authenticator | undefined;
  /** The live pending authenticator of this session. */
  pendingAuthenticator: (sessionId: string, now: number) => PendingAuthenticator | undefined;
  /** Creates or replaces the pending authenticator of this session. */
  savePendingAuthenticator: (
    sessionId: string,
    userId: number,
    secret: string,
    now: number,
  ) => void;
  unusedRecoveryCodeCount: (userId: number) => number;
  /** In one transaction: delete every code of the user, insert the new set. */
  replaceRecoveryCodes: (userId: number, digests: readonly string[]) => void;
  /** `replaceRecoveryCodes` for the guard's user, only while the guard holds. */
  replaceRecoveryCodesFor: (guard: CredentialGuard, digests: readonly string[]) => GuardedResult;
  /** `savePendingAuthenticator` for the guard's session, only while the guard holds. */
  savePendingAuthenticatorFor: (
    guard: CredentialGuard,
    secret: string,
    now: number,
  ) => GuardedResult;
  /**
   * In one BEGIN IMMEDIATE transaction: delete the live pending row, replace the authenticator
   * and the recovery codes, delete every session of the user and insert the new `full` session.
   */
  confirmAuthenticator: (input: ConfirmInput) => ConfirmResult;
  /** In one BEGIN IMMEDIATE transaction: end the `factor` session, store the step, start `full`. */
  completeTotpSignIn: (input: FactorSignInBase & { step: number }) => FactorSignInResult;
  /** In one BEGIN IMMEDIATE transaction: end the `factor` session, use the code, start `full`. */
  completeRecoverySignIn: (
    input: FactorSignInBase & { candidate: Uint8Array; canCommit?: () => boolean },
  ) => FactorSignInResult;
}

/** The answer of a guarded write: `ok: false` when the guard failed and nothing was written. */
export type GuardedResult = { ok: true } | { ok: false };

class CommitAborted extends Error {
  override name = "CommitAborted";
  readonly reason: "no-session" | "factor" | "no-pending" | "form";

  constructor(reason: "no-session" | "factor" | "no-pending" | "form") {
    super(`commit aborted: ${reason}`);
    this.reason = reason;
  }
}

function abortReason(err: unknown): CommitAborted["reason"] {
  if (err instanceof CommitAborted) return err.reason;
  throw err;
}

/** The authenticator, pending row and recovery-code store over an open console database. */
export function createFactorStore(db: Database): FactorStore {
  const selectAuthenticator = db.query<
    { secret: string; last_step: number; confirmed_at: number },
    [number]
  >("SELECT secret, last_step, confirmed_at FROM authenticators WHERE user_id = ?");
  const selectPending = db.query<{ secret: string; created_at: number }, [string, number, number]>(
    "SELECT secret, created_at FROM pending_authenticators WHERE session_digest = ? AND created_at + ? > ?",
  );
  const upsertPending = db.query<unknown, [string, number, string, number]>(
    "INSERT OR REPLACE INTO pending_authenticators (session_digest, user_id, secret, created_at) VALUES (?, ?, ?, ?)",
  );
  const removePending = db.query<unknown, [string, string, number, number]>(
    "DELETE FROM pending_authenticators WHERE session_digest = ? AND secret = ? AND created_at + ? > ?",
  );
  const upsertAuthenticator = db.query<unknown, [number, string, number, number]>(
    "INSERT OR REPLACE INTO authenticators (user_id, secret, last_step, confirmed_at) VALUES (?, ?, ?, ?)",
  );
  const updateStep = db.query<unknown, [number, number, number]>(
    "UPDATE authenticators SET last_step = ? WHERE user_id = ? AND last_step < ?",
  );
  const countUnused = db.query<{ n: number }, [number]>(
    "SELECT count(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL",
  );
  const removeCodes = db.query<unknown, [number]>("DELETE FROM recovery_codes WHERE user_id = ?");
  const insertCode = db.query<unknown, [number, string]>(
    "INSERT INTO recovery_codes (user_id, digest) VALUES (?, ?)",
  );
  // Never filtered by digest: the comparison is the timing-safe one in recovery-codes.ts.
  const selectUnusedCodes = db.query<RecoveryCodeRow, [number]>(
    "SELECT id, digest FROM recovery_codes WHERE user_id = ? AND used_at IS NULL",
  );
  const useCode = db.query<unknown, [number, number]>(
    "UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL",
  );
  const removeUserSessions = db.query<unknown, [number]>("DELETE FROM sessions WHERE user_id = ?");
  const removeFactorSession = db.query<
    { next_path: string | null },
    [string, number, number, number]
  >(
    "DELETE FROM sessions WHERE id_digest = ? AND user_id = ? AND stage = 'factor' AND created_at + ? > ? RETURNING next_path",
  );
  const insertSession = db.query<
    unknown,
    [string, number, string, number, number, string, string | null]
  >(INSERT_SESSION_SQL);

  const insertFull = (userId: number, session: NewFullSession, now: number): void => {
    insertSession.run(sessionDigest(session.id), userId, session.csrfToken, now, now, "full", null);
  };
  const writeCodes = (userId: number, digests: readonly string[]): void => {
    removeCodes.run(userId);
    for (const digest of digests) insertCode.run(userId, digest);
  };
  const endFactorSession = (input: FactorSignInBase): string | undefined => {
    const row = removeFactorSession.get(
      sessionDigest(input.sessionId),
      input.userId,
      PARTIAL_SESSION_MS,
      input.now,
    );
    if (row === null) throw new CommitAborted("no-session");
    return row.next_path ?? undefined;
  };

  const confirm = db.transaction((input: ConfirmInput): void => {
    const digest = sessionDigest(input.sessionId);
    if (removePending.run(digest, input.secret, PARTIAL_SESSION_MS, input.now).changes !== 1) {
      throw new CommitAborted("no-pending");
    }
    upsertAuthenticator.run(input.userId, input.secret, input.step, input.now);
    writeCodes(input.userId, input.recoveryDigests);
    removeUserSessions.run(input.userId);
    insertFull(input.userId, input.newSession, input.now);
  });
  const replaceCodes = db.transaction((userId: number, digests: readonly string[]): void => {
    writeCodes(userId, digests);
  });
  const replaceCodesFor = db.transaction(
    (guard: CredentialGuard, digests: readonly string[]): GuardedResult => {
      if (!isCredentialGuardHeld(db, guard)) return { ok: false };
      writeCodes(guard.userId, digests);
      return { ok: true };
    },
  );
  const savePendingFor = db.transaction(
    (guard: CredentialGuard, secret: string, now: number): GuardedResult => {
      if (!isCredentialGuardHeld(db, guard)) return { ok: false };
      upsertPending.run(sessionDigest(guard.sessionId), guard.userId, secret, now);
      return { ok: true };
    },
  );
  const totpSignIn = db.transaction(
    (input: FactorSignInBase & { step: number }): FactorSignInResult => {
      const nextPath = endFactorSession(input);
      if (updateStep.run(input.step, input.userId, input.step).changes !== 1) {
        throw new CommitAborted("factor");
      }
      insertFull(input.userId, input.newSession, input.now);
      return { ok: true, nextPath, remaining: countUnused.get(input.userId)?.n ?? 0 };
    },
  );
  const recoverySignIn = db.transaction(
    (
      input: FactorSignInBase & { candidate: Uint8Array; canCommit?: () => boolean },
    ): FactorSignInResult => {
      const nextPath = endFactorSession(input);
      const id = matchRecoveryCode(input.candidate, selectUnusedCodes.all(input.userId));
      if (id === undefined) throw new CommitAborted("factor");
      // Check the form only after verification, while the write lock still protects the code.
      if (input.canCommit?.() === false) throw new CommitAborted("form");
      if (useCode.run(input.now, id).changes !== 1) {
        throw new CommitAborted("factor");
      }
      insertFull(input.userId, input.newSession, input.now);
      return { ok: true, nextPath, remaining: countUnused.get(input.userId)?.n ?? 0 };
    },
  );

  return {
    authenticator: (userId) => {
      const row = selectAuthenticator.get(userId);
      if (row === null) return undefined;
      return { secret: row.secret, lastStep: row.last_step, confirmedAt: row.confirmed_at };
    },
    pendingAuthenticator: (sessionId, now) => {
      const row = selectPending.get(sessionDigest(sessionId), PARTIAL_SESSION_MS, now);
      return row === null ? undefined : { secret: row.secret, createdAt: row.created_at };
    },
    savePendingAuthenticator: (sessionId, userId, secret, now) => {
      upsertPending.run(sessionDigest(sessionId), userId, secret, now);
    },
    unusedRecoveryCodeCount: (userId) => countUnused.get(userId)?.n ?? 0,
    replaceRecoveryCodes: (userId, digests) => replaceCodes.immediate(userId, digests),
    replaceRecoveryCodesFor: (guard, digests) => replaceCodesFor.immediate(guard, digests),
    savePendingAuthenticatorFor: (guard, secret, now) =>
      savePendingFor.immediate(guard, secret, now),
    confirmAuthenticator: (input) => {
      try {
        confirm.immediate(input);
        return { ok: true };
      } catch (err) {
        abortReason(err);
        return { ok: false, reason: "no-pending" };
      }
    },
    completeTotpSignIn: (input) => {
      try {
        return totpSignIn.immediate(input);
      } catch (err) {
        return signInFailure(abortReason(err));
      }
    },
    completeRecoverySignIn: (input) => {
      try {
        return recoverySignIn.immediate(input);
      } catch (err) {
        return signInFailure(abortReason(err));
      }
    },
  };
}

function signInFailure(reason: CommitAborted["reason"]): FactorSignInResult {
  if (reason === "form") return { ok: false, reason };
  return { ok: false, reason: reason === "no-session" ? "no-session" : "factor" };
}
