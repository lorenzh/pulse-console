import type { Database } from "bun:sqlite";
import { type ConsoleRole, parseRole } from "./roles.ts";

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

/** The team store over an open console database. */
export function createTeamStore(db: Database): TeamStore {
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
  };
}
