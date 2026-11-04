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
import type { AccountStore } from "./account-store.ts";
import { type AuthThrottle, createAuthThrottle } from "./auth-throttle.ts";
import { type FetchLike, testConnection } from "./connection-test.ts";
import { readCookie, serializeCookie, serializeCookieDeletion } from "./cookies.ts";
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
import type { Metrics, PathLabel } from "./metrics.ts";
import {
  type ConnectionView,
  messagePage,
  type OwnerErrors,
  type OwnerValues,
  setupCodePage,
  setupOwnerPage,
  signInPage,
} from "./pages.ts";
import type { HashPassword } from "./passwords.ts";
import {
  expectedOrigin,
  isCsrfTokenValid,
  isLoopbackHost,
  isOriginAllowed,
  safeNext,
} from "./request-guard.ts";
import type { ConsoleMode } from "./settings.ts";
import type { SetupGate } from "./setup-code.ts";
import { CONSOLE_CSS } from "./styles.ts";

export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};
const NOT_FOUND = "not found\n";
const MISDIRECTED = "misdirected request: set PULSE_CONSOLE_PUBLIC_URL to serve this host\n";
const REFUSED = "Request refused. Reload the page and try again.";
const ERROR_CODE = /^E[A-Z0-9_]+$/;
const TOKEN_BYTES = 32;

const OPS_PATHS: readonly string[] = ["/healthz", "/readyz", "/metrics"];
const ROUTES: Readonly<Record<string, readonly string[]>> = {
  "/": ["GET", "HEAD"],
  "/setup": ["GET", "HEAD", "POST"],
  "/setup/owner": ["GET", "HEAD", "POST"],
  "/sign-in": ["GET", "HEAD", "POST"],
  "/sign-out": ["POST"],
  "/console.css": ["GET", "HEAD"],
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

export interface ConsoleServerDeps {
  metrics: Metrics;
  log: Logger;
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
  fetch: FetchLike;
  schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
}

type State = { gate: SetupGate | undefined; setupThrottle: AuthThrottle<"client"> };

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

function hasGrant(ctx: Ctx): boolean {
  return ctx.state.gate?.isGrantValid(cookieOf(ctx, "setup")) ?? false;
}

function ownerDefaults(ctx: Ctx): OwnerValues {
  return { apiUrl: ctx.deps.defaultApiUrl, email: "", name: "" };
}

function handleGet(ctx: Ctx, isSetUp: boolean): void {
  switch (ctx.path) {
    case "/":
      redirect(ctx, isSetUp ? "/sign-in?next=%2F" : "/setup");
      return;
    case "/setup":
      sendHtml(ctx, 200, setupCodePage({ csrf: ensureCsrf(ctx) }));
      return;
    case "/setup/owner":
      if (!hasGrant(ctx)) redirect(ctx, "/setup");
      else
        sendHtml(ctx, 200, setupOwnerPage({ csrf: ensureCsrf(ctx), values: ownerDefaults(ctx) }));
      return;
    case "/sign-in":
      sendSignInForm(ctx, isSetUp);
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
  const notice = ctx.query.get("setup") === "done" ? "Setup is complete. Sign in." : undefined;
  const next = safeNext(ctx.query.get("next") ?? undefined);
  sendHtml(ctx, 200, signInPage({ csrf: ensureCsrf(ctx), next, notice }));
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
 * Steps 4 to 8 of the POST order: Origin, content type, body size, repeated fields and the
 * anonymous CSRF token. It answers the first failure and returns undefined then.
 */
async function readPostForm<K extends string>(
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
  if (!isCsrfTokenValid(parsed.fields.csrf, cookieOf(ctx, "csrf"))) {
    sendHtml(ctx, 403, messagePage("Request refused", REFUSED));
    return undefined;
  }
  return parsed.fields;
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

function validateOwner(
  fields: OwnerForm,
  isComplete: boolean,
): { owner: ValidOwner; errors: OwnerErrors } {
  const errors: OwnerErrors = {};
  const apiUrl = checkApiUrl(fields.api_url);
  const email = checkEmail(fields.email);
  const name = checkName(fields.name);
  const password = fields.password ?? "";
  if (!apiUrl.isOk) errors.apiUrl = apiUrl.text;
  // A test needs only the URL; the account fields are checked when setup completes.
  if (isComplete) {
    if (!email.isOk) errors.email = email.text;
    if (!name.isOk) errors.name = name.text;
    const text = passwordText(password, fields.password_confirm ?? "");
    if (text !== undefined) errors.password = text;
  }
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
  const { owner, errors } = validateOwner(fields, isComplete);
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
  redirect(ctx, "/sign-in?setup=done");
}

async function postSignOut(ctx: Ctx): Promise<void> {
  const fields = await readPostForm(ctx, SIGN_OUT_FIELDS);
  if (fields === undefined) return;
  redirect(ctx, "/sign-in");
}

async function handlePost(ctx: Ctx): Promise<void> {
  switch (ctx.path) {
    case "/setup":
      await postSetupCode(ctx);
      return;
    case "/setup/owner":
      await postSetupOwner(ctx);
      return;
    default:
      await postSignOut(ctx);
  }
}

/** Step 2 of the order: setup routes close after setup; sign-in has no POST before it. */
function isClosedInPhase(path: string, method: string, isSetUp: boolean): boolean {
  if (path === "/setup" || path === "/setup/owner") return isSetUp;
  // Password sign-in is not served yet, so its POST is closed in both phases.
  return path === "/sign-in" && method === "POST";
}

async function handleApp(ctx: Ctx): Promise<void> {
  const method = ctx.req.method ?? "GET";
  const allowed = ROUTES[ctx.path];
  if (allowed === undefined) {
    sendText(ctx, 404, NOT_FOUND);
    return;
  }
  if (!allowed.includes(method)) {
    ctx.res.writeHead(405, { allow: allowed.join(", "), "content-length": 0 }).end();
    return;
  }
  const isSetUp = ctx.deps.store.instance() !== undefined;
  if (isClosedInPhase(ctx.path, method, isSetUp)) {
    sendText(ctx, 404, NOT_FOUND);
    return;
  }
  if (ctx.deps.mode === "loopback" && !isLoopbackHost(ctx.req.headers.host)) {
    sendText(ctx, 421, MISDIRECTED);
    return;
  }
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
