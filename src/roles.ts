export type ConsoleRole = "viewer" | "member" | "admin" | "owner";

const RANK: Readonly<Record<ConsoleRole, number>> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** True when `role` is at or above `needed` (viewer < member < admin < owner). */
export function hasRole(role: ConsoleRole, needed: ConsoleRole): boolean {
  return RANK[role] >= RANK[needed];
}

const LABELS: Readonly<Record<ConsoleRole, string>> = {
  viewer: "Viewer",
  member: "Member",
  admin: "Admin",
  owner: "Owner",
};

/** The display name of a role. */
export function roleLabel(role: ConsoleRole): string {
  return LABELS[role];
}
