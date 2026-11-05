import { type ConsoleRole, hasRole } from "./roles.ts";

/** The 27 rows of the owner-confirmed permission matrix of #564, in row order. */
export const MATRIX_ACTIONS = [
  "overview.view",
  "check.write",
  "check.delete",
  "incident.write",
  "incident.delete",
  "incident.edit-text",
  "maintenance.create",
  "maintenance.edit",
  "maintenance.delete",
  "settings.edit",
  "token.write",
  "probe.write",
  "activity.view",
  "invite.member",
  "invite.admin",
  "remove.member",
  "remove.admin",
  "role.member-viewer",
  "role.admin",
  "reset-link.member",
  "reset-link.admin",
  "reset-link.owner",
  "2fa-reset.member",
  "2fa-reset.admin",
  "owner.transfer",
  "org.delete",
  "account.self",
] as const;

export type MatrixAction = (typeof MATRIX_ACTIONS)[number];
/** A matrix row, or one of the two console actions that name where a row's rule applies. */
export type Action = MatrixAction | "team.view" | "team.require-2fa";

// The lowest allowed role of each action; null where no role is allowed (rows 6, 22, 26).
// Every row with an allowed role is monotonic in viewer < member < admin < owner.
const MINIMUM: Readonly<Record<Action, ConsoleRole | null>> = {
  "overview.view": "viewer",
  "check.write": "member",
  "check.delete": "admin",
  "incident.write": "member",
  "incident.delete": "admin",
  "incident.edit-text": null,
  "maintenance.create": "member",
  "maintenance.edit": "member",
  "maintenance.delete": "admin",
  "settings.edit": "owner",
  "token.write": "admin",
  "probe.write": "admin",
  "activity.view": "admin",
  "invite.member": "admin",
  "invite.admin": "owner",
  "remove.member": "admin",
  "remove.admin": "owner",
  "role.member-viewer": "owner",
  "role.admin": "owner",
  "reset-link.member": "admin",
  "reset-link.admin": "owner",
  "reset-link.owner": null,
  "2fa-reset.member": "admin",
  "2fa-reset.admin": "owner",
  "owner.transfer": "owner",
  "org.delete": null,
  "account.self": "viewer",
  "team.view": "admin",
  "team.require-2fa": "owner",
};

/** The lowest role allowed to do `action`, or undefined when no role may do it. */
export function minimumRole(action: Action): ConsoleRole | undefined {
  return MINIMUM[action] ?? undefined;
}

/** Whether `role` may do `action`. */
export function isAllowed(role: ConsoleRole, action: Action): boolean {
  const needed = minimumRole(action);
  return needed !== undefined && hasRole(role, needed);
}

/** A production route names an action without an allowed role. */
export class NoMinimumRoleError extends Error {
  override name = "NoMinimumRoleError";
}

/** The `requiredRole` of a production route; an action that no role may do throws. */
export function routeRole(action: Action): ConsoleRole {
  const needed = minimumRole(action);
  if (needed === undefined) throw new NoMinimumRoleError(`no role may do ${action}`);
  return needed;
}

/** A team action on one person or invite. */
export type TeamActionKind =
  | "invite"
  | "remove"
  | "role-change"
  | "reset-link"
  | "2fa-reset"
  | "transfer";

export type TargetDecision =
  | { isAllowed: true }
  | { isAllowed: false; reason: "role"; requiredRole: ConsoleRole }
  | { isAllowed: false; reason: "owner-target" }
  | { isAllowed: false; reason: "transfer-not-admin" };

function rowOf(kind: TeamActionKind, target: ConsoleRole, toRole: ConsoleRole | undefined): Action {
  const isAdmin = target === "admin";
  switch (kind) {
    case "invite":
      return isAdmin ? "invite.admin" : "invite.member";
    case "remove":
      return isAdmin ? "remove.admin" : "remove.member";
    case "role-change":
      return isAdmin || toRole === "admin" ? "role.admin" : "role.member-viewer";
    case "reset-link":
      return isAdmin ? "reset-link.admin" : "reset-link.member";
    case "2fa-reset":
      return isAdmin ? "2fa-reset.admin" : "2fa-reset.member";
    case "transfer":
      return "owner.transfer";
    default: {
      const unknown: never = kind;
      return unknown;
    }
  }
}

/**
 * The target rule: the Owner is never a target, invites and role changes never name `owner`, and
 * a transfer goes only to an Admin. Otherwise the target's matrix row decides.
 */
export function targetDecision(
  actor: ConsoleRole,
  kind: TeamActionKind,
  target: ConsoleRole,
  toRole?: ConsoleRole,
): TargetDecision {
  if (target === "owner" || toRole === "owner") return { isAllowed: false, reason: "owner-target" };
  const row = rowOf(kind, target, toRole);
  const needed = routeRole(row);
  if (!hasRole(actor, needed)) return { isAllowed: false, reason: "role", requiredRole: needed };
  if (kind === "transfer" && target !== "admin") {
    return { isAllowed: false, reason: "transfer-not-admin" };
  }
  return { isAllowed: true };
}
