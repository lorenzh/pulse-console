import {
  type RequestJsonResult,
  type ResendRequest,
  requestJson,
  validateResendCommand,
} from "@lorenzh/pulse-contract";
import type { User } from "./account-store.ts";
import { type CheckOutcome, checkOutcome } from "./check-outcome.ts";
import {
  type CheckWriteDeps,
  refusedAnswer,
  unknownAnswer,
  type WriteAnswer,
} from "./check-write.ts";
import type { PeopleAction, PeopleEvent } from "./people-log.ts";
import { RUNTIME_OLD_API_TEXT } from "./runtime-read.ts";

const WRITE_TIMEOUT_MS = 5000;

export const RUNTIME_SCOPE_TEXT = "The console token lacks the admin scope.";
export const RUNTIME_UNKNOWN_TEXT =
  "The result is unknown. Open the page again to see whether the change was saved.";

/** One outbound write of a status or notify admin route. */
export type RuntimeWrite = {
  action: PeopleAction & (`status-settings.${string}` | `notify-${string}`);
  target: PeopleEvent["target"];
  method: "POST" | "PUT" | "DELETE";
  url: string;
  /** The configuration revision for `If-Match`, unquoted; `undefined` for a resend. */
  revision: string | undefined;
  body?: string | undefined;
};

function send(deps: CheckWriteDeps, write: RuntimeWrite): Promise<RequestJsonResult<unknown>> {
  const headers: Record<string, string> = { authorization: `Bearer ${deps.adminToken ?? ""}` };
  // Decision 16: only configuration writes carry a revision.
  if (write.revision !== undefined) headers["if-match"] = `"${write.revision}"`;
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
  write: RuntimeWrite,
  actorId: number,
  outcome: CheckOutcome,
): void {
  const fields: Record<string, unknown> = {
    action: write.action,
    actorId,
    outcome: outcome.class,
  };
  if (outcome.class === "refused") fields.status = outcome.status;
  deps.log.info("runtime change", fields);
}

/** Appends the People-log row of a saved or unknown write; false when the insert failed. */
function isLogged(deps: CheckWriteDeps, write: RuntimeWrite, user: User, value: string): boolean {
  try {
    deps.store.appendPeople({
      at: deps.now(),
      actor: { kind: "user", person: { id: user.id, email: user.email, name: user.name } },
      action: write.action,
      target: write.target,
      value,
    });
    return true;
  } catch (err) {
    deps.log.error("runtime change not logged", {
      error: err instanceof Error ? err.name : "unknown",
    });
    return false;
  }
}

function runtimeRefused(status: number, message: string | undefined): WriteAnswer {
  if (status === 403) {
    return { kind: "text", status: 502, message: RUNTIME_SCOPE_TEXT, reason: "other" };
  }
  if (status === 404) {
    return { kind: "text", status: 404, message: RUNTIME_OLD_API_TEXT, reason: "gone" };
  }
  return refusedAnswer(status, message);
}

function runtimeUnknown(status: number | null, isRedirect: boolean): WriteAnswer {
  if (status === null) {
    return { kind: "text", status: 504, message: RUNTIME_UNKNOWN_TEXT, reason: "other" };
  }
  const answer = unknownAnswer(status, isRedirect);
  return answer.kind === "text"
    ? { ...answer, message: answer.message.replaceAll("open the check", "open the page again") }
    : answer;
}

/**
 * Sends one status or notify write (never retried, never redirected) and classes its outcome by
 * the response metadata only. The People-log row holds the revision, never a setting value.
 */
export async function sendRuntimeWrite(
  deps: CheckWriteDeps,
  write: RuntimeWrite,
  user: User,
): Promise<WriteAnswer> {
  const outcome = checkOutcome(await send(deps, write));
  logOutcome(deps, write, user.id, outcome);
  switch (outcome.class) {
    case "saved":
      return {
        kind: "saved",
        isLogged: isLogged(deps, write, user, outcome.revision ?? "unknown"),
      };
    case "refused":
      return runtimeRefused(outcome.status, outcome.message);
    case "unknown":
      // A failed row is logged as an error; the unknown answer already says to check.
      isLogged(deps, write, user, "unknown");
      return runtimeUnknown(outcome.status, outcome.isRedirect);
    default: {
      const never: never = outcome;
      return never;
    }
  }
}

/** The outcome of a resend create: the command to open, or the answer to show. */
export type ResendAnswer =
  | { kind: "created"; commandId: string; isLogged: boolean }
  | { kind: "unknown"; status: number; message: string }
  | { kind: "busy"; message: string }
  | { kind: "refused"; answer: WriteAnswer };

export const RESEND_BUSY_TEXT = "pulse-api cannot take a resend now";

function resendAnswerOf(
  deps: CheckWriteDeps,
  write: RuntimeWrite,
  result: RequestJsonResult<{ id: string }>,
  user: User,
): ResendAnswer {
  // Decision 14: 202 is a new command, 200 a repeat or an open command; both name the command.
  if (
    result.ok &&
    result.wire === "ok" &&
    result.value !== undefined &&
    (result.status === 200 || result.status === 202)
  ) {
    return {
      kind: "created",
      commandId: result.value.id,
      isLogged: isLogged(deps, write, user, result.value.id),
    };
  }
  const outcome = checkOutcome(result);
  logOutcome(deps, write, user.id, outcome);
  if (outcome.class === "refused" && outcome.status === 503) {
    const reason = outcome.message === undefined ? "" : `: ${outcome.message.slice(0, 300)}`;
    return { kind: "busy", message: `${RESEND_BUSY_TEXT}${reason}. Try again later.` };
  }
  if (outcome.class === "refused") {
    return { kind: "refused", answer: runtimeRefused(outcome.status, outcome.message) };
  }
  // A saved status without a usable command is unknown too: the command id is not known.
  isLogged(deps, write, user, "unknown");
  const answer =
    outcome.class === "unknown"
      ? runtimeUnknown(outcome.status, outcome.isRedirect)
      : runtimeUnknown(null, false);
  return {
    kind: "unknown",
    status: answer.kind === "text" ? answer.status : 502,
    message: answer.kind === "text" ? answer.message : RUNTIME_UNKNOWN_TEXT,
  };
}

/**
 * Decision 14: `POST /admin/notify/resends` without `If-Match`, never retried. A repeat with
 * the same `requestId` after a lost answer gets the same command from pulse-api.
 */
export async function sendResend(
  deps: CheckWriteDeps,
  apiUrl: string,
  request: ResendRequest,
  user: User,
): Promise<ResendAnswer> {
  const write: RuntimeWrite = {
    action: "notify-resend.create",
    target: { kind: "notify-resend", channelId: request.channelId },
    method: "POST",
    url: `${apiUrl}/admin/notify/resends`,
    revision: undefined,
    body: JSON.stringify(request),
  };
  const result = await requestJson<{ id: string }>(write.url, {
    method: "POST",
    fetch: deps.fetch,
    headers: { authorization: `Bearer ${deps.adminToken ?? ""}` },
    validate: (raw) => validateResendCommand(raw),
    timeoutMs: WRITE_TIMEOUT_MS,
    body: write.body ?? "",
    ...(deps.schedule === undefined ? {} : { schedule: deps.schedule }),
  });
  if (result.ok) logOutcome(deps, write, user.id, { class: "saved", revision: null });
  return resendAnswerOf(deps, write, result, user);
}
