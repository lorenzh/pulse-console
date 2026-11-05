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

/** A stored role value that is not one of the four roles. */
export class InvalidRoleError extends Error {
  override name = "InvalidRoleError";
}

/** Whether `value` is one of the four console roles. */
export function isConsoleRole(value: unknown): value is ConsoleRole {
  return typeof value === "string" && Object.hasOwn(RANK, value);
}

/** Narrows a stored role; an unknown value throws instead of becoming a role. */
export function parseRole(value: unknown): ConsoleRole {
  if (isConsoleRole(value)) return value;
  throw new InvalidRoleError("invalid role");
}

/** The display name of a role. */
export function roleLabel(role: ConsoleRole): string {
  return LABELS[role];
}
