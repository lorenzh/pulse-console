import {
  type RequestJsonResult,
  requestJson,
  type TokenSecretResponse,
  validateTokenSecretResponse,
} from "@lorenzh/pulse-contract";
import type { Logger } from "@lorenzh/pulse-kit";
import type { AccountStore, User } from "./account-store.ts";
import type { FetchLike } from "./api-read.ts";
import {
  NO_REASON_TEXT,
  SAVED_NOT_LOGGED_TEXT,
  THROTTLED_TEXT,
  writeGuardProblem,
} from "./check-write.ts";
import type { PageRequest, PageResult } from "./protected-route.ts";
import type { ConsoleRole } from "./roles.ts";

const WRITE_TIMEOUT_MS = 5000;
const MAX_MESSAGE_LENGTH = 1000;

export const NOT_LOGGED_TEXT = "The People log row could not be written.";
export const LOST_ANSWER_TEXT =
  "pulse-api made the change, but its answer could not be read, so the secret cannot be shown. Open the list: revoke the new token, or rotate it again after the overlap.";
export const TOKEN_UNKNOWN_TEXT =
  "The result is unknown. Open the list to see whether the token was created, rotated or revoked.";
export const TOKEN_SCOPE_REFUSED_TEXT =
  "pulse-api refused: the console token lacks a scope this token holds.";

export type TokenWriteDeps = {
  store: Pick<AccountStore, "isGuardHeld" | "userById" | "appendPeople">;
  fetch: FetchLike;
  adminToken: string | undefined;
  schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
  roleOf?: ((user: User) => ConsoleRole) | undefined;
  now: () => number;
  log: Logger;
};

/**
 * One outbound token write. `url` is built by the caller (the id with `apiIdSegment`). `value`
 * is the People-log value: `scopes=<list>` or `location=<location>`, never a secret.
 */
export type TokenWrite =
  | { action: "token.create"; url: string; body: string; value: string }
  | { action: "token.rotate" | "token.revoke"; url: string; tokenId: string; value: string };

/**
 * What the route shows. `secret` is the show-once answer of a create or rotate; `revoked` is the
 * redirect with its notice. `notLogged` is `SAVED_NOT_LOGGED_TEXT` when the People row failed.
 * `form` shows the form or confirmation again with `message`.
 */
export type TokenWriteAnswer =
  | { kind: "secret"; answer: TokenSecretResponse; notLogged: string | undefined }
  | { kind: "revoked"; notLogged: string | undefined }
  | { kind: "form"; status: number; message: string }
  | {
      kind: "text";
      status: number;
      message: string;
      reason: "token-rejected" | "not-found" | "other";
    }
  /** The live guard refused before any write. */
  | { kind: "guard"; page: PageResult };

type Outcome =
  | { class: "saved"; answer: TokenSecretResponse | undefined }
  | { class: "lost" }
  | { class: "refused"; status: number; message: string | undefined }
  | { class: "unknown"; isAnswered: boolean };

const isCreateOrRotate = (write: TokenWrite): boolean => write.action !== "token.revoke";

function secretOf(value: unknown): TokenSecretResponse | undefined {
  const checked = validateTokenSecretResponse(value);
  return checked.ok ? checked.value : undefined;
}

function answeredOutcome(write: TokenWrite, status: number, value: unknown): Outcome {
  if (!isCreateOrRotate(write)) return { class: "saved", answer: undefined };
  const expected = write.action === "token.create" ? 201 : 200;
  const answer = status === expected ? secretOf(value) : undefined;
  return answer === undefined ? { class: "lost" } : { class: "saved", answer };
}

// Decided by status and wire header first, as `check-outcome.ts`; the body only for the secret.
function outcomeOf(write: TokenWrite, result: RequestJsonResult<unknown>): Outcome {
  if (result.ok) {
    return result.wire === "ok"
      ? answeredOutcome(write, result.status, result.value)
      : { class: "unknown", isAnswered: true };
  }
  const { response, error } = result;
  if (response === null) return { class: "unknown", isAnswered: false };
  const isWireOk = response.wire.status === "ok";
  if (isWireOk && response.status >= 200 && response.status <= 299) {
    // A 2xx whose body could not be read: the change happened, the secret is lost.
    return isCreateOrRotate(write) ? { class: "lost" } : { class: "saved", answer: undefined };
  }
  if (isWireOk && response.status >= 400 && response.status <= 599) {
    const message = error.kind === "http" ? error.message : undefined;
    return { class: "refused", status: response.status, message };
  }
  return { class: "unknown", isAnswered: true };
}

function messageOf(message: string | undefined): string {
  return message === undefined ? NO_REASON_TEXT : message.slice(0, MAX_MESSAGE_LENGTH);
}

function refusedAnswer(status: number, message: string | undefined): TokenWriteAnswer {
  if (status === 400 || status === 422) {
    return { kind: "form", status: 422, message: messageOf(message) };
  }
  if (status === 401) return { kind: "text", status: 502, message: "", reason: "token-rejected" };
  if (status === 403) {
    return { kind: "text", status: 502, message: TOKEN_SCOPE_REFUSED_TEXT, reason: "other" };
  }
  if (status === 404) return { kind: "text", status: 404, message: "", reason: "not-found" };
  if (status === 409) return { kind: "form", status: 409, message: messageOf(message) };
  if (status === 429)
    return { kind: "text", status: 503, message: THROTTLED_TEXT, reason: "other" };
  return {
    kind: "text",
    status: 502,
    message: `pulse-api refused the request (${status}). Nothing was changed.`,
    reason: "other",
  };
}

function send(deps: TokenWriteDeps, write: TokenWrite): Promise<RequestJsonResult<unknown>> {
  return requestJson<unknown>(write.url, {
    method: "POST",
    fetch: deps.fetch,
    headers: { authorization: `Bearer ${deps.adminToken ?? ""}` },
    // The body is checked in `outcomeOf`, after the status and the wire header.
    validate: (raw) => ({ ok: true, value: raw }),
    timeoutMs: WRITE_TIMEOUT_MS,
    body: write.action === "token.create" ? write.body : "{}",
    ...(deps.schedule === undefined ? {} : { schedule: deps.schedule }),
  });
}

/** Appends the People row of a saved, lost or unknown write; false when the insert failed. */
function isLogged(
  deps: TokenWriteDeps,
  write: TokenWrite,
  user: User,
  tokenId: string | undefined,
  isUnknown: boolean,
): boolean {
  try {
    deps.store.appendPeople({
      at: deps.now(),
      actor: { kind: "user", person: { id: user.id, email: user.email, name: user.name } },
      action: write.action,
      target: { kind: "token", id: tokenId },
      value: isUnknown ? `${write.value} (unknown)` : write.value,
    });
    return true;
  } catch (err) {
    deps.log.error("token change not logged", {
      error: err instanceof Error ? err.name : "unknown",
    });
    return false;
  }
}

const knownId = (write: TokenWrite): string | undefined =>
  write.action === "token.create" ? undefined : write.tokenId;

function answerOf(
  deps: TokenWriteDeps,
  write: TokenWrite,
  user: User,
  outcome: Outcome,
): TokenWriteAnswer {
  switch (outcome.class) {
    case "saved": {
      const id = outcome.answer?.token.id ?? knownId(write);
      const notLogged = isLogged(deps, write, user, id, false) ? undefined : SAVED_NOT_LOGGED_TEXT;
      return outcome.answer === undefined
        ? { kind: "revoked", notLogged }
        : { kind: "secret", answer: outcome.answer, notLogged };
    }
    case "lost": {
      const logged = isLogged(deps, write, user, knownId(write), true);
      const message = logged ? LOST_ANSWER_TEXT : `${LOST_ANSWER_TEXT} ${NOT_LOGGED_TEXT}`;
      return { kind: "text", status: 502, message, reason: "other" };
    }
    case "refused":
      return refusedAnswer(outcome.status, outcome.message);
    case "unknown":
      // A failed row is logged as an error; the unknown text already says to check the list.
      isLogged(deps, write, user, knownId(write), true);
      return {
        kind: "text",
        status: outcome.isAnswered ? 502 : 504,
        message: TOKEN_UNKNOWN_TEXT,
        reason: "other",
      };
    default: {
      const never: never = outcome;
      return never;
    }
  }
}

/**
 * Runs the live guard (session still there, stored role still at least `requiredRole`), then
 * sends exactly one write: never retried, redirects not followed, 5000 ms timeout.
 */
export async function sendTokenWrite(
  deps: TokenWriteDeps,
  request: PageRequest,
  requiredRole: ConsoleRole,
  reloadHref: string,
  write: TokenWrite,
): Promise<TokenWriteAnswer> {
  const problem = writeGuardProblem(deps, request, requiredRole, reloadHref);
  if (problem !== undefined) return { kind: "guard", page: problem };
  const outcome = outcomeOf(write, await send(deps, write));
  deps.log.info("token change", {
    action: write.action,
    actorId: request.user.id,
    outcome: outcome.class,
    ...(outcome.class === "refused" ? { status: outcome.status } : {}),
  });
  return answerOf(deps, write, request.user, outcome);
}
