import { clientKeyOf } from "@lorenzh/pulse-kit";
import {
  DECRYPT_FAILED_TEXT,
  FACTOR_CHOICE_TEXT,
  factorPage,
  NO_KEY_TEXT,
} from "./account-pages.ts";
import type { Attempt } from "./auth-throttle.ts";
import type { FactorSignInResult, NewFullSession } from "./factor-store.ts";
import {
  type Ctx,
  type Current,
  currentOf,
  newToken,
  pushSessionCookie,
  readPostForm,
  redirect,
  sendHtml,
} from "./http-context.ts";
import type { AuthKind } from "./metrics.ts";
import { messagePage } from "./pages.ts";
import { normalizeRecoveryCode, recoveryCodeDigest } from "./recovery-codes.ts";
import { safeNext } from "./request-guard.ts";
import { openSecret } from "./secret-box.ts";
import { matchTotpStep, normalizeTotpInput } from "./totp.ts";

const FACTOR_FIELDS = ["code", "recovery_code"] as const;
/** Each code field holds at most this many characters. */
export const MAX_CODE_FIELD = 64;
const WRONG_CODE = "Wrong code.";
export const TOO_MANY = "Too many attempts. Try again later.";

function throttledPage(current: Current): string {
  return factorPage({ csrf: current.session.csrfToken, error: TOO_MANY });
}

type FactorKind = "totp" | "recovery-code" | "enrolment";

/**
 * Admits a second-factor attempt for the user and this client. A refusal is logged, counted and
 * answered 429 with `refusedHtml`; it returns undefined then.
 */
export function admitFactor(
  ctx: Ctx,
  userId: number,
  kind: FactorKind,
  refusedHtml: string,
): Attempt | undefined {
  const client = clientKeyOf(ctx.req.socket.remoteAddress);
  const admission = ctx.state.factorThrottle.admit({ account: String(userId), client });
  if (admission.isAdmitted) return admission.attempt;
  ctx.deps.log.warn("second factor failed", { client, kind, reason: "throttled" });
  ctx.deps.metrics.recordAuthAttempt(kind, "throttled");
  sendThrottled(ctx, refusedHtml, admission.retryAfterSeconds);
  return undefined;
}

/** Records a wrong second factor: it counts against both throttle keys. */
export function failFactor(ctx: Ctx, attempt: Attempt, kind: AuthKind): void {
  attempt.fail();
  const client = clientKeyOf(ctx.req.socket.remoteAddress);
  ctx.deps.log.warn("second factor failed", { client, kind, reason: "credentials" });
  ctx.deps.metrics.recordAuthAttempt(kind, "failure");
}

/** The 500 answer of a seed that the key cannot open; the reservation is not a failed guess. */
export function sendDecryptFailed(ctx: Ctx, attempt: Attempt, userId: number): void {
  attempt.release();
  ctx.deps.log.error("authenticator secret cannot be decrypted", { userId });
  sendHtml(ctx, 500, messagePage("Two-factor sign-in", DECRYPT_FAILED_TEXT));
}

export function sendNoKey(ctx: Ctx): void {
  sendHtml(ctx, 503, messagePage("Two-factor sign-in", NO_KEY_TEXT));
}

export function sendThrottled(ctx: Ctx, html: string, retryAfterSeconds: number): void {
  sendHtml(ctx, 429, html, { "retry-after": String(retryAfterSeconds) });
}

export function newFullSession(ctx: Ctx): NewFullSession {
  return { id: newToken(ctx), csrfToken: newToken(ctx) };
}

/** `GET /sign-in/factor`. */
export function sendFactorForm(ctx: Ctx): void {
  sendHtml(ctx, 200, factorPage({ csrf: currentOf(ctx).session.csrfToken }));
}

type Choice =
  | { kind: "totp"; code: string }
  | { kind: "recovery-code"; normalized: string }
  | { kind: "invalid" };

function choiceOf(code: string, recovery: string): Choice {
  const hasCode = code.trim() !== "";
  const hasRecovery = recovery.trim() !== "";
  if (hasCode === hasRecovery) return { kind: "invalid" };
  if (code.length > MAX_CODE_FIELD || recovery.length > MAX_CODE_FIELD) return { kind: "invalid" };
  if (hasCode) {
    const normalized = normalizeTotpInput(code);
    return normalized === undefined ? { kind: "invalid" } : { kind: "totp", code: normalized };
  }
  const normalized = normalizeRecoveryCode(recovery);
  return normalized === undefined ? { kind: "invalid" } : { kind: "recovery-code", normalized };
}

/** `POST /sign-in/factor`: after CSRF, format, key, throttle, verification and commit. */
export async function postFactor(ctx: Ctx): Promise<void> {
  const current = currentOf(ctx);
  const csrf = current.session.csrfToken;
  const fields = await readPostForm(ctx, FACTOR_FIELDS, csrf);
  if (fields === undefined) return;
  const choice = choiceOf(fields.code ?? "", fields.recovery_code ?? "");
  if (choice.kind === "invalid") {
    sendHtml(ctx, 422, factorPage({ csrf, error: FACTOR_CHOICE_TEXT }));
    return;
  }
  if (choice.kind === "totp") verifyTotp(ctx, current, choice.code);
  else verifyRecovery(ctx, current, choice.normalized);
}

function verifyTotp(ctx: Ctx, current: Current, code: string): void {
  const { deps } = ctx;
  const userId = current.user.id;
  const key = deps.secretKey;
  if (key === undefined) {
    sendNoKey(ctx);
    return;
  }
  const attempt = admitFactor(ctx, userId, "totp", throttledPage(current));
  if (attempt === undefined) return;
  const authenticator = deps.factorStore.authenticator(userId);
  if (authenticator === undefined) {
    attempt.release();
    redirect(ctx, "/sign-in");
    return;
  }
  const opened = openSecret(key, userId, authenticator.secret);
  if (!opened.isOpen) {
    sendDecryptFailed(ctx, attempt, userId);
    return;
  }
  const now = deps.now();
  const step = matchTotpStep(opened.plaintext, code, now, authenticator.lastStep);
  opened.plaintext.fill(0);
  if (step === undefined) {
    wrongFactor(ctx, current, attempt, "totp");
    return;
  }
  const session = newFullSession(ctx);
  const result = deps.factorStore.completeTotpSignIn({
    sessionId: current.id,
    userId,
    newSession: session,
    now,
    step,
  });
  finishFactor(ctx, current, attempt, "totp", { result, session });
}

function verifyRecovery(ctx: Ctx, current: Current, normalized: string): void {
  const userId = current.user.id;
  const attempt = admitFactor(ctx, userId, "recovery-code", throttledPage(current));
  if (attempt === undefined) return;
  const session = newFullSession(ctx);
  const result = ctx.deps.factorStore.completeRecoverySignIn({
    sessionId: current.id,
    userId,
    newSession: session,
    now: ctx.deps.now(),
    candidate: recoveryCodeDigest(normalized),
  });
  finishFactor(ctx, current, attempt, "recovery-code", { result, session });
}

function wrongFactor(ctx: Ctx, current: Current, attempt: Attempt, kind: AuthKind): void {
  failFactor(ctx, attempt, kind);
  sendHtml(ctx, 401, factorPage({ csrf: current.session.csrfToken, error: WRONG_CODE }));
}

function finishFactor(
  ctx: Ctx,
  current: Current,
  attempt: Attempt,
  kind: "totp" | "recovery-code",
  outcome: { result: FactorSignInResult; session: NewFullSession },
): void {
  const { result, session } = outcome;
  if (!result.ok) {
    if (result.reason === "factor") {
      wrongFactor(ctx, current, attempt, kind);
      return;
    }
    attempt.release();
    redirect(ctx, "/sign-in");
    return;
  }
  attempt.succeed();
  const userId = current.user.id;
  if (kind === "totp") ctx.deps.log.info("signed in", { userId, factor: kind });
  else ctx.deps.log.info("signed in", { userId, factor: kind, remaining: result.remaining });
  ctx.deps.metrics.recordAuthAttempt(kind, "success");
  pushSessionCookie(ctx, session.id, "full");
  redirect(ctx, safeNext(result.nextPath));
}
