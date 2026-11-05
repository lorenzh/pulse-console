import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { clientKeyOf, handleOps, type OpsHandlers, StartupError } from "@lorenzh/pulse-kit";
import { postAuthenticator, sendAuthenticator, sendNotYet } from "./account-routes.ts";
import {
  type AccountStore,
  isSessionLive,
  type NewSessionOptions,
  SESSION_IDLE_MS,
  type SessionStage,
  type User,
} from "./account-store.ts";
import { createAuthThrottle } from "./auth-throttle.ts";
import { NO_TOKEN_TEXT, testConnection } from "./connection-test.ts";
import { serializeCookie, serializeCookieDeletion } from "./cookies.ts";
import { checkApiUrl, checkEmail, checkName, type FormFields, passwordText } from "./forms.ts";
import {
  type ConsoleServerDeps,
  type Ctx,
  type Current,
  cookieOf,
  currentOf,
  ensureCsrf,
  NOT_FOUND,
  newToken,
  pushSessionCookie,
  readPostForm,
  redirect,
  type State,
  send,
  sendHtml,
  sendText,
} from "./http-context.ts";
import type { PathLabel } from "./metrics.ts";
import {
  type ConnectionView,
  landingPage,
  messagePage,
  type OwnerErrors,
  type OwnerValues,
  setupCodePage,
  setupOwnerPage,
  signInPage,
} from "./pages.ts";
import { isSignInPasswordAcceptable } from "./passwords.ts";
import { isLoopbackHost, safeNext } from "./request-guard.ts";
import { postFactor, sendFactorForm } from "./sign-in-factor.ts";
import { CONSOLE_CSS } from "./styles.ts";
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
const ROUTES: Readonly<Record<string, Route>> = {
  "/": { methods: ["GET", "HEAD"], access: "full" },
  "/setup": { methods: ["GET", "HEAD", "POST"], access: "public" },
  "/setup/owner": { methods: ["GET", "HEAD", "POST"], access: "public" },
  "/sign-in": { methods: ["GET", "HEAD", "POST"], access: "public" },
  "/sign-out": { methods: ["POST"], access: "any-session" },
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

const CODE_FIELDS = ["code", "csrf"] as const;
const OWNER_FIELDS = [
  "api_url",
  "email",
  "name",
  "password",
  "password_confirm",
  "action",
  "csrf",
] as const;
const SIGN_OUT_FIELDS = ["csrf"] as const;
const SIGN_IN_FIELDS = ["email", "password", "next"] as const;
const SESSION_TOUCH_MS = 60_000;
const WRONG_CREDENTIALS = "Wrong email or password.";
const EXPIRED = "Your session has expired.";

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
      return path;
    default:
      return "other";
  }
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
    isSecondFactorRequired(user) &&
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
  const target = gateTarget(access, current?.stage ?? "anonymous", ctx.path);
  if (target !== undefined) {
    redirect(ctx, target);
    return false;
  }
  ctx.current = current;
  if (current !== undefined && access !== "public") touch(ctx, current);
  return true;
}

// Before setup the gate does not run, so "/" keeps its #562 redirect to /setup.
function sendLanding(ctx: Ctx, isSetUp: boolean): void {
  if (!isSetUp) {
    redirect(ctx, "/setup");
    return;
  }
  const signedIn = currentOf(ctx);
  const apiUrl = ctx.deps.store.instance()?.apiUrl ?? ctx.deps.defaultApiUrl;
  const page = landingPage({
    csrf: signedIn.session.csrfToken,
    name: signedIn.user.name,
    email: signedIn.user.email,
    apiOrigin: new URL(apiUrl).origin,
  });
  sendHtml(ctx, 200, page);
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

function handleGet(ctx: Ctx, isSetUp: boolean): void {
  switch (ctx.path) {
    case "/":
      sendLanding(ctx, isSetUp);
      return;
    case "/setup":
      sendHtml(ctx, 200, setupCodePage({ csrf: ensureCsrf(ctx) }));
      return;
    case "/setup/owner":
      if (!hasGrant(ctx)) redirect(ctx, "/setup");
      else
        sendHtml(
          ctx,
          200,
          setupOwnerPage({
            csrf: ensureCsrf(ctx),
            values: ownerDefaults(ctx),
            connection: missingTokenView(ctx),
          }),
        );
      return;
    case "/sign-in":
      sendSignInForm(ctx, isSetUp);
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
      sendNotYet(ctx);
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
  sendHtml(ctx, 200, signInPage({ csrf: ensureCsrf(ctx), next, notice }));
}

function signInNotice(ctx: Ctx): string | undefined {
  if (cookieOf(ctx, "session") !== undefined && ctx.current === undefined) {
    // The cookie names no valid session here, so the notice shows and the cookie is cleared.
    ctx.cookies.push(serializeCookieDeletion("session", ctx.deps.mode));
    return EXPIRED;
  }
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
  const check = gate.checkCode(fields.code ?? "");
  if (check === "empty") {
    sendHtml(ctx, 422, setupCodePage({ csrf, error: "Enter the setup code." }));
    return;
  }
  const client = clientKeyOf(ctx.req.socket.remoteAddress);
  const admission = ctx.state.setupThrottle.admit({ client });
  if (!admission.isAdmitted) {
    ctx.deps.log.warn("setup code refused", { client, reason: "throttled" });
    ctx.deps.metrics.recordAuthAttempt("setup-code", "throttled");
    const page = setupCodePage({ csrf, error: "Too many attempts. Try again later." });
    sendHtml(ctx, 429, page, { "retry-after": String(admission.retryAfterSeconds) });
    return;
  }
  if (check === "mismatch") {
    admission.attempt.fail();
    ctx.deps.log.warn("setup code refused", { client, reason: "credentials" });
    ctx.deps.metrics.recordAuthAttempt("setup-code", "failure");
    sendHtml(ctx, 401, setupCodePage({ csrf, error: "Wrong setup code." }));
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
  if (action !== "test" && !isComplete) {
    sendHtml(ctx, 422, setupOwnerPage({ csrf, values, errors, message: "Choose an action." }));
    return;
  }
  if (Object.keys(errors).length > 0) {
    sendHtml(ctx, 422, setupOwnerPage({ csrf, values, errors }));
    return;
  }
  const { fetch, adminToken: token, schedule } = ctx.deps;
  const result = await testConnection(
    owner.apiUrl,
    schedule === undefined ? { fetch, token } : { fetch, token, schedule },
  );
  if (!result.isOk) {
    const connection: ConnectionView = { isOk: false, text: result.text };
    sendHtml(ctx, 502, setupOwnerPage({ csrf, values, connection }));
    return;
  }
  const connection: ConnectionView = {
    isOk: true,
    checkCount: result.checkCount,
    isScopeChecked: result.adminScope === "confirmed",
  };
  if (!isComplete) {
    sendHtml(ctx, 200, setupOwnerPage({ csrf, values, connection }));
    return;
  }
  await commitSetup(ctx, owner, result.checkCount, { csrf, values, connection });
}

async function commitSetup(
  ctx: Ctx,
  owner: ValidOwner,
  checks: number,
  view: { csrf: string; values: OwnerValues; connection: ConnectionView },
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
    sendHtml(ctx, 500, setupOwnerPage({ ...view, message: "Setup could not be saved." }));
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
    redirect(ctx, "/sign-in");
    return;
  }
  const fields = await readPostForm(ctx, SIGN_OUT_FIELDS, live.session.csrfToken);
  if (fields === undefined) return;
  ctx.deps.store.deleteSession(live.id);
  ctx.cookies.push(serializeCookieDeletion("session", ctx.deps.mode));
  redirect(ctx, "/sign-in");
}

async function postSignIn(ctx: Ctx): Promise<void> {
  const fields = await readPostForm(ctx, SIGN_IN_FIELDS);
  if (fields === undefined) return;
  const csrf = csrfOf(fields);
  const next = safeNext(fields.next);
  // Normalized as in setup: trimmed and lowercased.
  const email = (fields.email ?? "").trim().toLowerCase();
  const password = fields.password ?? "";
  if (email === "" || !isSignInPasswordAcceptable(password)) {
    const error = "Enter your email and your password (at most 128 characters).";
    sendHtml(ctx, 422, signInPage({ csrf, next, error }));
    return;
  }
  const { deps } = ctx;
  const client = clientKeyOf(ctx.req.socket.remoteAddress);
  const admission = ctx.state.signInThrottle.admit({ account: email, client });
  if (!admission.isAdmitted) {
    deps.log.warn("sign-in failed", { client, reason: "throttled" });
    deps.metrics.recordAuthAttempt("sign-in", "throttled");
    const page = signInPage({ csrf, next, error: "Too many attempts. Try again later." });
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
    sendHtml(ctx, 401, signInPage({ csrf, next, error: WRONG_CREDENTIALS }));
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
    isRequired: isSecondFactorRequired(user),
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
    default:
      sendNotYet(ctx);
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

async function handleApp(ctx: Ctx): Promise<void> {
  const method = ctx.req.method ?? "GET";
  const route = ROUTES[ctx.path];
  if (route === undefined) {
    sendText(ctx, 404, NOT_FOUND);
    return;
  }
  if (!route.methods.includes(method)) {
    ctx.res.writeHead(405, { allow: route.methods.join(", "), "content-length": 0 }).end();
    return;
  }
  const isSetUp = ctx.deps.store.instance() !== undefined;
  if (isClosedInPhase(ctx.path, route, method, isSetUp)) {
    sendText(ctx, 404, NOT_FOUND);
    return;
  }
  if (ctx.deps.mode === "loopback" && !isLoopbackHost(ctx.req.headers.host)) {
    sendText(ctx, 421, MISDIRECTED);
    return;
  }
  if (isSetUp && !passesGate(ctx, route.access)) return;
  if (method === "POST") await handlePost(ctx);
  else handleGet(ctx, isSetUp);
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
