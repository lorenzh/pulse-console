import type { Database } from "bun:sqlite";
import { type CredentialGuard, isCredentialGuardHeld } from "./factor-store.ts";
import { appendPeopleEvent, type PeoplePerson } from "./people-log.ts";
import { type TargetDecision, targetDecision } from "./permissions.ts";
import { type ConsoleRole, parseRole } from "./roles.ts";

/** An invite lives this long after it was made. */
export const INVITE_TTL_MS = 604_800_000;

/** The role an invite may carry; never `owner`. */
export type InviteRole = "admin" | "member" | "viewer";

/** A refused target rule. */
export type TargetDenial = Exclude<TargetDecision, { isAllowed: true }>;

export type NewInvite = { email: string; role: InviteRole; tokenDigest: string; now: number };

export type CreateInviteResult =
  | { ok: true; id: number; expiresAt: number }
  | { ok: false; reason: "session-gone" | "account-exists" | "invite-pending" }
  | { ok: false; reason: "forbidden"; denial: TargetDenial };

export type RevokeInviteResult =
  | { ok: true; id: number }
  | { ok: false; reason: "session-gone" | "not-found" }
  | { ok: false; reason: "forbidden"; denial: TargetDenial };

/** A live invite whose creator may still make it. */
export interface LiveInvite {
  id: number;
  email: string;
  role: ConsoleRole;
  expiresAt: number;
}

export type AcceptInput = { tokenDigest: string; name: string; passwordHash: string; now: number };

export type AcceptInviteResult =
  | { ok: true; userId: number; role: ConsoleRole }
  | { ok: false; reason: "invalid" | "account-exists" };

/** One row of the People list on the Team page. */
export interface TeamMember {
  id: number;
  email: string;
  name: string;
  role: ConsoleRole;
  hasAuthenticator: boolean;
  /** `<created_at>-<role>`: a removed and re-used id or a changed role is a stale form. */
  revision: string;
}

/** An invite that is neither used nor revoked; it may be expired. */
export interface PendingInvite {
  id: number;
  email: string;
  role: ConsoleRole;
  /** The creator's name, or undefined when the creator was removed. */
  createdByName: string | undefined;
  expiresAt: number;
}

export interface TeamStore {
  /** Every user, Owner first, then by role and name. */
  members: () => TeamMember[];
  /** Every invite that is not used and not revoked, oldest first. */
  pendingInvites: () => PendingInvite[];
  /** The invite with this id when it is neither used nor revoked; it may be expired. */
  pendingInvite: (id: number) => PendingInvite | undefined;
  /** The live invite of this token digest whose creator still may make it. */
  liveInvite: (tokenDigest: string, now: number) => LiveInvite | undefined;
  /**
   * In one BEGIN IMMEDIATE transaction: the session guard, the actor's stored role, the target
   * rule, no account and no live invite for the email, then the invite and its People event.
   */
  createInvite: (actor: CredentialGuard, invite: NewInvite) => CreateInviteResult;
  /** In one BEGIN IMMEDIATE transaction: the session guard, the invite, the rule, then revoke. */
  revokeInvite: (actor: CredentialGuard, inviteId: number, now: number) => RevokeInviteResult;
  /**
   * In one BEGIN IMMEDIATE transaction: the invite is still live and its creator may still make
   * it, the email is free; then the user, `used_at` and the `invite.accept` event.
   */
  acceptInvite: (input: AcceptInput) => AcceptInviteResult;
}

interface MemberRow {
  id: number;
  email: string;
  name: string;
  role: string;
  created_at: number;
  has_authenticator: number;
}

interface InviteRow {
  id: number;
  email: string;
  role: string;
  creator: string | null;
  expires_at: number;
}

interface InviteFullRow {
  id: number;
  email: string;
  role: string;
  created_by: number | null;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
}

type PersonRow = { id: number; email: string; name: string; role: string };
type Actor = PeoplePerson & { role: ConsoleRole };

function actorOf(db: Database, guard: CredentialGuard): Actor | undefined {
  if (!isCredentialGuardHeld(db, guard)) return undefined;
  const row = db
    .query<PersonRow, [number]>("SELECT id, email, name, role FROM users WHERE id = ?")
    .get(guard.userId);
  if (row === null) return undefined;
  return { id: row.id, email: row.email, name: row.name, role: parseRole(row.role) };
}

function personOf(actor: Actor): PeoplePerson {
  return { id: actor.id, email: actor.email, name: actor.name };
}

function isLive(row: InviteFullRow, now: number): boolean {
  return row.used_at === null && row.revoked_at === null && now < row.expires_at;
}

/** Whether the creator of an invite still exists and still may make an invite of its role. */
function hasIssuerAuthority(db: Database, row: InviteFullRow): boolean {
  if (row.created_by === null) return false;
  const creator = db
    .query<{ role: string }, [number]>("SELECT role FROM users WHERE id = ?")
    .get(row.created_by);
  if (creator === null) return false;
  return targetDecision(parseRole(creator.role), "invite", parseRole(row.role)).isAllowed;
}

function inviteMutations(db: Database) {
  const inviteSql =
    "SELECT id, email, role, created_by, expires_at, used_at, revoked_at FROM invites";
  const byDigest = db.query<InviteFullRow, [string]>(`${inviteSql} WHERE token_digest = ?`);
  const byId = db.query<InviteFullRow, [number]>(`${inviteSql} WHERE id = ?`);
  const userByEmail = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?");
  const liveByEmail = db.query<{ id: number }, [string, number]>(
    "SELECT id FROM invites WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
  );
  const create = db.transaction((actor: CredentialGuard, invite: NewInvite): CreateInviteResult => {
    const person = actorOf(db, actor);
    if (person === undefined) return { ok: false, reason: "session-gone" };
    const decision = targetDecision(person.role, "invite", invite.role);
    if (!decision.isAllowed) return { ok: false, reason: "forbidden", denial: decision };
    if (userByEmail.get(invite.email) !== null) return { ok: false, reason: "account-exists" };
    if (liveByEmail.get(invite.email, invite.now) !== null) {
      return { ok: false, reason: "invite-pending" };
    }
    const expiresAt = invite.now + INVITE_TTL_MS;
    const row = db
      .query<{ id: number }, [string, string, string, number, number, number]>(
        "INSERT INTO invites (token_digest, email, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .get(invite.tokenDigest, invite.email, invite.role, person.id, invite.now, expiresAt);
    if (row === null) throw new InviteInsertError("invite insert returned no id");
    appendPeopleEvent(db, {
      at: invite.now,
      actor: { kind: "user", person: personOf(person) },
      action: "invite.create",
      target: { kind: "invite", id: row.id, email: invite.email },
      toRole: invite.role,
    });
    return { ok: true, id: row.id, expiresAt };
  });
  const revoke = db.transaction(
    (actor: CredentialGuard, inviteId: number, now: number): RevokeInviteResult => {
      const person = actorOf(db, actor);
      if (person === undefined) return { ok: false, reason: "session-gone" };
      const row = byId.get(inviteId);
      if (row === null || row.used_at !== null || row.revoked_at !== null) {
        return { ok: false, reason: "not-found" };
      }
      const role = parseRole(row.role);
      const decision = targetDecision(person.role, "invite", role);
      if (!decision.isAllowed) return { ok: false, reason: "forbidden", denial: decision };
      db.query("UPDATE invites SET revoked_at = ? WHERE id = ?").run(now, row.id);
      appendPeopleEvent(db, {
        at: now,
        actor: { kind: "user", person: personOf(person) },
        action: "invite.revoke",
        target: { kind: "invite", id: row.id, email: row.email },
        toRole: role,
      });
      return { ok: true, id: row.id };
    },
  );
  const accept = db.transaction((input: AcceptInput): AcceptInviteResult => {
    const row = byDigest.get(input.tokenDigest);
    if (row === null || !isLive(row, input.now) || !hasIssuerAuthority(db, row)) {
      return { ok: false, reason: "invalid" };
    }
    if (userByEmail.get(row.email) !== null) return { ok: false, reason: "account-exists" };
    const role = parseRole(row.role);
    const user = db
      .query<{ id: number }, [string, string, string, string, number]>(
        "INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
      )
      .get(row.email, input.name, input.passwordHash, role, input.now);
    if (user === null) throw new InviteInsertError("user insert returned no id");
    db.query("UPDATE invites SET used_at = ?, accepted_user_id = ? WHERE id = ?").run(
      input.now,
      user.id,
      row.id,
    );
    const person = { id: user.id, email: row.email, name: input.name };
    appendPeopleEvent(db, {
      at: input.now,
      actor: { kind: "user", person },
      action: "invite.accept",
      target: { kind: "user", person },
      toRole: role,
    });
    return { ok: true, userId: user.id, role };
  });
  return {
    pendingInvite: (id: number): InviteFullRow | undefined => {
      const row = byId.get(id);
      return row === null || row.used_at !== null || row.revoked_at !== null ? undefined : row;
    },
    liveInvite: (tokenDigest: string, now: number): LiveInvite | undefined => {
      const row = byDigest.get(tokenDigest);
      if (row === null || !isLive(row, now) || !hasIssuerAuthority(db, row)) return undefined;
      return { id: row.id, email: row.email, role: parseRole(row.role), expiresAt: row.expires_at };
    },
    createInvite: (actor: CredentialGuard, invite: NewInvite) => create.immediate(actor, invite),
    revokeInvite: (actor: CredentialGuard, inviteId: number, now: number) =>
      revoke.immediate(actor, inviteId, now),
    acceptInvite: (input: AcceptInput) => accept.immediate(input),
  };
}

/** An INSERT … RETURNING gave no row. */
export class InviteInsertError extends Error {
  override name = "InviteInsertError";
}

/** The team store over an open console database. */
export function createTeamStore(db: Database): TeamStore {
  const invites = inviteMutations(db);
  const selectMembers = db.query<MemberRow, []>(
    `SELECT u.id, u.email, u.name, u.role, u.created_at,
       EXISTS (SELECT 1 FROM authenticators a WHERE a.user_id = u.id) AS has_authenticator
     FROM users u
     ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
       u.name, u.id`,
  );
  const selectInvites = db.query<InviteRow, []>(
    `SELECT i.id, i.email, i.role, u.name AS creator, i.expires_at
     FROM invites i LEFT JOIN users u ON u.id = i.created_by
     WHERE i.used_at IS NULL AND i.revoked_at IS NULL
     ORDER BY i.id`,
  );
  return {
    members: () =>
      selectMembers.all().map((row) => {
        const role = parseRole(row.role);
        return {
          id: row.id,
          email: row.email,
          name: row.name,
          role,
          hasAuthenticator: row.has_authenticator === 1,
          revision: `${row.created_at}-${role}`,
        };
      }),
    pendingInvites: () =>
      selectInvites.all().map((row) => ({
        id: row.id,
        email: row.email,
        role: parseRole(row.role),
        createdByName: row.creator ?? undefined,
        expiresAt: row.expires_at,
      })),
    pendingInvite: (id) => {
      const row = invites.pendingInvite(id);
      if (row === undefined) return undefined;
      const creator =
        row.created_by === null
          ? null
          : db
              .query<{ name: string }, [number]>("SELECT name FROM users WHERE id = ?")
              .get(row.created_by);
      return {
        id: row.id,
        email: row.email,
        role: parseRole(row.role),
        createdByName: creator?.name ?? undefined,
        expiresAt: row.expires_at,
      };
    },
    liveInvite: invites.liveInvite,
    createInvite: invites.createInvite,
    revokeInvite: invites.revokeInvite,
    acceptInvite: invites.acceptInvite,
  };
}
