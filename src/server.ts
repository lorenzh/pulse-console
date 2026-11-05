import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { clientKeyOf, handleOps, type OpsHandlers, StartupError } from "@lorenzh/pulse-kit";
import { isLinkPrefixedPath, linkOfPath, linkOrigin, linkPathLabel } from "./account-links.ts";
import {
  postAuthenticator,
  postNewCodes,
  postSignOutAll,
  sendAuthenticator,
  sendNewCodesForm,
  sendSecurity,
  sendSessions,
  sendSignOutAllForm,
} from "./account-routes.ts";
import {
  type AccountStore,
  isSessionLive,
  type NewSessionOptions,
  SESSION_IDLE_MS,
  type Session,
  type SessionStage,
  sessionDigest,
  type User,
} from "./account-store.ts";
import { createAuthThrottle } from "./auth-throttle.ts";
import { NO_TOKEN_TEXT, testConnection } from "./connection-test.ts";
import { CONSOLE_JS } from "./console-script.ts";
import { serializeCookie, serializeCookieDeletion } from "./cookies.ts";
import { createFormTokens, type FormTokenResult } from "./form-tokens.ts";
import { checkApiUrl, checkEmail, checkName, type FormFields, passwordText } from "./forms.ts";
import { paragraph } from "./html.ts";
import {
  anonBinding,
  type ConsoleServerDeps,
  type Ctx,
  type Current,
  cookieOf,
  ensureCsrf,
  NOT_FOUND,
  newToken,
  pushSessionCookie,
  readFormFields,
  readPostForm,
  redirect,
  type State,
  send,
  sendHtml,
  sendText,
} from "./http-context.ts";
import { postInvite, sendInviteForm } from "./link-routes.ts";
import type { PathLabel } from "./metrics.ts";
import type { NavId } from "./navigation.ts";
import { overviewView } from "./overview.ts";
import { readOverview } from "./overview-read.ts";
import {
  alreadySubmittedPage,
  type ConnectionView,
  messagePage,
  type OwnerErrors,
  type OwnerValues,
  setupCodePage,
  setupOwnerPage,
  signInPage,
} from "./pages.ts";
import { isSignInPasswordAcceptable } from "./passwords.ts";
import { routeRole } from "./permissions.ts";
import type { PageMethod, PageRequest, PageResult, ProtectedRoute } from "./protected-route.ts";
import { isLoopbackHost, safeNext } from "./request-guard.ts";
import { type ConsoleRole, hasRole } from "./roles.ts";
import { shellPage } from "./shell.ts";
import { postFactor, sendFactorForm } from "./sign-in-factor.ts";
import {
  alreadySubmittedState,
  forbiddenState,
  formExpiredNotice,
  formExpiredResendNotice,
  notFoundState,
} from "./states.ts";
import { CONSOLE_CSS } from "./styles.ts";
import { teamRoutes } from "./team-routes.ts";
import { isSecondFactorRequired, signInStage } from "./two-factor-policy.ts";

export type { ConsoleServerDeps };

export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};
const MISDIRECTED = "misdirected request: set PULSE_CONSOLE_PUBLIC_URL to serve this host\n";
const ERROR_CODE = /^E[A-Z0-9_]+$/;

/**
 * The session stage a route needs after setup. `public` routes run no gate; `any-session` is
 * sign-out; `enrol-or-full` is the authenticator page.
 */
type Access = "public" | "any-session" | "full" | "factor" | "enrol-or-full";
type Route = { methods: readonly string[]; access: Access; isNewInPhase2?: true };

const OPS_PATHS: readonly string[] = ["/healthz", "/readyz", "/metrics"];
const TEST_PREFIX = "/__test/";
const ROUTES: Readonly<Record<string, Route>> = {
  "/setup": { methods: ["GET", "HEAD", "POST"], access: "public" },
  "/setup/owner": { methods: ["GET", "HEAD", "POST"], access: "public" },
  "/sign-in": { methods: ["GET", "HEAD", "POST"], access: "public" },
  "/sign-out": { methods: ["POST"], access: "any-session" },
  "/console.js": { methods: ["GET", "HEAD"], access: "public" },
  "/console.css": { methods: ["GET", "HEAD"], access: "public" },
  "/sign-in/factor": { methods: ["GET", "HEAD", "POST"], access: "factor", isNewInPhase2: true },
  "/account/authenticator": {
    methods: ["GET", "HEAD", "POST"],
    access: "enrol-or-full",
    isNewInPhase2: true,
  },
  "/account/security": { methods: ["GET", "HEAD"], access: "full", isNewInPhase2: true },
  "/account/recovery-codes": {
    methods: ["GET", "HEAD", "POST"],
    access: "full",
    isNewInPhase2: true,
  },
  "/account/sessions": { methods: ["GET", "HEAD"], access: "full", isNewInPhase2: true },
  "/account/sessions/sign-out-all": {
    methods: ["GET", "HEAD", "POST"],
    access: "full",
    isNewInPhase2: true,
  },
};

const CODE_FIELDS = ["code", "csrf", "form_token"] as const;
const OWNER_FIELDS = [
  "api_url",
  "email",
  "name",
  "password",
  "password_confirm",
  "action",
  "csrf",
  "form_token",
] as const;
const SIGN_OUT_FIELDS = ["csrf", "form_token"] as const;
const SIGN_IN_FIELDS = ["email", "password", "next", "form_token"] as const;
const SESSION_TOUCH_MS = 60_000;
const WRONG_CREDENTIALS = "Wrong email or password.";
const EXPIRED = "Your session has expired.";

/** A test route key outside /__test/ or on a production path. */
export class TestRouteError extends Error {
  override name = "TestRouteError";
}
type SignedIn = Current;
/**
 * The raw path before the first "?", not decoded and not normalised, as kit's handleOps reads
 * it. A parsed URL would turn "//healthz" or "/%2e%2e/" into "/".
 */
function rawPath(req: IncomingMessage): string {
  return (req.url ?? "/").split("?")[0] ?? "/";
}

function rawQuery(req: IncomingMessage): URLSearchParams {
  const url = req.url ?? "";
  const index = url.indexOf("?");
  return new URLSearchParams(index < 0 ? "" : url.slice(index + 1));
}

function pathLabel(path: string): PathLabel {
  switch (path) {
    case "/":
    case "/healthz":
    case "/readyz":
    case "/metrics":
    case "/setup":
    case "/setup/owner":
    case "/sign-in":
    case "/sign-out":
    case "/console.css":
    case "/sign-in/factor":
    case "/account/authenticator":
    case "/account/security":
    case "/account/recovery-codes":
    case "/account/sessions":
    case "/account/sessions/sign-out-all":
    case "/console.js":
    case "/team":
    case "/team/invites":
    case "/team/invites/revoke":
    case "/team/role":
    case "/team/remove":
    case "/team/reset-2fa":
    case "/team/transfer":
    case "/team/require-2fa":
      return path;
    default:
      return linkOfPath(path)?.kind === "invite" ? "/invite/:token" : "other";
  }
}

/** The organisation switch, read live from the instance row. */
function organisationOf(ctx: Ctx): { isRequiredForAll: boolean } {
  return { isRequiredForAll: ctx.deps.store.instance()?.isTwoFactorRequiredForAll === true };
}

/**
 * The live session of this request's cookie with its effective stage, or undefined (anonymous).
 * A `full` row of a user who must have a second factor but has none counts as `enrol`.
 */
function currentSession(ctx: Ctx): Current | undefined {
  const id = cookieOf(ctx, "session");
  if (id === undefined) return undefined;
  const session = ctx.deps.store.session(id);
  if (session === undefined || !isSessionLive(session, ctx.deps.now())) return undefined;
  const user = ctx.deps.store.userById(session.userId);
  if (user === undefined) return undefined;
  const isMissingFactor =
    session.stage === "full" &&
    isSecondFactorRequired(user, organisationOf(ctx)) &&
    ctx.deps.factorStore.authenticator(user.id) === undefined;
  return { id, session, user, stage: isMissingFactor ? "enrol" : session.stage };
}

/** A touch of a `full` session after 60000 ms; it refreshes the cookie with the same value. */
function touch(ctx: Ctx, current: Current): void {
  const now = ctx.deps.now();
  if (current.stage !== "full" || now - current.session.lastSeenAt < SESSION_TOUCH_MS) return;
  ctx.deps.store.touchSession(current.id, now);
  pushSessionCookie(ctx, current.id, "full");
}

/** Where a request of `stage` goes when the route needs `access`; undefined lets it pass. */
function gateTarget(
  access: Access,
  stage: Current["stage"] | "anonymous",
  path: string,
): string | undefined {
  if (access === "public" || access === "any-session") return undefined;
  if (stage === access || (access === "enrol-or-full" && (stage === "enrol" || stage === "full"))) {
    return undefined;
  }
  switch (stage) {
    case "anonymous":
      return access === "factor" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(path)}`;
    case "factor":
      return "/sign-in/factor";
    case "enrol":
      return "/account/authenticator";
    case "full":
      return "/";
    default: {
      const never: never = stage;
      return never;
    }
  }
}

/** The access gate: it runs after setup, before Origin and the body. True lets the request on. */
function passesGate(ctx: Ctx, access: Access): boolean {
  const current = currentSession(ctx);
  const target = gateTarget(access, current?.stage ?? "anonymous", safeNext(ctx.req.url));
  if (target !== undefined) {
    redirect(ctx, target);
    return false;
  }
  ctx.current = current;
  // Sign out all must leave the current row and cookie unchanged, so its POST never touches.
  const isSignOutAll = ctx.req.method === "POST" && ctx.path === "/account/sessions/sign-out-all";
  if (current !== undefined && access !== "public" && !isSignOutAll) touch(ctx, current);
  return true;
}

function signedInOf(ctx: Ctx): SignedIn | undefined {
  return ctx.current?.stage === "full" ? ctx.current : undefined;
}

function sessionBinding(sessionId: string): string {
  return `s:${sessionDigest(sessionId)}`;
}

/** A fresh form token; a HEAD answer sends no body, so it stores nothing. */
function issueFormToken(ctx: Ctx, binding: string, path: string): string {
  return ctx.req.method === "HEAD" ? "" : ctx.state.formTokens.issue(binding, path);
}

function logRefusedToken(ctx: Ctx, reason: Exclude<FormTokenResult, "accepted">): void {
  ctx.deps.log.info("form token refused", { reason, path: logPath(ctx.path) });
}

/** The path of a log line: a link path is logged by its label, never with its token. */
function logPath(path: string): string {
  const link = linkOfPath(path);
  return link === undefined ? path : linkPathLabel(link.kind);
}

/**
 * The form-token step at a commit point. A refused token gets its 409 answer here: "already
 * submitted" for a replay, else the form again from `expiredPage`.
 */
function acceptFormToken(
  ctx: Ctx,
  token: string | undefined,
  binding: string,
  refusal: { reopenHref: string; expiredPage: () => string },
): boolean {
  const result = ctx.state.formTokens.consume(token ?? "", binding, ctx.path);
  if (result === "accepted") return true;
  logRefusedToken(ctx, result);
  const page =
    result === "replayed" ? alreadySubmittedPage(refusal.reopenHref) : refusal.expiredPage();
  sendHtml(ctx, 409, page);
  return false;
}

function roleOfUser(ctx: Ctx, user: User): ConsoleRole {
  return ctx.deps.roleOf?.(user) ?? user.role;
}

type ShellPart = {
  title: string;
  body: string;
  banner?: string | undefined;
  navId?: NavId | undefined;
};

function signedInPage(
  ctx: Ctx,
  signedIn: { id: string; user: User; csrf: string },
  page: ShellPart,
): string {
  return shellPage({
    instanceName: ctx.deps.instanceName,
    user: signedIn.user,
    role: roleOfUser(ctx, signedIn.user),
    csrf: signedIn.csrf,
    signOutToken: issueFormToken(ctx, sessionBinding(signedIn.id), "/sign-out"),
    current: page.navId,
    banner: page.banner,
    title: page.title,
    body: page.body,
  });
}

function shellOf(signedIn: SignedIn): { id: string; user: User; csrf: string } {
  return { id: signedIn.id, user: signedIn.user, csrf: signedIn.session.csrfToken };
}

/** The Overview at `/`: two pulse-api reads and their summary. */
function overviewRoute(deps: ConsoleServerDeps): ProtectedRoute {
  return {
    path: "/",
    methods: ["GET"],
    requiredRole: routeRole("overview.view"),
    navId: "overview",
    handle: async () => {
      const apiUrl = deps.store.instance()?.apiUrl ?? deps.defaultApiUrl;
      const read = await readOverview(apiUrl, {
        fetch: deps.fetch,
        token: deps.adminToken,
        schedule: deps.schedule,
        warn: (message, fields) => deps.log.warn(message, fields),
      });
      const view = overviewView(new URL(apiUrl).origin, read);
      const banner = view.banner === "" ? undefined : view.banner;
      return { kind: "page", status: 200, title: "Overview", body: view.body, banner };
    },
  };
}

function hasGrant(ctx: Ctx): boolean {
  return ctx.state.gate?.isGrantValid(cookieOf(ctx, "setup")) ?? false;
}

function ownerDefaults(ctx: Ctx): OwnerValues {
  return { apiUrl: ctx.deps.defaultApiUrl, email: "", name: "" };
}

// Without a token no setup can complete, so the first owner page already says why.
function missingTokenView(ctx: Ctx): ConnectionView | undefined {
  return ctx.deps.adminToken === undefined ? { isOk: false, text: NO_TOKEN_TEXT } : undefined;
}

/** The CSRF token of a pre-session form and a fresh form token bound to it. */
function anonForm(ctx: Ctx, csrf: string): { csrf: string; formToken: string } {
  return { csrf, formToken: issueFormToken(ctx, anonBinding(csrf), ctx.path) };
}

function handleGet(ctx: Ctx, isSetUp: boolean): void {
  switch (ctx.path) {
    case "/setup":
      sendHtml(ctx, 200, setupCodePage(anonForm(ctx, ensureCsrf(ctx))));
      return;
    case "/setup/owner":
      if (!hasGrant(ctx)) redirect(ctx, "/setup");
      else
        sendHtml(
          ctx,
          200,
          setupOwnerPage({
            ...anonForm(ctx, ensureCsrf(ctx)),
            values: ownerDefaults(ctx),
            connection: missingTokenView(ctx),
          }),
        );
      return;
    case "/sign-in":
      sendSignInForm(ctx, isSetUp);
      return;
    case "/console.js":
      send(ctx, 200, "text/javascript; charset=utf-8", CONSOLE_JS);
      return;
    case "/sign-in/factor":
      sendFactorForm(ctx);
      return;
    case "/account/authenticator":
      sendAuthenticator(ctx);
      return;
    case "/console.css":
      send(ctx, 200, "text/css; charset=utf-8", CONSOLE_CSS);
      return;
    default:
      handleAccountGet(ctx);
  }
}

function handleAccountGet(ctx: Ctx): void {
  switch (ctx.path) {
    case "/account/security":
      sendSecurity(ctx);
      return;
    case "/account/recovery-codes":
      sendNewCodesForm(ctx);
      return;
    case "/account/sessions":
      sendSessions(ctx);
      return;
    case "/account/sessions/sign-out-all":
      sendSignOutAllForm(ctx);
      return;
    default:
      sendText(ctx, 404, NOT_FOUND);
  }
}

function sendSignInForm(ctx: Ctx, isSetUp: boolean): void {
  if (!isSetUp) {
    redirect(ctx, "/setup");
    return;
  }
  if (ctx.current?.stage === "full") {
    redirect(ctx, "/");
    return;
  }
  const notice = signInNotice(ctx);
  const next = safeNext(ctx.query.get("next") ?? undefined);
  sendHtml(ctx, 200, signInPage({ ...anonForm(ctx, ensureCsrf(ctx)), next, notice }));
}

function signInNotice(ctx: Ctx): string | undefined {
  if (cookieOf(ctx, "session") !== undefined && ctx.current === undefined) {
    // The cookie names no valid session here, so the notice shows and the cookie is cleared.
    ctx.cookies.push(serializeCookieDeletion("session", ctx.deps.mode));
    return EXPIRED;
  }
  if (ctx.query.get("transfer") === "done") return "Ownership is transferred. Sign in again.";
  return ctx.query.get("setup") === "done" ? "Setup is complete. Sign in." : undefined;
}

function csrfOf(fields: { csrf?: string }): string {
  return fields.csrf ?? "";
}

async function postSetupCode(ctx: Ctx): Promise<void> {
  const fields = await readPostForm(ctx, CODE_FIELDS);
  const gate = ctx.state.gate;
  if (fields === undefined) return;
  if (gate === undefined) {
    sendText(ctx, 404, NOT_FOUND);
    return;
  }
  const csrf = csrfOf(fields);
  const codePage = (error: string): string => setupCodePage({ ...anonForm(ctx, csrf), error });
  const check = gate.checkCode(fields.code ?? "");
  if (check === "empty") {
    sendHtml(ctx, 422, codePage("Enter the setup code."));
    return;
  }
  const client = clientKeyOf(ctx.req.socket.remoteAddress);
  const admission = ctx.state.setupThrottle.admit({ client });
  if (!admission.isAdmitted) {
    ctx.deps.log.warn("setup code refused", { client, reason: "throttled" });
    ctx.deps.metrics.recordAuthAttempt("setup-code", "throttled");
    const page = codePage("Too many attempts. Try again later.");
    sendHtml(ctx, 429, page, { "retry-after": String(admission.retryAfterSeconds) });
    return;
  }
  if (check === "mismatch") {
    admission.attempt.fail();
    ctx.deps.log.warn("setup code refused", { client, reason: "credentials" });
    ctx.deps.metrics.recordAuthAttempt("setup-code", "failure");
    sendHtml(ctx, 401, codePage("Wrong setup code."));
    return;
  }
  const refusal = { reopenHref: "/setup", expiredPage: () => codePage(formExpiredResendNotice) };
  if (!acceptFormToken(ctx, fields.form_token, anonBinding(csrf), refusal)) {
    admission.attempt.release();
    return;
  }
  admission.attempt.succeed();
  ctx.deps.metrics.recordAuthAttempt("setup-code", "success");
  ctx.cookies.push(serializeCookie("setup", gate.createGrant(), ctx.deps.mode));
  redirect(ctx, "/setup/owner");
}

type OwnerForm = FormFields<(typeof OWNER_FIELDS)[number]>;
type ValidOwner = { apiUrl: string; email: string; name: string; password: string };

function validateOwner(fields: OwnerForm): { owner: ValidOwner; errors: OwnerErrors } {
  const errors: OwnerErrors = {};
  const apiUrl = checkApiUrl(fields.api_url);
  const email = checkEmail(fields.email);
  const name = checkName(fields.name);
  const password = fields.password ?? "";
  if (!apiUrl.isOk) errors.apiUrl = apiUrl.text;
  // Every field is checked before the connection test, for both actions.
  if (!email.isOk) errors.email = email.text;
  if (!name.isOk) errors.name = name.text;
  const text = passwordText(password, fields.password_confirm ?? "");
  if (text !== undefined) errors.password = text;
  return {
    owner: {
      apiUrl: apiUrl.isOk ? apiUrl.url : "",
      email: email.isOk ? email.email : "",
      name: name.isOk ? name.name : "",
      password,
    },
    errors,
  };
}

// The non-secret fields are shown again as typed (escaped), so the owner can fix them.
function keptValues(fields: OwnerForm): OwnerValues {
  return { apiUrl: fields.api_url ?? "", email: fields.email ?? "", name: fields.name ?? "" };
}

async function postSetupOwner(ctx: Ctx): Promise<void> {
  const fields = await readPostForm(ctx, OWNER_FIELDS);
  if (fields === undefined) return;
  if (!hasGrant(ctx)) {
    const link = { href: "/setup", label: "Enter the setup code" };
    sendHtml(
      ctx,
      403,
      messagePage("Setup is locked", "Setup is locked. Enter the setup code first.", link),
    );
    return;
  }
  const csrf = csrfOf(fields);
  const action = fields.action;
  const isComplete = action === "complete";
  const { owner, errors } = validateOwner(fields);
  const values = keptValues(fields);
  const ownerPage = (view: OwnerView): string =>
    setupOwnerPage({ ...anonForm(ctx, csrf), values, ...view });
  if (action !== "test" && !isComplete) {
    sendHtml(ctx, 422, ownerPage({ errors, message: "Choose an action." }));
    return;
  }
  if (Object.keys(errors).length > 0) {
    sendHtml(ctx, 422, ownerPage({ errors }));
    return;
  }
  const { fetch, adminToken: token, schedule } = ctx.deps;
  const result = await testConnection(
    owner.apiUrl,
    schedule === undefined ? { fetch, token } : { fetch, token, schedule },
  );
  if (!result.isOk) {
    const connection: ConnectionView = { isOk: false, text: result.text };
    sendHtml(ctx, 502, ownerPage({ connection }));
    return;
  }
  const connection: ConnectionView = {
    isOk: true,
    checkCount: result.checkCount,
    isScopeChecked: result.adminScope === "confirmed",
  };
  if (!isComplete) {
    sendHtml(ctx, 200, ownerPage({ connection }));
    return;
  }
  const refusal = {
    reopenHref: "/setup/owner",
    expiredPage: () => ownerPage({ connection, message: formExpiredNotice }),
  };
  if (!acceptFormToken(ctx, fields.form_token, anonBinding(csrf), refusal)) return;
  await commitSetup(ctx, owner, result.checkCount, (message) => ownerPage({ connection, message }));
}

type OwnerView = {
  errors?: OwnerErrors;
  connection?: ConnectionView;
  message?: string;
};

async function commitSetup(
  ctx: Ctx,
  owner: ValidOwner,
  checks: number,
  pageWith: (message: string) => string,
): Promise<void> {
  const { deps } = ctx;
  let outcome: ReturnType<AccountStore["completeSetup"]>;
  try {
    const passwordHash = await deps.hashPassword(owner.password);
    outcome = deps.store.completeSetup(
      { email: owner.email, name: owner.name, passwordHash },
      owner.apiUrl,
      deps.now(),
    );
  } catch (err) {
    deps.log.error("setup could not be saved", {
      error: err instanceof Error ? err.name : "unknown",
    });
    sendHtml(ctx, 500, pageWith("Setup could not be saved."));
    return;
  }
  if (!outcome.ok) {
    sendHtml(ctx, 409, messagePage("Setup", "Setup is already complete"));
    return;
  }
  ctx.state.gate?.endGrant();
  ctx.state.gate = undefined;
  deps.log.info("setup complete", { apiOrigin: new URL(owner.apiUrl).origin, checks });
  ctx.cookies.push(serializeCookieDeletion("setup", deps.mode));
  // The password was set in this request, which is the proof for the enrolment session.
  startSession(ctx, outcome.userId, { stage: "enrol" });
  redirect(ctx, "/account/authenticator");
}

/**
 * The CSRF field must hold the session's token. Without a valid session the request still runs
 * the POST order with no expected token, so it changes nothing.
 */
async function postSignOut(ctx: Ctx): Promise<void> {
  const live = ctx.current;
  if (live === undefined) {
    await postSignOutWithoutSession(ctx);
    return;
  }
  const csrf = live.session.csrfToken;
  const fields = await readPostForm(ctx, SIGN_OUT_FIELDS, csrf);
  if (fields === undefined) return;
  const refusal = {
    reopenHref: "/",
    expiredPage: () => signOutExpiredPage(ctx, { id: live.id, session: live.session }),
  };
  if (!acceptFormToken(ctx, fields.form_token, sessionBinding(live.id), refusal)) return;
  ctx.deps.store.deleteSession(live.id);
  ctx.cookies.push(serializeCookieDeletion("session", ctx.deps.mode));
  redirect(ctx, "/sign-in");
}

function signOutExpiredPage(ctx: Ctx, live: { id: string; session: Session }): string {
  const user = ctx.deps.store.userById(live.session.userId);
  if (user === undefined) return messagePage("Sign out", formExpiredResendNotice);
  const signedIn = { id: live.id, user, csrf: live.session.csrfToken };
  return signedInPage(ctx, signedIn, {
    title: "Sign out",
    body: paragraph(formExpiredResendNotice, ' role="alert"'),
  });
}

/**
 * No session token exists to compare, so there is no CSRF step. A token already used on
 * /sign-out is a replay; anything else changes nothing and goes to sign-in as before.
 */
async function postSignOutWithoutSession(ctx: Ctx): Promise<void> {
  const fields = await readFormFields(ctx, SIGN_OUT_FIELDS);
  if (fields === undefined) return;
  if (ctx.state.formTokens.wasUsed(fields.form_token ?? "", "/sign-out")) {
    logRefusedToken(ctx, "replayed");
    sendHtml(ctx, 409, alreadySubmittedPage("/sign-in"));
    return;
  }
  redirect(ctx, "/sign-in");
}

async function postSignIn(ctx: Ctx): Promise<void> {
  const fields = await readPostForm(ctx, SIGN_IN_FIELDS);
  if (fields === undefined) return;
  const csrf = csrfOf(fields);
  const next = safeNext(fields.next);
  const formPage = (error: string): string => signInPage({ ...anonForm(ctx, csrf), next, error });
  // Normalized as in setup: trimmed and lowercased.
  const email = (fields.email ?? "").trim().toLowerCase();
  const password = fields.password ?? "";
  if (email === "" || !isSignInPasswordAcceptable(password)) {
    const error = "Enter your email and your password (at most 128 characters).";
    sendHtml(ctx, 422, formPage(error));
    return;
  }
  const { deps } = ctx;
  const client = clientKeyOf(ctx.req.socket.remoteAddress);
  const admission = ctx.state.signInThrottle.admit({ account: email, client });
  if (!admission.isAdmitted) {
    deps.log.warn("sign-in failed", { client, reason: "throttled" });
    deps.metrics.recordAuthAttempt("sign-in", "throttled");
    const page = formPage("Too many attempts. Try again later.");
    sendHtml(ctx, 429, page, { "retry-after": String(admission.retryAfterSeconds) });
    return;
  }
  let user: User | undefined;
  let isValid: boolean;
  try {
    user = deps.store.userByEmail(email);
    isValid = await deps.verifier.verify(password, user?.passwordHash);
  } catch (err) {
    admission.attempt.release();
    throw err;
  }
  if (!isValid || user === undefined) {
    admission.attempt.fail();
    deps.log.warn("sign-in failed", { client, reason: "credentials" });
    deps.metrics.recordAuthAttempt("sign-in", "failure");
    sendHtml(ctx, 401, formPage(WRONG_CREDENTIALS));
    return;
  }
  const refusal = { reopenHref: "/sign-in", expiredPage: () => formPage(formExpiredResendNotice) };
  if (!acceptFormToken(ctx, fields.form_token, anonBinding(csrf), refusal)) {
    admission.attempt.release();
    return;
  }
  const stage = passwordStage(ctx, user);
  try {
    startSession(ctx, user.id, stage === "full" ? { stage } : { stage, nextPath: next });
  } catch (err) {
    // A failed session write must not hold the reservation: it would lock the owner out.
    admission.attempt.release();
    throw err;
  }
  // Only the password throttle succeeds here; the factor throttle is untouched.
  admission.attempt.succeed();
  deps.log.info("password accepted", { userId: user.id, stage });
  deps.metrics.recordAuthAttempt("sign-in", "success");
  redirect(ctx, stageTarget(stage, next));
}

function passwordStage(ctx: Ctx, user: User): SessionStage {
  return signInStage({
    isRequired: isSecondFactorRequired(user, organisationOf(ctx)),
    hasAuthenticator: ctx.deps.factorStore.authenticator(user.id) !== undefined,
  });
}

function stageTarget(stage: SessionStage, next: string): string {
  switch (stage) {
    case "factor":
      return "/sign-in/factor";
    case "enrol":
      return "/account/authenticator";
    case "full":
      return next;
    default: {
      const never: never = stage;
      return never;
    }
  }
}

/** Rotation: the old session row goes, expired rows go, then a new id is made. */
function startSession(ctx: Ctx, userId: number, options: NewSessionOptions): void {
  const { store, now } = ctx.deps;
  const old = cookieOf(ctx, "session");
  if (old !== undefined) store.deleteSession(old);
  const time = now();
  store.deleteExpiredSessions(time, SESSION_IDLE_MS);
  const id = newToken(ctx);
  store.createSession(id, userId, newToken(ctx), time, options);
  pushSessionCookie(ctx, id, options.stage);
}

async function handlePost(ctx: Ctx): Promise<void> {
  switch (ctx.path) {
    case "/setup":
      await postSetupCode(ctx);
      return;
    case "/setup/owner":
      await postSetupOwner(ctx);
      return;
    case "/sign-in":
      await postSignIn(ctx);
      return;
    case "/sign-out":
      await postSignOut(ctx);
      return;
    case "/sign-in/factor":
      await postFactor(ctx);
      return;
    case "/account/authenticator":
      await postAuthenticator(ctx);
      return;
    case "/account/recovery-codes":
      await postNewCodes(ctx);
      return;
    case "/account/sessions/sign-out-all":
      await postSignOutAll(ctx);
      return;
    default:
      sendText(ctx, 404, NOT_FOUND);
  }
}

/**
 * Step 2 of the order: setup routes close after setup; sign-in has no POST before it, and the
 * second-factor and account routes do not exist before it.
 */
function isClosedInPhase(path: string, route: Route, method: string, isSetUp: boolean): boolean {
  if (path === "/setup" || path === "/setup/owner") return isSetUp;
  if (route.isNewInPhase2 === true) return !isSetUp;
  return path === "/sign-in" && method === "POST" && !isSetUp;
}

function allowedMethods(route: ProtectedRoute): string[] {
  const methods: string[] = [...route.methods];
  if (methods.includes("GET") && !methods.includes("HEAD")) methods.splice(1, 0, "HEAD");
  return methods;
}

function isHostRefused(ctx: Ctx): boolean {
  return ctx.deps.mode === "loopback" && !isLoopbackHost(ctx.req.headers.host);
}

function sendShell(ctx: Ctx, signedIn: SignedIn, status: number, page: ShellPart): void {
  sendHtml(ctx, status, signedInPage(ctx, shellOf(signedIn), page));
}

function sendPageResult(ctx: Ctx, signedIn: SignedIn, route: ProtectedRoute, result: PageResult) {
  if (result.kind === "redirect") {
    if (result.isSessionCleared === true) {
      ctx.cookies.push(serializeCookieDeletion("session", ctx.deps.mode));
    }
    redirect(ctx, result.location);
    return;
  }
  sendShell(ctx, signedIn, result.status, { ...result, navId: route.navId });
}

function pageRequest(
  ctx: Ctx,
  signedIn: SignedIn,
  method: PageMethod,
  fields: PageRequest["fields"],
): PageRequest {
  return {
    method,
    path: ctx.path,
    user: signedIn.user,
    sessionId: signedIn.id,
    linkOrigin: linkOrigin(ctx.deps.publicOrigin, ctx.req.headers.host),
    role: roleOfUser(ctx, signedIn.user),
    csrf: signedIn.session.csrfToken,
    fields,
    query: ctx.query,
    issueFormToken: (actionPath) => issueFormToken(ctx, sessionBinding(signedIn.id), actionPath),
  };
}

/**
 * Step 7 of the protected order. A refused token answers 409 here: "already submitted" for a
 * replay, else the route's form again with the expired notice.
 */
function isProtectedTokenAccepted(
  ctx: Ctx,
  signedIn: SignedIn,
  route: ProtectedRoute,
  request: PageRequest,
): boolean {
  const token = request.fields.form_token ?? "";
  const result = ctx.state.formTokens.consume(token, sessionBinding(signedIn.id), ctx.path);
  if (result === "accepted") return true;
  logRefusedToken(ctx, result);
  if (result === "replayed") {
    const reopenHref = route.methods.includes("GET") ? ctx.path : "/";
    sendShell(ctx, signedIn, 409, {
      title: "Already submitted",
      body: alreadySubmittedState({ reopenHref }),
    });
    return false;
  }
  const form = route.renderForm?.(request, formExpiredNotice) ?? {
    kind: "page",
    status: 409,
    title: "Form expired",
    body: paragraph(formExpiredNotice, ' role="alert"'),
  };
  sendPageResult(ctx, signedIn, route, form.kind === "page" ? { ...form, status: 409 } : form);
  return false;
}

/**
 * Steps 2 to 8 of the protected order (Required behavior 1): phase, Host, session, the POST
 * form with CSRF, role, form token, handler.
 */
async function handleProtected(
  ctx: Ctx,
  route: ProtectedRoute,
  method: PageMethod,
  isSetUp: boolean,
): Promise<void> {
  if (!isSetUp) {
    if (method === "POST") sendText(ctx, 404, NOT_FOUND);
    else redirect(ctx, "/setup");
    return;
  }
  if (isHostRefused(ctx)) {
    sendText(ctx, 421, MISDIRECTED);
    return;
  }
  if (!passesGate(ctx, "full")) return;
  const signedIn = signedInOf(ctx);
  if (signedIn === undefined) return;
  let fields: PageRequest["fields"] = {};
  if (method === "POST") {
    const known = [...(route.knownFields ?? []), "form_token"];
    const read = await readPostForm(ctx, known, signedIn.session.csrfToken);
    if (read === undefined) return;
    fields = read;
  }
  const role = roleOfUser(ctx, signedIn.user);
  if (!hasRole(role, route.requiredRole)) {
    sendShell(ctx, signedIn, 403, {
      title: "Access denied",
      body: forbiddenState({ requiredRole: route.requiredRole, role }),
    });
    return;
  }
  const request = pageRequest(ctx, signedIn, method, fields);
  if (method === "POST" && !isProtectedTokenAccepted(ctx, signedIn, route, request)) return;
  sendPageResult(ctx, signedIn, route, await route.handle(request));
}

/** Decision 9: the shell 404 for a signed-in GET or HEAD, else the plain text 404. */
function sendNotFound(ctx: Ctx, method: string, isSetUp: boolean): void {
  const isPage = (method === "GET" || method === "HEAD") && isSetUp && !isHostRefused(ctx);
  const signedIn = isPage ? signedInOf(ctx) : undefined;
  if (signedIn === undefined) {
    sendText(ctx, 404, NOT_FOUND);
    return;
  }
  touch(ctx, signedIn);
  sendShell(ctx, signedIn, 404, { title: "Page not found", body: notFoundState() });
}

function isPageMethod(method: string): method is PageMethod {
  return method === "GET" || method === "HEAD" || method === "POST";
}

const LINK_METHODS: readonly string[] = ["GET", "HEAD", "POST"];

/**
 * A public link route: method, phase (404 before setup), loopback Host, then the route's own
 * order. No step reads the session cookie before the commit.
 */
async function handleInviteLink(
  ctx: Ctx,
  method: string,
  isSetUp: boolean,
  token: string,
): Promise<void> {
  if (!LINK_METHODS.includes(method)) {
    ctx.res.writeHead(405, { allow: LINK_METHODS.join(", "), "content-length": 0 }).end();
    return;
  }
  if (!isSetUp) {
    sendText(ctx, 404, NOT_FOUND);
    return;
  }
  if (isHostRefused(ctx)) {
    sendText(ctx, 421, MISDIRECTED);
    return;
  }
  if (method === "POST") await postInvite(ctx, token, startSession);
  else sendInviteForm(ctx, token);
}

async function handleApp(ctx: Ctx): Promise<void> {
  const method = ctx.req.method ?? "GET";
  const isSetUp = ctx.deps.store.instance() !== undefined;
  const link = linkOfPath(ctx.path);
  if (link?.kind === "invite") {
    await handleInviteLink(ctx, method, isSetUp, link.token);
    return;
  }
  if (isLinkPrefixedPath(ctx.path)) {
    sendText(ctx, 404, NOT_FOUND);
    return;
  }
  const protectedRoute = ctx.state.protectedRoutes.get(ctx.path);
  const route = ROUTES[ctx.path];
  const allowed = protectedRoute === undefined ? route?.methods : allowedMethods(protectedRoute);
  if (allowed === undefined) {
    ctx.current = currentSession(ctx);
    sendNotFound(ctx, method, isSetUp);
    return;
  }
  if (!allowed.includes(method)) {
    ctx.res.writeHead(405, { allow: allowed.join(", "), "content-length": 0 }).end();
    return;
  }
  if (protectedRoute !== undefined && isPageMethod(method)) {
    await handleProtected(ctx, protectedRoute, method, isSetUp);
    return;
  }
  if (route === undefined) return;
  if (isClosedInPhase(ctx.path, route, method, isSetUp)) {
    sendText(ctx, 404, NOT_FOUND);
    return;
  }
  if (isHostRefused(ctx)) {
    sendText(ctx, 421, MISDIRECTED);
    return;
  }
  if (isSetUp && !passesGate(ctx, route.access)) return;
  if (method === "POST") await handlePost(ctx);
  else handleGet(ctx, isSetUp);
}

/** The protected routes: `/` and the test routes, whose keys must be under /__test/. */
function protectedRoutesOf(deps: ConsoleServerDeps): Map<string, ProtectedRoute> {
  const routes = new Map<string, ProtectedRoute>([["/", overviewRoute(deps)]]);
  for (const route of teamRoutes(deps)) routes.set(route.path, route);
  for (const [key, route] of deps.testRoutes ?? []) {
    const isProduction = key in ROUTES || OPS_PATHS.includes(key);
    if (!key.startsWith(TEST_PREFIX) || isProduction || route.path !== key) {
      throw new TestRouteError(`test route ${key} must be a path under ${TEST_PREFIX}`);
    }
    routes.set(key, route);
  }
  return routes;
}

function handleOpsRoute(req: IncomingMessage, res: ServerResponse, ops: OpsHandlers): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD", "content-length": 0 }).end();
    return;
  }
  handleOps(req, res, ops);
}

/** The console HTTP server: setup pages, the stylesheet, the ops routes, 404 and 405. */
export function createConsoleServer(deps: ConsoleServerDeps): Server {
  const { metrics } = deps;
  const ops: OpsHandlers = {
    ready: () => (metrics.isReady() ? { ready: true } : { ready: false, reason: "shutting down" }),
    metrics: () => metrics.render(),
    allowHead: true,
  };
  const state: State = {
    gate: deps.gate,
    setupThrottle: createAuthThrottle({ now: deps.now, tables: ["client"], clearsOnSuccess: [] }),
    signInThrottle: createAuthThrottle({
      now: deps.now,
      tables: ["account", "client"],
      clearsOnSuccess: ["account"],
    }),
    // Second factors have their own limiter: a correct password never clears it.
    factorThrottle: createAuthThrottle({
      now: deps.now,
      tables: ["account", "client"],
      clearsOnSuccess: ["account"],
    }),
    formTokens: createFormTokens({ now: deps.now, randomBytes: deps.randomBytes }),
    protectedRoutes: protectedRoutesOf(deps),
  };
  return createServer((req, res) => {
    const path = rawPath(req);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    res.once("finish", () => metrics.recordRequest(pathLabel(path), res.statusCode));
    if (OPS_PATHS.includes(path)) {
      handleOpsRoute(req, res, ops);
      return;
    }
    const ctx: Ctx = {
      req,
      res,
      path,
      query: rawQuery(req),
      deps,
      state,
      cookies: [],
      current: undefined,
    };
    handleApp(ctx).catch((err: unknown) => {
      deps.log.error("request failed", { error: err instanceof Error ? err.name : "unknown" });
      if (!res.headersSent) {
        res.removeHeader("set-cookie");
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end(req.method === "HEAD" ? undefined : "internal error\n");
    });
  });
}

function errorCode(err: unknown): string {
  const code: unknown = typeof err === "object" && err !== null ? Reflect.get(err, "code") : "";
  return typeof code === "string" && ERROR_CODE.test(code) ? code : "unknown";
}

/** Listens and resolves with the bound port. A bind failure names the code only. */
export function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      reject(
        new StartupError(
          `PULSE_CONSOLE_HOST/PULSE_CONSOLE_PORT: cannot listen on ${host}:${port} (${errorCode(err)})`,
          { setting: "PULSE_CONSOLE_PORT", cause: err },
        ),
      );
    });
    server.listen(port, host, () => {
      // Listening on a TCP host and port, so the address is never a string or null.
      resolve((server.address() as AddressInfo).port);
    });
  });
}
