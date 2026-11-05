import type { Database } from "bun:sqlite";
import { type CredentialGuard, isCredentialGuardHeld } from "./factor-store.ts";
import { appendPeopleEvent, type PeoplePerson } from "./people-log.ts";
import {
  type Action,
  routeRole,
  type TargetDecision,
  type TeamActionKind,
  targetDecision,
} from "./permissions.ts";
import { type ConsoleRole, hasRole, parseRole } from "./roles.ts";

/** A password reset link lives this long after it was made. */
export const RESET_LINK_TTL_MS = 86_400_000;

/** The two kinds of password reset link. */
export type ResetLinkKind = "team" | "owner-recovery";

/** A valid reset link: unused, not expired, its target and issuer still match. */
export interface LiveResetLink {
  id: number;
  kind: ResetLinkKind;
  userId: number;
  email: string;
}

export type IssueResetLinkResult =
  | { ok: true; target: PeoplePerson; expiresAt: number }
  | TargetRefusal;

export type RedeemInput = { tokenDigest: string; passwordHash: string; now: number };

export type RedeemResult = { ok: true; userId: number; kind: ResetLinkKind } | { ok: false };

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

/** The person a team change names, as the form showed it. */
export type TargetInput = { userId: number; revision: string; now: number };

/** A refusal of a guarded change of one person, in the order the commit checks them. */
export type TargetRefusal =
  | { ok: false; reason: "session-gone" | "not-found" | "stale" | "no-authenticator" }
  | { ok: false; reason: "forbidden"; denial: TargetDenial };

export type TargetChangeResult = { ok: true; target: PeoplePerson } | TargetRefusal;

export type SwitchResult = { ok: true } | TargetRefusal;

export interface TeamStore {
  /** Whether the actor's session (and password, when given) still holds; the commit rechecks it. */
  isGuardHeld: (guard: CredentialGuard) => boolean;
  /** One person of the People list, or undefined. */
  member: (id: number) => TeamMember | undefined;
  /**
   * Each change of one person runs in one BEGIN IMMEDIATE transaction: the session guard, the
   * actor's stored role, the target, its revision, the target rule, then the change, the end of
   * the changed people's sessions and its People event.
   */
  changeRole: (
    actor: CredentialGuard,
    input: TargetInput & { toRole: InviteRole },
  ) => TargetChangeResult;
  /** Removes the user; sessions, factors and reset links cascade, their invites stop working. */
  removeUser: (actor: CredentialGuard, input: TargetInput) => TargetChangeResult;
  /** Deletes the target's authenticators, recovery codes, pending setup keys and sessions. */
  resetTwoFactor: (actor: CredentialGuard, input: TargetInput) => TargetChangeResult;
  /** The actor becomes Admin, the enrolled Admin target the Owner; both lose every session. */
  transferOwnership: (actor: CredentialGuard, input: TargetInput) => TargetChangeResult;
  /** The Owner turns the organisation-wide 2FA requirement on or off; no session ends. */
  setTwoFactorRequiredForAll: (
    actor: CredentialGuard,
    input: { isOn: boolean; now: number },
  ) => SwitchResult;

  /**
   * In one BEGIN IMMEDIATE transaction: the checks of a team change, then the target's unused
   * team links are replaced by one new link and `user.reset-link` is written. No session ends.
   */
  issueResetLink: (
    actor: CredentialGuard,
    input: TargetInput & { tokenDigest: string },
  ) => IssueResetLinkResult;
  /** The valid reset link of this token digest, or undefined. */
  liveResetLink: (tokenDigest: string, now: number) => LiveResetLink | undefined;
  /**
   * In one BEGIN IMMEDIATE transaction: the link is still valid; then the new password hash,
   * `used_at`, the end of the user's other unused links and sessions and the event. An
   * owner-recovery link also deletes the Owner's second factors.
   */
  redeemResetLink: (input: RedeemInput) => RedeemResult;

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

type TargetRow = PersonRow & { created_at: number; has_authenticator: number };

const TARGET_SQL = `SELECT u.id, u.email, u.name, u.role, u.created_at,
  EXISTS (SELECT 1 FROM authenticators a WHERE a.user_id = u.id) AS has_authenticator
  FROM users u WHERE u.id = ?`;

function revisionOf(row: { created_at: number; role: string }): string {
  return `${row.created_at}-${row.role}`;
}

type Admitted = { actor: Actor; target: PeoplePerson & { role: ConsoleRole } };

/** The commit checks of section 3: session, actor role, target, revision, rule. */
function admit(
  db: Database,
  guard: CredentialGuard,
  check: { action: Action; kind: TeamActionKind; toRole?: ConsoleRole },
  input: TargetInput,
): Admitted | TargetRefusal {
  const actor = actorOf(db, guard);
  if (actor === undefined) return { ok: false, reason: "session-gone" };
  const coarse = coarseDenial(actor.role, check.action);
  if (coarse !== undefined) return coarse;
  const row = db.query<TargetRow, [number]>(TARGET_SQL).get(input.userId);
  if (row === null) return { ok: false, reason: "not-found" };
  if (revisionOf(row) !== input.revision) return { ok: false, reason: "stale" };
  const role = parseRole(row.role);
  const decision = targetDecision(actor.role, check.kind, role, check.toRole);
  if (!decision.isAllowed) return { ok: false, reason: "forbidden", denial: decision };
  if (check.kind === "transfer" && row.has_authenticator !== 1) {
    return { ok: false, reason: "no-authenticator" };
  }
  return { actor, target: { id: row.id, email: row.email, name: row.name, role } };
}

/** The actor's re-read role against the route's coarse action (its lowest allowed role). */
function coarseDenial(role: ConsoleRole, action: Action): TargetRefusal | undefined {
  const needed = routeRole(action);
  if (hasRole(role, needed)) return undefined;
  return {
    ok: false,
    reason: "forbidden",
    denial: { isAllowed: false, reason: "role", requiredRole: needed },
  };
}

function targetPerson(target: Admitted["target"]): PeoplePerson {
  return { id: target.id, email: target.email, name: target.name };
}

function memberMutations(db: Database) {
  const endSessions = db.query("DELETE FROM sessions WHERE user_id = ?");
  const setRole = db.query("UPDATE users SET role = ? WHERE id = ?");
  const changeRole = db.transaction(
    (guard: CredentialGuard, input: TargetInput & { toRole: InviteRole }): TargetChangeResult => {
      const toRole = input.toRole;
      const admitted = admit(
        db,
        guard,
        { action: "role.member-viewer", kind: "role-change", toRole },
        input,
      );
      if (!("actor" in admitted)) return admitted;
      const { actor, target } = admitted;
      setRole.run(toRole, target.id);
      endSessions.run(target.id);
      appendPeopleEvent(db, {
        at: input.now,
        actor: { kind: "user", person: personOf(actor) },
        action: "user.role-change",
        target: { kind: "user", person: targetPerson(target) },
        fromRole: target.role,
        toRole,
      });
      return { ok: true, target: targetPerson(target) };
    },
  );
  const removeUser = db.transaction(
    (guard: CredentialGuard, input: TargetInput): TargetChangeResult => {
      const admitted = admit(db, guard, { action: "remove.member", kind: "remove" }, input);
      if (!("actor" in admitted)) return admitted;
      const { actor, target } = admitted;
      appendPeopleEvent(db, {
        at: input.now,
        actor: { kind: "user", person: personOf(actor) },
        action: "user.remove",
        target: { kind: "user", person: targetPerson(target) },
        fromRole: target.role,
      });
      db.query("DELETE FROM users WHERE id = ?").run(target.id);
      return { ok: true, target: targetPerson(target) };
    },
  );
  const resetTwoFactor = db.transaction(
    (guard: CredentialGuard, input: TargetInput): TargetChangeResult => {
      const admitted = admit(db, guard, { action: "2fa-reset.member", kind: "2fa-reset" }, input);
      if (!("actor" in admitted)) return admitted;
      const { actor, target } = admitted;
      for (const table of ["authenticators", "recovery_codes", "pending_authenticators"]) {
        db.query(`DELETE FROM ${table} WHERE user_id = ?`).run(target.id);
      }
      endSessions.run(target.id);
      appendPeopleEvent(db, {
        at: input.now,
        actor: { kind: "user", person: personOf(actor) },
        action: "user.2fa-reset",
        target: { kind: "user", person: targetPerson(target) },
      });
      return { ok: true, target: targetPerson(target) };
    },
  );
  const transfer = db.transaction(
    (guard: CredentialGuard, input: TargetInput): TargetChangeResult => {
      const admitted = admit(db, guard, { action: "owner.transfer", kind: "transfer" }, input);
      if (!("actor" in admitted)) return admitted;
      const { actor, target } = admitted;
      // The former Owner first: the unique index users_one_owner allows one owner at a time.
      setRole.run("admin", actor.id);
      setRole.run("owner", target.id);
      endSessions.run(actor.id);
      endSessions.run(target.id);
      appendPeopleEvent(db, {
        at: input.now,
        actor: { kind: "user", person: personOf(actor) },
        action: "owner.transfer",
        target: { kind: "user", person: targetPerson(target) },
        fromRole: "admin",
        toRole: "owner",
      });
      return { ok: true, target: targetPerson(target) };
    },
  );
  const setSwitch = db.transaction(
    (guard: CredentialGuard, input: { isOn: boolean; now: number }): SwitchResult => {
      const actor = actorOf(db, guard);
      if (actor === undefined) return { ok: false, reason: "session-gone" };
      const denied = coarseDenial(actor.role, "team.require-2fa");
      if (denied !== undefined) return denied;
      db.query("UPDATE instance SET require_2fa_all = ?").run(input.isOn ? 1 : 0);
      appendPeopleEvent(db, {
        at: input.now,
        actor: { kind: "user", person: personOf(actor) },
        action: "team.require-2fa",
        target: { kind: "instance" },
        value: input.isOn ? "on" : "off",
      });
      return { ok: true };
    },
  );
  return {
    changeRole: (guard: CredentialGuard, input: TargetInput & { toRole: InviteRole }) =>
      changeRole.immediate(guard, input),
    removeUser: (guard: CredentialGuard, input: TargetInput) => removeUser.immediate(guard, input),
    resetTwoFactor: (guard: CredentialGuard, input: TargetInput) =>
      resetTwoFactor.immediate(guard, input),
    transferOwnership: (guard: CredentialGuard, input: TargetInput) =>
      transfer.immediate(guard, input),
    setTwoFactorRequiredForAll: (guard: CredentialGuard, input: { isOn: boolean; now: number }) =>
      setSwitch.immediate(guard, input),
  };
}

interface ResetRow {
  id: number;
  kind: string;
  user_id: number;
  target_role: string;
  issued_by: number | null;
  expires_at: number;
  used_at: number | null;
  email: string;
  name: string;
  role: string;
  issuer_role: string | null;
}

const RESET_SQL = `SELECT r.id, r.kind, r.user_id, r.target_role, r.issued_by, r.expires_at, r.used_at,
  u.email, u.name, u.role, i.role AS issuer_role
  FROM reset_links r JOIN users u ON u.id = r.user_id LEFT JOIN users i ON i.id = r.issued_by
  WHERE r.token_digest = ?`;

/** Section 11: unused, not expired, the target's role unchanged, the issuer still allowed. */
function isResetValid(row: ResetRow, now: number): boolean {
  if (row.used_at !== null || now >= row.expires_at || row.role !== row.target_role) return false;
  if (row.kind === "owner-recovery") return row.role === "owner";
  if (row.kind !== "team" || row.issuer_role === null) return false;
  return targetDecision(parseRole(row.issuer_role), "reset-link", parseRole(row.role)).isAllowed;
}

function resetLinkMutations(db: Database) {
  const byDigest = db.query<ResetRow, [string]>(RESET_SQL);
  const validRow = (digest: string, now: number): ResetRow | undefined => {
    const row = byDigest.get(digest);
    return row !== null && isResetValid(row, now) ? row : undefined;
  };
  const issue = db.transaction(
    (guard: CredentialGuard, input: TargetInput & { tokenDigest: string }) => {
      const admitted = admit(db, guard, { action: "reset-link.member", kind: "reset-link" }, input);
      if (!("actor" in admitted)) return admitted;
      const { actor, target } = admitted;
      db.query(
        "DELETE FROM reset_links WHERE user_id = ? AND kind = 'team' AND used_at IS NULL",
      ).run(target.id);
      const expiresAt = input.now + RESET_LINK_TTL_MS;
      db.query(
        "INSERT INTO reset_links (token_digest, kind, user_id, target_role, issued_by, created_at, expires_at) VALUES (?, 'team', ?, ?, ?, ?, ?)",
      ).run(input.tokenDigest, target.id, target.role, actor.id, input.now, expiresAt);
      appendPeopleEvent(db, {
        at: input.now,
        actor: { kind: "user", person: personOf(actor) },
        action: "user.reset-link",
        target: { kind: "user", person: targetPerson(target) },
      });
      return { ok: true, target: targetPerson(target), expiresAt } as const;
    },
  );
  const redeem = db.transaction((input: RedeemInput): RedeemResult => {
    const row = validRow(input.tokenDigest, input.now);
    if (row === undefined) return { ok: false };
    const kind: ResetLinkKind = row.kind === "owner-recovery" ? "owner-recovery" : "team";
    db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(
      input.passwordHash,
      row.user_id,
    );
    db.query("UPDATE reset_links SET used_at = ? WHERE id = ?").run(input.now, row.id);
    db.query("DELETE FROM reset_links WHERE user_id = ? AND used_at IS NULL").run(row.user_id);
    db.query("DELETE FROM sessions WHERE user_id = ?").run(row.user_id);
    if (kind === "owner-recovery") {
      for (const table of ["authenticators", "recovery_codes", "pending_authenticators"]) {
        db.query(`DELETE FROM ${table} WHERE user_id = ?`).run(row.user_id);
      }
    }
    const person = { id: row.user_id, email: row.email, name: row.name };
    appendPeopleEvent(db, {
      at: input.now,
      actor: kind === "team" ? { kind: "user", person } : { kind: "container" },
      action: kind === "team" ? "user.password-reset" : "owner.recover",
      target: { kind: "user", person },
      value: kind,
    });
    return { ok: true, userId: row.user_id, kind };
  });
  return {
    issueResetLink: (guard: CredentialGuard, input: TargetInput & { tokenDigest: string }) =>
      issue.immediate(guard, input),
    liveResetLink: (tokenDigest: string, now: number): LiveResetLink | undefined => {
      const row = validRow(tokenDigest, now);
      if (row === undefined) return undefined;
      const kind: ResetLinkKind = row.kind === "owner-recovery" ? "owner-recovery" : "team";
      return { id: row.id, kind, userId: row.user_id, email: row.email };
    },
    redeemResetLink: (input: RedeemInput) => redeem.immediate(input),
  };
}

/** An INSERT … RETURNING gave no row. */
export class InviteInsertError extends Error {
  override name = "InviteInsertError";
}

function toMember(row: MemberRow): TeamMember {
  const role = parseRole(row.role);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role,
    hasAuthenticator: row.has_authenticator === 1,
    revision: `${row.created_at}-${role}`,
  };
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
  const selectMember = db.query<TargetRow, [number]>(TARGET_SQL);
  return {
    ...memberMutations(db),
    ...resetLinkMutations(db),
    isGuardHeld: (guard) => isCredentialGuardHeld(db, guard),
    members: () => selectMembers.all().map(toMember),
    member: (id) => {
      const row = selectMember.get(id);
      return row === null ? undefined : toMember(row);
    },
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
