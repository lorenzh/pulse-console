import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BodyError,
  clientKeyOf,
  handleOps,
  type Logger,
  type OpsHandlers,
  readBody,
  StartupError,
} from "@lorenzh/pulse-kit";
import { type AccountStore, type Session, sessionDigest, type User } from "./account-store.ts";
import { type AuthThrottle, createAuthThrottle } from "./auth-throttle.ts";
import { type FetchLike, NO_TOKEN_TEXT, testConnection } from "./connection-test.ts";
import { CONSOLE_JS } from "./console-script.ts";
import { readCookie, serializeCookie, serializeCookieDeletion } from "./cookies.ts";
import { createFormTokens, type FormTokenResult, type FormTokens } from "./form-tokens.ts";
import {
  checkApiUrl,
  checkEmail,
  checkName,
  type FormFields,
  isFormContentType,
  MAX_FORM_BYTES,
  type ParsedForm,
  parseForm,
  passwordText,
} from "./forms.ts";
import { paragraph } from "./html.ts";
import type { Metrics, PathLabel } from "./metrics.ts";
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
import {
  type CredentialVerifier,
  type HashPassword,
  isSignInPasswordAcceptable,
} from "./passwords.ts";
import type { PageMethod, PageRequest, PageResult, ProtectedRoute } from "./protected-route.ts";
import {
  expectedOrigin,
  isCsrfTokenValid,
  isLoopbackHost,
  isOriginAllowed,
  safeNext,
} from "./request-guard.ts";
import { type ConsoleRole, hasRole } from "./roles.ts";
import type { ConsoleMode } from "./settings.ts";
import type { SetupGate } from "./setup-code.ts";
import { shellPage } from "./shell.ts";
import {
  alreadySubmittedState,
  forbiddenState,
  formExpiredNotice,
  formExpiredResendNotice,
  notFoundState,
} from "./states.ts";
import { CONSOLE_CSS } from "./styles.ts";

export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};
const NOT_FOUND = "not found\n";
const MISDIRECTED = "misdirected request: set PULSE_CONSOLE_PUBLIC_URL to serve this host\n";
const REFUSED = "Request refused. Reload the page and try again.";
const ERROR_CODE = /^E[A-Z0-9_]+$/;
const TOKEN_BYTES = 32;

const OPS_PATHS: readonly string[] = ["/healthz", "/readyz", "/metrics"];
const TEST_PREFIX = "/__test/";
const ROUTES: Readonly<Record<string, readonly string[]>> = {
  "/": ["GET", "HEAD"],
  "/setup": ["GET", "HEAD", "POST"],
  "/setup/owner": ["GET", "HEAD", "POST"],
  "/sign-in": ["GET", "HEAD", "POST"],
  "/sign-out": ["POST"],
  "/console.css": ["GET", "HEAD"],
  "/console.js": ["GET", "HEAD"],
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
const SESSION_IDLE_MS = 2_592_000_000;
const SESSION_TOUCH_MS = 60_000;
const WRONG_CREDENTIALS = "Wrong email or password.";
const EXPIRED = "Your session has expired.";

export interface ConsoleServerDeps {
  metrics: Metrics;
  log: Logger;
  /** The name in the shell header and the page titles. */
  instanceName: string;
  mode: ConsoleMode;
  publicOrigin: string | undefined;
  /** PULSE_API_URL: the default of the setup form. */
  defaultApiUrl: string;
  adminToken: string | undefined;
  store: AccountStore;
  /** The setup gate; undefined when the console was set up at start. */
  gate: SetupGate | undefined;
  now: () => number;
  randomBytes: (size: number) => Uint8Array;
  hashPassword: HashPassword;
  /** Checks a sign-in password; an unknown account runs the dummy verification. */
  verifier: CredentialVerifier;
  fetch: FetchLike;
  schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
  /** Test-only protected routes under /__test/. `main.ts` never sets them. */
  testRoutes?: ReadonlyMap<string, ProtectedRoute> | undefined;
  /** The role of a user. Defaults to `user.role`; only a test passes another. */
  roleOf?: ((user: User) => ConsoleRole) | undefined;
}

/** A test route key outside /__test/ or on a production path. */
export class TestRouteError extends Error {
  override name = "TestRouteError";
}

type State = {
  gate: SetupGate | undefined;
  setupThrottle: AuthThrottle<"client">;
  signInThrottle: AuthThrottle<"account" | "client">;
  formTokens: FormTokens;
  protectedRoutes: ReadonlyMap<string, ProtectedRoute>;
};

type SignedIn = { id: string; session: Session; user: User };

type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  query: URLSearchParams;
  deps: ConsoleServerDeps;
  state: State;
  cookies: string[];
};

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
    case "/console.js":
      return path;
    default:
      return "other";
  }
}

function send(
  ctx: Ctx,
  status: number,
  contentType: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  if (ctx.cookies.length > 0) ctx.res.setHeader("set-cookie", ctx.cookies);
  ctx.res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  ctx.res.end(ctx.req.method === "HEAD" ? undefined : body);
}

function sendHtml(ctx: Ctx, status: number, html: string, headers?: Record<string, string>): void {
  send(ctx, status, "text/html; charset=utf-8", html, headers);
}

function sendText(ctx: Ctx, status: number, text: string): void {
  send(ctx, status, "text/plain; charset=utf-8", text);
}

function redirect(ctx: Ctx, location: string): void {
  if (ctx.cookies.length > 0) ctx.res.setHeader("set-cookie", ctx.cookies);
  ctx.res.writeHead(303, { location, "cache-control": "no-store", "content-length": 0 });
  ctx.res.end();
}

function newToken(ctx: Ctx): string {
  return Buffer.from(ctx.deps.randomBytes(TOKEN_BYTES)).toString("base64url");
}

function cookieOf(ctx: Ctx, kind: "csrf" | "setup" | "session"): string | undefined {
  return readCookie(ctx.req.headers.cookie, kind, ctx.deps.mode);
}

/** The anonymous CSRF token of this client; a GET of a form page sets it when it is missing. */
function ensureCsrf(ctx: Ctx): string {
  const existing = cookieOf(ctx, "csrf");
  if (existing !== undefined) return existing;
  const token = newToken(ctx);
  ctx.cookies.push(serializeCookie("csrf", token, ctx.deps.mode));
  return token;
}

/** The live session row of this request's cookie, without touching it. */
function liveSession(ctx: Ctx): { id: string; session: Session } | undefined {
  const id = cookieOf(ctx, "session");
  if (id === undefined) return undefined;
  const session = ctx.deps.store.session(id);
  if (session === undefined || ctx.deps.now() >= session.lastSeenAt + SESSION_IDLE_MS) {
    return undefined;
  }
  return { id, session };
}

/**
 * The signed-in user of this request, or undefined. A touch after 60000 ms also refreshes the
 * session cookie with the same value.
 */
function signedInOf(ctx: Ctx): SignedIn | undefined {
  const live = liveSession(ctx);
  if (live === undefined) return undefined;
  const user = ctx.deps.store.userById(live.session.userId);
  if (user === undefined) return undefined;
  const now = ctx.deps.now();
  if (now - live.session.lastSeenAt >= SESSION_TOUCH_MS) {
    ctx.deps.store.touchSession(live.id, now);
    ctx.cookies.push(serializeCookie("session", live.id, ctx.deps.mode));
  }
  return { ...live, user };
}

function anonBinding(csrf: string): string {
  return `a:${createHash("sha256").update(csrf).digest("hex")}`;
}

function sessionBinding(sessionId: string): string {
  return `s:${sessionDigest(sessionId)}`;
}

/** A fresh form token; a HEAD answer sends no body, so it stores nothing. */
function issueFormToken(ctx: Ctx, binding: string, path: string): string {
  return ctx.req.method === "HEAD" ? "" : ctx.state.formTokens.issue(binding, path);
}

function logRefusedToken(ctx: Ctx, reason: Exclude<FormTokenResult, "accepted">): void {
  ctx.deps.log.info("form token refused", { reason, path: ctx.path });
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
    requiredRole: "viewer",
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
    default:
      send(ctx, 200, "text/css; charset=utf-8", CONSOLE_CSS);
  }
}

function sendSignInForm(ctx: Ctx, isSetUp: boolean): void {
  if (!isSetUp) {
    redirect(ctx, "/setup");
    return;
  }
  if (signedInOf(ctx) !== undefined) {
    redirect(ctx, "/");
    return;
  }
  const notice = signInNotice(ctx);
  const next = safeNext(ctx.query.get("next") ?? undefined);
  sendHtml(ctx, 200, signInPage({ ...anonForm(ctx, ensureCsrf(ctx)), next, notice }));
}

function signInNotice(ctx: Ctx): string | undefined {
  if (cookieOf(ctx, "session") !== undefined) {
    // The cookie names no valid session here, so the notice shows and the cookie is cleared.
    ctx.cookies.push(serializeCookieDeletion("session", ctx.deps.mode));
    return EXPIRED;
  }
  return ctx.query.get("setup") === "done" ? "Setup is complete. Sign in." : undefined;
}

async function readBodyOrFail(ctx: Ctx): Promise<string | undefined> {
  try {
    return await readBody(ctx.req, MAX_FORM_BYTES);
  } catch (err) {
    if (!(err instanceof BodyError)) throw err;
    ctx.res.setHeader("connection", "close");
    sendText(ctx, err.status, err.status === 413 ? "request body too large\n" : "bad request\n");
    return undefined;
  }
}

/**
 * Steps 4 to 7 of the POST order: Origin, content type, body size and repeated fields. It
 * answers the first failure and returns undefined then.
 */
async function readFormFields<K extends string>(
  ctx: Ctx,
  known: readonly K[],
): Promise<FormFields<K | "csrf"> | undefined> {
  const { req, deps } = ctx;
  const origin = expectedOrigin(deps.mode, req.headers.host, deps.publicOrigin);
  if (!isOriginAllowed(req.headers.origin, origin)) {
    sendHtml(ctx, 403, messagePage("Request refused", REFUSED));
    return undefined;
  }
  if (!isFormContentType(req.headers["content-type"])) {
    sendText(ctx, 415, "unsupported content type\n");
    return undefined;
  }
  const body = await readBodyOrFail(ctx);
  if (body === undefined) return undefined;
  const parsed: ParsedForm<K | "csrf"> = parseForm<K | "csrf">(body, [...known, "csrf"]);
  if (!parsed.isOk) {
    sendText(ctx, 400, "repeated form field\n");
    return undefined;
  }
  return parsed.fields;
}

/** Steps 4 to 8 of the POST order: `readFormFields`, then the CSRF token. */
async function readPostForm<K extends string>(
  ctx: Ctx,
  known: readonly K[],
  expectedCsrf: string | undefined = cookieOf(ctx, "csrf"),
): Promise<FormFields<K | "csrf"> | undefined> {
  const fields = await readFormFields(ctx, known);
  if (fields === undefined) return undefined;
  if (!isCsrfTokenValid(fields.csrf, expectedCsrf)) {
    sendHtml(ctx, 403, messagePage("Request refused", REFUSED));
    return undefined;
  }
  return fields;
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
  redirect(ctx, "/sign-in?setup=done");
}

/**
 * The CSRF field must hold the session's token. Without a valid session the request still runs
 * the POST order with no expected token, so it changes nothing.
 */
async function postSignOut(ctx: Ctx): Promise<void> {
  const live = liveSession(ctx);
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
  try {
    startSession(ctx, user.id);
  } catch (err) {
    // A failed session write must not hold the reservation: it would lock the owner out.
    admission.attempt.release();
    throw err;
  }
  admission.attempt.succeed();
  deps.log.info("signed in", { userId: user.id });
  deps.metrics.recordAuthAttempt("sign-in", "success");
  redirect(ctx, next);
}

/** Rotation: the old session row goes, expired rows go, then a new id is made. */
function startSession(ctx: Ctx, userId: number): void {
  const { store, now, mode } = ctx.deps;
  const old = cookieOf(ctx, "session");
  if (old !== undefined) store.deleteSession(old);
  const time = now();
  store.deleteExpiredSessions(time, SESSION_IDLE_MS);
  const id = newToken(ctx);
  store.createSession(id, userId, newToken(ctx), time);
  ctx.cookies.push(serializeCookie("session", id, mode));
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
    default:
      await postSignOut(ctx);
  }
}

/** Step 2 of the order: setup routes close after setup; sign-in has no POST before it. */
function isClosedInPhase(path: string, method: string, isSetUp: boolean): boolean {
  if (path === "/setup" || path === "/setup/owner") return isSetUp;
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
    redirect(ctx, result.location);
    return;
  }
  sendShell(ctx, signedIn, result.status, { ...result, navId: route.navId });
}

/** Decision 8: back to sign-in with the raw target as `next` when it is a safe path. */
function redirectToSignIn(ctx: Ctx): void {
  const next = safeNext(ctx.req.url);
  redirect(ctx, `/sign-in?next=${encodeURIComponent(next)}`);
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
  const signedIn = signedInOf(ctx);
  if (signedIn === undefined) {
    redirectToSignIn(ctx);
    return;
  }
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
  sendShell(ctx, signedIn, 404, { title: "Page not found", body: notFoundState() });
}

function isPageMethod(method: string): method is PageMethod {
  return method === "GET" || method === "HEAD" || method === "POST";
}

async function handleApp(ctx: Ctx): Promise<void> {
  const method = ctx.req.method ?? "GET";
  const isSetUp = (): boolean => ctx.deps.store.instance() !== undefined;
  const route = ctx.state.protectedRoutes.get(ctx.path);
  const allowed = route === undefined ? ROUTES[ctx.path] : allowedMethods(route);
  if (allowed === undefined) {
    sendNotFound(ctx, method, isSetUp());
    return;
  }
  if (!allowed.includes(method)) {
    ctx.res.writeHead(405, { allow: allowed.join(", "), "content-length": 0 }).end();
    return;
  }
  if (route !== undefined && isPageMethod(method)) {
    await handleProtected(ctx, route, method, isSetUp());
    return;
  }
  if (isClosedInPhase(ctx.path, method, isSetUp())) {
    sendText(ctx, 404, NOT_FOUND);
    return;
  }
  if (isHostRefused(ctx)) {
    sendText(ctx, 421, MISDIRECTED);
    return;
  }
  if (method === "POST") await handlePost(ctx);
  else handleGet(ctx, isSetUp());
}

/** The protected routes: `/` and the test routes, whose keys must be under /__test/. */
function protectedRoutesOf(deps: ConsoleServerDeps): Map<string, ProtectedRoute> {
  const routes = new Map<string, ProtectedRoute>([["/", overviewRoute(deps)]]);
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
    const ctx: Ctx = { req, res, path, query: rawQuery(req), deps, state, cookies: [] };
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
