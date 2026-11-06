import { ADMIN_MAX_BODY_BYTES, type RequestJsonResult, requestJson } from "@lorenzh/pulse-contract";
import type { Logger } from "@lorenzh/pulse-kit";
import type { AccountStore, User } from "./account-store.ts";
import type { FetchLike } from "./api-read.ts";
import { type CheckOutcome, checkOutcome } from "./check-outcome.ts";
import type { PeopleAction, PeopleEvent } from "./people-log.ts";
import type { PageRequest, PageResult } from "./protected-route.ts";
import { type ConsoleRole, hasRole } from "./roles.ts";
import { forbiddenState } from "./states.ts";
import { notSavedBody } from "./team-pages.ts";

const WRITE_TIMEOUT_MS = 5000;
const MAX_MESSAGE_LENGTH = 1000;

export const NO_REASON_TEXT = "pulse-api gave no reason.";
export const SAVED_NOT_LOGGED_TEXT = "Saved in pulse-api. The People log row could not be written.";
export const WRITE_SCOPE_TEXT =
  "The console token lacks the admin or checks scope. Saving checks needs both.";
export const GONE_TEXT = "This check no longer exists.";
export const THROTTLED_TEXT = "pulse-api is throttling the console. Try again in a minute.";
export const UNKNOWN_TEXT =
  "The result is unknown. Open the check to see whether the change was saved.";

/** Decision 9: whether a built JSON body fits pulse-api's 1 MiB admin body limit, in UTF-8 bytes. */
export function isWithinApiBodyLimit(body: string): boolean {
  return new TextEncoder().encode(body).length <= ADMIN_MAX_BODY_BYTES;
}

export type CheckWriteDeps = {
  store: Pick<AccountStore, "isGuardHeld" | "userById" | "appendPeople">;
  fetch: FetchLike;
  adminToken: string | undefined;
  schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
  roleOf?: ((user: User) => ConsoleRole) | undefined;
  now: () => number;
  log: Logger;
};

/** What the live guard reads: the session row and the stored role. */
export type WriteGuardDeps = {
  store: Pick<AccountStore, "isGuardHeld" | "userById">;
  roleOf?: ((user: User) => ConsoleRole) | undefined;
};

/**
 * R8: right before the write, the request's session row must still exist (`409` `Not saved`)
 * and the user's stored role, read again, must still meet `requiredRole` (`403`).
 */
export function writeGuardProblem(
  deps: WriteGuardDeps,
  request: PageRequest,
  requiredRole: ConsoleRole,
  reloadHref: string,
): PageResult | undefined {
  const guard = { sessionId: request.sessionId, userId: request.user.id };
  const user = deps.store.isGuardHeld(guard) ? deps.store.userById(request.user.id) : undefined;
  if (user === undefined) {
    return { kind: "page", status: 409, title: "Not saved", body: notSavedBody(reloadHref) };
  }
  const role = deps.roleOf?.(user) ?? user.role;
  if (!hasRole(role, requiredRole)) {
    return {
      kind: "page",
      status: 403,
      title: "Access denied",
      body: forbiddenState({ requiredRole, role }),
    };
  }
  return undefined;
}

/** The texts of one resource's write answers. */
export type WriteTexts = {
  /** The text of a `403` answer. */
  scope: string;
  /** The text of a `404` answer. */
  gone: string;
  /** The text of an unknown outcome without any answer. */
  unknown: string;
  /** What to open to see the result, in the redirect and foreign-answer texts. */
  unknownHint: string;
  /** The one text of every answered unknown outcome; the composed texts when undefined. */
  unknownAnswered?: string | undefined;
  /** True when a `400` re-renders the form, as `413` and `422` do. */
  isBadRequestForm?: boolean | undefined;
};

export const CHECK_WRITE_TEXTS: WriteTexts = {
  scope: WRITE_SCOPE_TEXT,
  gone: GONE_TEXT,
  unknown: UNKNOWN_TEXT,
  unknownHint: "open the check to see whether the change was saved.",
};

/** One outbound check write. `path` is built by the caller with `apiIdSegment`. */
export type CheckWrite = {
  action: PeopleAction & `check.${string}`;
  checkId: string;
  method: "POST" | "PUT" | "DELETE";
  url: string;
  /** The revision for `If-Match`, unquoted. */
  revision: string;
  body?: string | undefined;
};

/** One outbound write of any resource; never retried, never redirected. */
export type ApiWrite = {
  action: PeopleAction;
  /** The People-log target; `answer` is the body of a saved answer, else undefined. */
  targetOf: (answer: unknown) => PeopleEvent["target"];
  /** The message of the outcome log line, for example `incident change`. */
  logMessage: string;
  /** The ids of the outcome log line, for example `{ checkId }`; never a title or text. */
  logIds: Readonly<Record<string, string | number>>;
  method: "POST" | "PUT" | "DELETE";
  url: string;
  /** The revision for `If-Match`, unquoted; no header when undefined. */
  revision?: string | undefined;
  body?: string | undefined;
  /** The People-log value of a saved write: the new `ETag` revision, or none. */
  savedValue: "revision" | "none";
  texts: WriteTexts;
};

/**
 * What the route shows for an outcome. `form` re-renders the form with `message` in the summary;
 * `text` shows `message` with the kept non-secret input as text; `saved` redirects unless the
 * People-log row failed. `answer` is the body of a saved answer when it could be read.
 */
export type WriteAnswer =
  | { kind: "saved"; isLogged: boolean; answer?: unknown }
  | { kind: "form"; status: number; message: string }
  | {
      kind: "text";
      status: number;
      message: string;
      reason: "token-rejected" | "stale" | "gone" | "other";
    };

function messageOf(message: string | undefined): string {
  return message === undefined ? NO_REASON_TEXT : message.slice(0, MAX_MESSAGE_LENGTH);
}

/** The R8 answer of a refused write. */
export function refusedAnswer(
  status: number,
  message: string | undefined,
  texts: WriteTexts = CHECK_WRITE_TEXTS,
): WriteAnswer {
  if (status === 401) {
    return { kind: "text", status: 502, message: "", reason: "token-rejected" };
  }
  if (status === 403) return { kind: "text", status: 502, message: texts.scope, reason: "other" };
  if (status === 404) return { kind: "text", status: 404, message: texts.gone, reason: "gone" };
  if (status === 409) return { kind: "form", status: 409, message: messageOf(message) };
  if (status === 412) return { kind: "text", status: 412, message: "", reason: "stale" };
  if (status === 413 || status === 422 || (status === 400 && texts.isBadRequestForm === true)) {
    return { kind: "form", status: 422, message: messageOf(message) };
  }
  if (status === 429) return { kind: "form", status: 503, message: THROTTLED_TEXT };
  if (status < 500) {
    return {
      kind: "text",
      status: 502,
      message: `pulse-api refused the request (${status}): ${messageOf(message)} Nothing was changed.`,
      reason: "other",
    };
  }
  return {
    kind: "text",
    status: 502,
    message: `pulse-api could not save the change (${status}). Nothing was changed.`,
    reason: "other",
  };
}

/** The R8 answer of an unknown outcome. */
export function unknownAnswer(
  status: number | null,
  isRedirect: boolean,
  texts: WriteTexts = CHECK_WRITE_TEXTS,
): WriteAnswer {
  if (status === null) {
    return { kind: "text", status: 504, message: texts.unknown, reason: "other" };
  }
  if (texts.unknownAnswered !== undefined) {
    return { kind: "text", status: 502, message: texts.unknownAnswered, reason: "other" };
  }
  const message = isRedirect
    ? `pulse-api answered with a redirect (${status}); redirects are not followed. The result is unknown: ${texts.unknownHint} Check that PULSE_API_URL points at pulse-api itself.`
    : `The answer did not come from a matching pulse-api (${status}). The result is unknown: ${texts.unknownHint}`;
  return { kind: "text", status: 502, message, reason: "other" };
}

function send(deps: CheckWriteDeps, write: ApiWrite): Promise<RequestJsonResult<unknown>> {
  const headers: Record<string, string> = { authorization: `Bearer ${deps.adminToken ?? ""}` };
  if (write.revision !== undefined) headers["if-match"] = `"${write.revision}"`;
  return requestJson<unknown>(write.url, {
    method: write.method,
    fetch: deps.fetch,
    headers,
    // The caller validates a saved answer's body itself; other bodies are never used.
    validate: (raw) => ({ ok: true, value: raw }),
    timeoutMs: WRITE_TIMEOUT_MS,
    ...(write.body === undefined ? {} : { body: write.body }),
    ...(deps.schedule === undefined ? {} : { schedule: deps.schedule }),
  });
}

function logOutcome(
  deps: CheckWriteDeps,
  write: ApiWrite,
  actorId: number,
  outcome: CheckOutcome,
): void {
  const fields: Record<string, unknown> = {
    action: write.action,
    actorId,
    ...write.logIds,
    outcome: outcome.class,
  };
  if (outcome.class === "refused") fields.status = outcome.status;
  deps.log.info(write.logMessage, fields);
  if (outcome.class === "saved" && outcome.unreadable !== undefined) {
    deps.log.warn("api answer unreadable", { call: "write", kind: outcome.unreadable });
  }
}

/** Appends the People-log row of a saved or unknown write; false when the insert failed. */
function isLogged(
  deps: CheckWriteDeps,
  write: ApiWrite,
  user: User,
  answer: unknown,
  value: string | undefined,
): boolean {
  try {
    deps.store.appendPeople({
      at: deps.now(),
      actor: { kind: "user", person: { id: user.id, email: user.email, name: user.name } },
      action: write.action,
      target: write.targetOf(answer),
      value,
    });
    return true;
  } catch (err) {
    deps.log.error(`${write.logMessage} not logged`, {
      error: err instanceof Error ? err.name : "unknown",
    });
    return false;
  }
}

function savedValueOf(write: ApiWrite, revision: string | null): string | undefined {
  switch (write.savedValue) {
    case "revision":
      return revision ?? "unknown";
    case "none":
      return undefined;
    default: {
      const never: never = write.savedValue;
      return never;
    }
  }
}

/**
 * Sends one write (never retried, never redirected), maps its outcome (Decision 10, R8) and
 * appends one People-log row for a saved or unknown outcome.
 */
export async function sendApiWrite(
  deps: CheckWriteDeps,
  write: ApiWrite,
  user: User,
): Promise<WriteAnswer> {
  const result = await send(deps, write);
  const outcome = checkOutcome(result);
  logOutcome(deps, write, user.id, outcome);
  switch (outcome.class) {
    case "saved": {
      const answer = result.ok ? result.value : undefined;
      const value = savedValueOf(write, outcome.revision);
      return { kind: "saved", isLogged: isLogged(deps, write, user, answer, value), answer };
    }
    case "refused":
      return refusedAnswer(outcome.status, outcome.message, write.texts);
    case "unknown":
      // A failed row is logged as an error; the unknown answer already says to check.
      isLogged(deps, write, user, undefined, "unknown");
      return unknownAnswer(outcome.status, outcome.isRedirect, write.texts);
    default: {
      const never: never = outcome;
      return never;
    }
  }
}

/** Sends one check write with `If-Match` and the check texts. */
export function sendCheckWrite(
  deps: CheckWriteDeps,
  write: CheckWrite,
  user: User,
): Promise<WriteAnswer> {
  return sendApiWrite(
    deps,
    {
      action: write.action,
      targetOf: () => ({ kind: "check", id: write.checkId }),
      logMessage: "check change",
      logIds: { checkId: write.checkId },
      method: write.method,
      url: write.url,
      revision: write.revision,
      body: write.body,
      savedValue: "revision",
      texts: CHECK_WRITE_TEXTS,
    },
    user,
  );
}
