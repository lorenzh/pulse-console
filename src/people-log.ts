import type { Database } from "bun:sqlite";
import type { ConsoleRole } from "./roles.ts";

/** The People-log actions; the column has no CHECK, so later items add values here. */
export type PeopleAction =
  | "invite.create"
  | "invite.revoke"
  | "invite.accept"
  | "user.role-change"
  | "user.remove"
  | "user.reset-link"
  | "user.password-reset"
  | "user.password-change"
  | "user.2fa-reset"
  | "owner.transfer"
  | "owner.recovery-link"
  | "owner.recover"
  | "team.require-2fa"
  | "check.create"
  | "check.replace"
  | "check.delete"
  | "token.create"
  | "token.rotate"
  | "token.revoke"
  | "manual-incident.create"
  | "manual-incident.update"
  | "manual-incident.resolve"
  | "manual-incident.delete"
  | "maintenance.create"
  | "maintenance.replace"
  | "maintenance.delete"
  | "status-settings.replace"
  | "notify-channel.create"
  | "notify-channel.replace"
  | "notify-channel.delete"
  | "notify-resend.create";

/** Email and name as they were at the time of the change. */
export type PeoplePerson = { id: number; email: string; name: string };

export type PeopleEvent = {
  at: number;
  /** A person, or the owner recovery command in the container. */
  actor: { kind: "user"; person: PeoplePerson } | { kind: "container" };
  action: PeopleAction;
  target:
    | { kind: "user"; person: PeoplePerson }
    | { kind: "invite"; id: number; email: string }
    | { kind: "instance" }
    /** A pulse-api check: `target_name` is the check id, `target_id` stays NULL. */
    | { kind: "check"; id: string }
    /** A pulse-api token: `target_name` is its id, or `unknown` when the answer had none. */
    | { kind: "token"; id: string | undefined }
    /** A public manual incident: `target_name` is its id, or `unknown` when the answer had none. */
    | { kind: "incident"; id: number | undefined }
    /** A database maintenance window: `target_name` is its id. */
    | { kind: "maintenance"; id: string }
    /** The status page settings of pulse-api: one document, no id. */
    | { kind: "status-settings" }
    /** A database notify channel: `target_name` is the channel id. */
    | { kind: "notify-channel"; id: string }
    /** A resend: `target_name` is the channel id of the failed delivery. */
    | { kind: "notify-resend"; channelId: string };
  fromRole?: ConsoleRole | undefined;
  toRole?: ConsoleRole | undefined;
  value?: string | undefined;
};

/** A People-log row could not be written; the change it records rolls back with it. */
export class PeopleLogError extends Error {
  override name = "PeopleLogError";
}

type Row = [
  number,
  string,
  number | null,
  string | null,
  string | null,
  string,
  string,
  number | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
];

const INSERT_SQL =
  "INSERT INTO people_events (at, actor_kind, actor_user_id, actor_email, actor_name, action, target_kind, target_id, target_email, target_name, from_role, to_role, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

function targetColumns(
  target: PeopleEvent["target"],
): [string, number | null, string | null, string | null] {
  switch (target.kind) {
    case "user":
      return ["user", target.person.id, target.person.email, target.person.name];
    case "invite":
      return ["invite", target.id, target.email, null];
    case "instance":
      return ["instance", null, null, null];
    case "check":
      return ["check", null, null, target.id];
    case "token":
      return ["token", null, null, target.id ?? "unknown"];
    case "incident":
      return ["incident", null, null, target.id === undefined ? "unknown" : String(target.id)];
    case "maintenance":
      return ["maintenance", null, null, target.id];
    case "status-settings":
      return ["status-settings", null, null, null];
    case "notify-channel":
      return ["notify-channel", null, null, target.id];
    case "notify-resend":
      return ["notify-resend", null, null, target.channelId];
    default: {
      const unknown: never = target;
      return unknown;
    }
  }
}

function rowOf(event: PeopleEvent): Row {
  const actor = event.actor.kind === "user" ? event.actor.person : undefined;
  return [
    event.at,
    event.actor.kind,
    actor?.id ?? null,
    actor?.email ?? null,
    actor?.name ?? null,
    event.action,
    ...targetColumns(event.target),
    event.fromRole ?? null,
    event.toRole ?? null,
    event.value ?? null,
  ];
}

/**
 * Appends one People-log row. Call it inside the transaction of the change it records: a failed
 * insert throws PeopleLogError, so the change rolls back with it.
 */
export function appendPeopleEvent(db: Database, event: PeopleEvent): void {
  try {
    db.query<unknown, Row>(INSERT_SQL).run(...rowOf(event));
  } catch (err) {
    throw new PeopleLogError("people event could not be saved", { cause: err });
  }
}
