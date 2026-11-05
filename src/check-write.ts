import { ADMIN_MAX_BODY_BYTES, type RequestJsonResult, requestJson } from "@lorenzh/pulse-contract";
import type { Logger } from "@lorenzh/pulse-kit";
import type { AccountStore, User } from "./account-store.ts";
import type { FetchLike } from "./api-read.ts";
import { type CheckOutcome, checkOutcome } from "./check-outcome.ts";
import type { PeopleAction } from "./people-log.ts";
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
  store: AccountStore;
  fetch: FetchLike;
  adminToken: string | undefined;
  schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
  roleOf?: ((user: User) => ConsoleRole) | undefined;
  now: () => number;
  log: Logger;
};

/**
 * R8: right before the write, the request's session row must still exist (`409` `Not saved`)
 * and the user's stored role, read again, must still meet `requiredRole` (`403`).
 */
export function writeGuardProblem(
  deps: CheckWriteDeps,
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

/**
 * What the route shows for an outcome. `form` re-renders the form with `message` in the summary;
 * `text` shows `message` with the kept non-secret input as text; `saved` redirects unless the
 * People-log row failed.
 */
export type WriteAnswer =
  | { kind: "saved"; isLogged: boolean }
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
export function refusedAnswer(status: number, message: string | undefined): WriteAnswer {
  if (status === 401) {
    return { kind: "text", status: 502, message: "", reason: "token-rejected" };
  }
  if (status === 403)
    return { kind: "text", status: 502, message: WRITE_SCOPE_TEXT, reason: "other" };
  if (status === 404) return { kind: "text", status: 404, message: GONE_TEXT, reason: "gone" };
  if (status === 409) return { kind: "form", status: 409, message: messageOf(message) };
  if (status === 412) return { kind: "text", status: 412, message: "", reason: "stale" };
  if (status === 413 || status === 422) {
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
export function unknownAnswer(status: number | null, isRedirect: boolean): WriteAnswer {
  if (status === null) return { kind: "text", status: 504, message: UNKNOWN_TEXT, reason: "other" };
  const message = isRedirect
    ? `pulse-api answered with a redirect (${status}); redirects are not followed. The result is unknown: open the check to see whether the change was saved. Check that PULSE_API_URL points at pulse-api itself.`
    : `The answer did not come from a matching pulse-api (${status}). The result is unknown: open the check to see whether the change was saved.`;
  return { kind: "text", status: 502, message, reason: "other" };
}

function send(deps: CheckWriteDeps, write: CheckWrite): Promise<RequestJsonResult<unknown>> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${deps.adminToken ?? ""}`,
    "if-match": `"${write.revision}"`,
  };
  return requestJson<unknown>(write.url, {
    method: write.method,
    fetch: deps.fetch,
    headers,
    // The body of a write answer is never used: the next page reads fresh data.
    validate: (raw) => ({ ok: true, value: raw }),
    timeoutMs: WRITE_TIMEOUT_MS,
    ...(write.body === undefined ? {} : { body: write.body }),
    ...(deps.schedule === undefined ? {} : { schedule: deps.schedule }),
  });
}

function logOutcome(
  deps: CheckWriteDeps,
  write: CheckWrite,
  actorId: number,
  outcome: CheckOutcome,
): void {
  const fields: Record<string, unknown> = {
    action: write.action,
    actorId,
    checkId: write.checkId,
    outcome: outcome.class,
  };
  if (outcome.class === "refused") fields.status = outcome.status;
  deps.log.info("check change", fields);
  if (outcome.class === "saved" && outcome.unreadable !== undefined) {
    deps.log.warn("api answer unreadable", { call: "write", kind: outcome.unreadable });
  }
}

/** Appends the People-log row of a saved or unknown write; false when the insert failed. */
function isLogged(deps: CheckWriteDeps, write: CheckWrite, user: User, value: string): boolean {
  try {
    deps.store.appendPeople({
      at: deps.now(),
      actor: { kind: "user", person: { id: user.id, email: user.email, name: user.name } },
      action: write.action,
      target: { kind: "check", id: write.checkId },
      value,
    });
    return true;
  } catch (err) {
    deps.log.error("check change not logged", {
      error: err instanceof Error ? err.name : "unknown",
    });
    return false;
  }
}

/** Sends one write (never retried, never redirected) and maps its outcome (Decision 10, R8). */
export async function sendCheckWrite(
  deps: CheckWriteDeps,
  write: CheckWrite,
  user: User,
): Promise<WriteAnswer> {
  const outcome = checkOutcome(await send(deps, write));
  logOutcome(deps, write, user.id, outcome);
  switch (outcome.class) {
    case "saved": {
      const logged = isLogged(deps, write, user, outcome.revision ?? "unknown");
      return { kind: "saved", isLogged: logged };
    }
    case "refused":
      return refusedAnswer(outcome.status, outcome.message);
    case "unknown":
      // A failed row is logged as an error; the unknown answer already says to check.
      isLogged(deps, write, user, "unknown");
      return unknownAnswer(outcome.status, outcome.isRedirect);
    default: {
      const never: never = outcome;
      return never;
    }
  }
}
