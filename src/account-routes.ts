import { clientKeyOf } from "@lorenzh/pulse-kit";
import {
  type AuthenticatorView,
  authenticatorPage,
  DECRYPT_FAILED_TEXT,
  NO_KEY_TEXT,
  newCodesPage,
  pendingExpiredPage,
  recoveryCodesPage,
  securityPage,
  sessionsPage,
  signOutAllPage,
} from "./account-pages.ts";
import type { Attempt } from "./auth-throttle.ts";
import type { PendingAuthenticator } from "./factor-store.ts";
import {
  acceptSessionForm,
  type Ctx,
  type Current,
  currentOf,
  pushSessionCookie,
  readPostForm,
  redirect,
  sendHtml,
  sessionForm,
} from "./http-context.ts";
import { messagePage } from "./pages.ts";
import { isSignInPasswordAcceptable } from "./passwords.ts";
import {
  generateRecoveryCodes,
  normalizeRecoveryCode,
  recoveryCodeDigest,
} from "./recovery-codes.ts";
import { safeNext } from "./request-guard.ts";
import { openSecret, sealSecret } from "./secret-box.ts";
import {
  admitFactor,
  failFactor,
  MAX_CODE_FIELD,
  newFullSession,
  sendDecryptFailed,
  sendThrottled,
  settleOnThrow,
  TOO_MANY,
} from "./sign-in-factor.ts";
import { formExpiredResendNotice } from "./states.ts";
import { base32Encode, matchTotpStep, normalizeTotpInput, TOTP_SEED_BYTES } from "./totp.ts";

const AUTHENTICATOR_FIELDS = ["action", "code", "password", "form_token"] as const;
const NEW_CODES_FIELDS = ["password", "form_token"] as const;
const WRONG_PASSWORD = "Wrong password.";
const PASSWORD_FORMAT = "Enter your password (at most 128 characters).";

function codeDigest(code: string): string {
  return recoveryCodeDigest(normalizeRecoveryCode(code) ?? "").toString("hex");
}

function sendNoKeyPage(ctx: Ctx): void {
  sendHtml(ctx, 503, messagePage("Authenticator app", NO_KEY_TEXT));
}

/** The pending view of a live pending row, or undefined when its seed cannot be opened. */
function pendingView(
  ctx: Ctx,
  current: Current,
  pending: PendingAuthenticator,
  key: Uint8Array,
): AuthenticatorView | undefined {
  const opened = openSecret(key, current.user.id, pending.secret);
  if (!opened.isOpen) return undefined;
  const view: AuthenticatorView = {
    kind: "pending",
    ...sessionForm(ctx),
    email: current.user.email,
    key: base32Encode(opened.plaintext),
  };
  opened.plaintext.fill(0);
  return view;
}

/** The page without a live pending row: create a key (enrol) or replace (full). */
function startView(ctx: Ctx, current: Current, error?: string): AuthenticatorView {
  const form = sessionForm(ctx);
  const confirmed = ctx.deps.factorStore.authenticator(current.user.id);
  if (current.stage === "full" && confirmed !== undefined) {
    return { kind: "replace", ...form, confirmedAt: confirmed.confirmedAt, error };
  }
  return { kind: "new", ...form, error };
}

/** `GET /account/authenticator`. */
export function sendAuthenticator(ctx: Ctx): void {
  const current = currentOf(ctx);
  const key = ctx.deps.secretKey;
  if (key === undefined) {
    sendNoKeyPage(ctx);
    return;
  }
  const pending = ctx.deps.factorStore.pendingAuthenticator(current.id, ctx.deps.now());
  if (pending === undefined) {
    sendHtml(ctx, 200, authenticatorPage(startView(ctx, current)));
    return;
  }
  const view = pendingView(ctx, current, pending, key);
  if (view === undefined) {
    ctx.deps.log.error("authenticator secret cannot be decrypted", { userId: current.user.id });
    sendHtml(ctx, 500, messagePage("Authenticator app", DECRYPT_FAILED_TEXT));
    return;
  }
  sendHtml(ctx, 200, authenticatorPage(view));
}

/** `POST /account/authenticator`: `action=new` or `action=confirm`. */
export async function postAuthenticator(ctx: Ctx): Promise<void> {
  const current = currentOf(ctx);
  const fields = await readPostForm(ctx, AUTHENTICATOR_FIELDS, current.session.csrfToken);
  if (fields === undefined) return;
  switch (fields.action ?? "") {
    case "new":
      await createPending(ctx, current, fields.password ?? "", fields.form_token);
      return;
    case "confirm":
      confirmPending(ctx, current, fields.code ?? "", fields.form_token);
      return;
    default:
      sendHtml(ctx, 422, authenticatorPage(startView(ctx, current, "Choose an action.")));
  }
}

/**
 * The password recheck of a `full` session: format (422), then the caller's key check, then the
 * password throttle (429) and the password (401). It answers every failure itself.
 */
export async function recheckPassword(
  ctx: Ctx,
  current: Current,
  password: string,
  page: (error: string) => string,
  beforeThrottle: () => boolean = () => true,
): Promise<boolean> {
  if (password === "" || !isSignInPasswordAcceptable(password)) {
    sendHtml(ctx, 422, page(PASSWORD_FORMAT));
    return false;
  }
  if (!beforeThrottle()) return false;
  const { deps } = ctx;
  const client = clientKeyOf(ctx.req.socket.remoteAddress);
  const admission = ctx.state.signInThrottle.admit({ account: current.user.email, client });
  if (!admission.isAdmitted) {
    deps.log.warn("password confirmation failed", { client, reason: "throttled" });
    deps.metrics.recordAuthAttempt("password-confirm", "throttled");
    sendThrottled(ctx, page(TOO_MANY), admission.retryAfterSeconds);
    return false;
  }
  let isValid: boolean;
  try {
    isValid = await deps.verifier.verify(password, current.user.passwordHash);
  } catch (err) {
    admission.attempt.release();
    throw err;
  }
  if (!isValid) {
    admission.attempt.fail();
    deps.log.warn("password confirmation failed", { client, reason: "credentials" });
    deps.metrics.recordAuthAttempt("password-confirm", "failure");
    sendHtml(ctx, 401, page(WRONG_PASSWORD));
    return false;
  }
  admission.attempt.succeed();
  deps.metrics.recordAuthAttempt("password-confirm", "success");
  return true;
}

async function createPending(
  ctx: Ctx,
  current: Current,
  password: string,
  token: string | undefined,
): Promise<void> {
  const { deps } = ctx;
  const hasKey = (): boolean => {
    if (deps.secretKey !== undefined) return true;
    sendNoKeyPage(ctx);
    return false;
  };
  if (current.stage === "full") {
    const page = (error: string): string => authenticatorPage(startView(ctx, current, error));
    if (!(await recheckPassword(ctx, current, password, page, hasKey))) return;
  } else if (!hasKey()) {
    return;
  }
  const key = deps.secretKey;
  if (key === undefined) return;
  if (
    !acceptSessionForm(ctx, token, () =>
      authenticatorPage(startView(ctx, current, formExpiredResendNotice)),
    )
  )
    return;
  const seed = deps.randomBytes(TOTP_SEED_BYTES);
  const secret = sealSecret(key, current.user.id, seed, deps.randomBytes);
  seed.fill(0);
  deps.factorStore.savePendingAuthenticator(current.id, current.user.id, secret, deps.now());
  redirect(ctx, "/account/authenticator");
}

function confirmPending(
  ctx: Ctx,
  current: Current,
  input: string,
  token: string | undefined,
): void {
  const { deps } = ctx;
  const userId = current.user.id;
  const code = input.length > MAX_CODE_FIELD ? undefined : normalizeTotpInput(input);
  if (code === undefined) {
    const error = "Enter the 6-digit code from your authenticator app.";
    sendHtml(ctx, 422, authenticatorPage(startView(ctx, current, error)));
    return;
  }
  const key = deps.secretKey;
  if (key === undefined) {
    sendNoKeyPage(ctx);
    return;
  }
  const attempt = admitFactor(
    ctx,
    userId,
    "enrolment",
    authenticatorPage(startView(ctx, current, TOO_MANY)),
  );
  if (attempt === undefined) return;
  const now = deps.now();
  const pending = deps.factorStore.pendingAuthenticator(current.id, now);
  if (pending === undefined) {
    attempt.release();
    sendHtml(ctx, 409, pendingExpiredPage(sessionForm(ctx), current.stage === "full"));
    return;
  }
  const opened = openSecret(key, userId, pending.secret);
  if (!opened.isOpen) {
    sendDecryptFailed(ctx, attempt, userId);
    return;
  }
  const step = matchTotpStep(opened.plaintext, code, now, -1);
  opened.plaintext.fill(0);
  if (step === undefined) {
    failFactor(ctx, attempt, "enrolment");
    const form = sessionForm(ctx);
    sendHtml(ctx, 401, authenticatorPage({ kind: "retry", ...form, error: "Wrong code." }));
    return;
  }
  if (
    !acceptSessionForm(ctx, token, () =>
      authenticatorPage({ kind: "retry", ...sessionForm(ctx), error: formExpiredResendNotice }),
    )
  ) {
    attempt.release();
    return;
  }
  commitConfirmation(ctx, current, attempt, { secret: pending.secret, step, now });
}

function commitConfirmation(
  ctx: Ctx,
  current: Current,
  attempt: Attempt,
  input: { secret: string; step: number; now: number },
): void {
  const { deps } = ctx;
  const codes = generateRecoveryCodes(deps.randomBytes);
  const recoveryDigests = codes.map(codeDigest);
  const session = newFullSession(ctx);
  const result = settleOnThrow(attempt, () =>
    deps.factorStore.confirmAuthenticator({
      sessionId: current.id,
      userId: current.user.id,
      secret: input.secret,
      step: input.step,
      recoveryDigests,
      newSession: session,
      now: input.now,
    }),
  );
  if (!result.ok) {
    attempt.release();
    sendHtml(ctx, 409, pendingExpiredPage(sessionForm(ctx), current.stage === "full"));
    return;
  }
  attempt.succeed();
  deps.metrics.recordAuthAttempt("enrolment", "success");
  deps.log.info("authenticator confirmed", { userId: current.user.id });
  pushSessionCookie(ctx, session.id, "full");
  sendHtml(ctx, 200, recoveryCodesPage({ codes, next: safeNext(current.session.nextPath) }));
}

/** `GET /account/security`. */
export function sendSecurity(ctx: Ctx): void {
  const current = currentOf(ctx);
  const { factorStore } = ctx.deps;
  const page = securityPage({
    confirmedAt: factorStore.authenticator(current.user.id)?.confirmedAt,
    codesLeft: factorStore.unusedRecoveryCodeCount(current.user.id),
  });
  sendHtml(ctx, 200, page);
}

function newCodesView(ctx: Ctx, current: Current, error?: string): string {
  return newCodesPage({
    ...sessionForm(ctx),
    codesLeft: ctx.deps.factorStore.unusedRecoveryCodeCount(current.user.id),
    error,
  });
}

/** `GET /account/recovery-codes`: the password confirmation. */
export function sendNewCodesForm(ctx: Ctx): void {
  sendHtml(ctx, 200, newCodesView(ctx, currentOf(ctx)));
}

/** `POST /account/recovery-codes`: the password again, then a new set replaces the old one. */
export async function postNewCodes(ctx: Ctx): Promise<void> {
  const current = currentOf(ctx);
  const fields = await readPostForm(ctx, NEW_CODES_FIELDS, current.session.csrfToken);
  if (fields === undefined) return;
  const page = (error: string): string => newCodesView(ctx, current, error);
  if (!(await recheckPassword(ctx, current, fields.password ?? "", page))) return;
  const { deps } = ctx;
  if (
    !acceptSessionForm(ctx, fields.form_token, () =>
      newCodesView(ctx, current, formExpiredResendNotice),
    )
  )
    return;
  const codes = generateRecoveryCodes(deps.randomBytes);
  deps.factorStore.replaceRecoveryCodes(current.user.id, codes.map(codeDigest));
  deps.log.info("recovery codes created", { userId: current.user.id });
  sendHtml(ctx, 200, recoveryCodesPage({ codes, next: "/account/security" }));
}

/** `GET /account/sessions`: the live `full` sessions of this user. */
export function sendSessions(ctx: Ctx): void {
  const current = currentOf(ctx);
  const rows = ctx.deps.store.listSessions(current.user.id, current.id, ctx.deps.now());
  const notice =
    ctx.query.get("signed-out") === "others" ? "All other sessions are signed out." : undefined;
  sendHtml(ctx, 200, sessionsPage({ ...sessionForm(ctx), rows, notice }));
}

/** `GET /account/sessions/sign-out-all`: the confirmation. */
export function sendSignOutAllForm(ctx: Ctx): void {
  sendHtml(ctx, 200, signOutAllPage(sessionForm(ctx)));
}

/**
 * `POST /account/sessions/sign-out-all`: every other session row of the user goes, in every
 * stage. The current row, cookie and CSRF token stay, so no Set-Cookie is sent.
 */
export async function postSignOutAll(ctx: Ctx): Promise<void> {
  const current = currentOf(ctx);
  const fields = await readPostForm(ctx, ["form_token"], current.session.csrfToken);
  if (fields === undefined) return;
  if (
    !acceptSessionForm(ctx, fields.form_token, () =>
      signOutAllPage(sessionForm(ctx), formExpiredResendNotice),
    )
  )
    return;
  const sessions = ctx.deps.store.deleteOtherSessions(current.user.id, current.id);
  ctx.deps.log.info("signed out other sessions", { userId: current.user.id, sessions });
  redirect(ctx, "/account/sessions?signed-out=others");
}
