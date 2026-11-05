// A signed-in console with one user per role, each with a full session. The Admin has a fixture
// authenticator, as the Owner of test/signed-in-console.ts has. Roles are stored, never `roleOf`.

import type { Database } from "bun:sqlite";
import { sessionDigest } from "../src/account-store.ts";
import type { ConsoleRole } from "../src/roles.ts";
import {
  SESSION_ID,
  type SignedInConsole,
  type SignedInOptions,
  START,
  startSignedInConsole,
} from "./signed-in-console.ts";

export type TeamConsole = SignedInConsole & {
  /** The open console database, for row checks; it closes with the console. */
  db: Database;
  /** The session cookie header of each role. */
  cookies: Readonly<Record<ConsoleRole, string>>;
  /** The session CSRF token of each role. */
  csrfs: Readonly<Record<ConsoleRole, string>>;
  /** The user id of each role. */
  ids: Readonly<Record<ConsoleRole, number>>;
};

const PEOPLE = [
  { role: "admin", email: "admin@example.com", name: "Ada Admin", hasAuthenticator: true },
  { role: "member", email: "member@example.com", name: "Mo Member", hasAuthenticator: false },
  { role: "viewer", email: "viewer@example.com", name: "Vi Viewer", hasAuthenticator: false },
] as const;

/** The session id of the seeded session of `role` (not the Owner's). */
export function sessionIdOf(role: ConsoleRole): string {
  return `${role}-session-id-for-tests-0123456789abcdefghij`.slice(0, 43);
}

function seed(db: Database, ids: Record<ConsoleRole, number>, isRequiredForAll: boolean): void {
  ids.owner =
    db.query<{ id: number }, []>("SELECT id FROM users WHERE role = 'owner'").get()?.id ?? 0;
  for (const p of PEOPLE) {
    const row = db
      .query<{ id: number }, [string, string, string, number]>(
        "INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, 'fixture-hash', ?, ?) RETURNING id",
      )
      .get(p.email, p.name, p.role, START);
    if (row === null) throw new Error("user insert returned no id");
    ids[p.role] = row.id;
    if (p.hasAuthenticator) {
      db.query(
        "INSERT INTO authenticators (user_id, secret, last_step, confirmed_at) VALUES (?, 'fixture-secret', -1, ?)",
      ).run(row.id, START);
    }
    db.query(
      "INSERT INTO sessions (id_digest, user_id, csrf_token, created_at, last_seen_at, stage) VALUES (?, ?, ?, ?, ?, 'full')",
    ).run(sessionDigest(sessionIdOf(p.role)), row.id, `${p.role}-csrf`, START, START);
  }
  if (isRequiredForAll) db.run("UPDATE instance SET require_2fa_all = 1");
}

export async function startTeamConsole(
  options: Omit<SignedInOptions, "prepare" | "roleOf"> & {
    isRequiredForAll?: boolean;
    /** More rows after the people are seeded. */
    extra?: (db: Database, ids: Readonly<Record<ConsoleRole, number>>) => void;
  },
): Promise<TeamConsole> {
  const ids: Record<ConsoleRole, number> = { owner: 0, admin: 0, member: 0, viewer: 0 };
  let opened: Database | undefined;
  const c = await startSignedInConsole({
    ...options,
    prepare: (db) => {
      opened = db;
      seed(db, ids, options.isRequiredForAll === true);
      options.extra?.(db, ids);
    },
  });
  if (opened === undefined) throw new Error("prepare did not run");
  return {
    ...c,
    db: opened,
    ids,
    cookies: {
      owner: `pulse_console_session=${SESSION_ID}`,
      admin: `pulse_console_session=${sessionIdOf("admin")}`,
      member: `pulse_console_session=${sessionIdOf("member")}`,
      viewer: `pulse_console_session=${sessionIdOf("viewer")}`,
    },
    csrfs: {
      owner: "session-csrf-for-tests-0123456789abcdefghij",
      admin: "admin-csrf",
      member: "member-csrf",
      viewer: "viewer-csrf",
    },
  };
}
