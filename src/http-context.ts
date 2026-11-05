import type { IncomingMessage, ServerResponse } from "node:http";
import { BodyError, type Logger, readBody } from "@lorenzh/pulse-kit";
import {
  type AccountStore,
  type Session,
  type SessionStage,
  sessionDigest,
  type User,
} from "./account-store.ts";
import type { AuthThrottle } from "./auth-throttle.ts";
import type { FetchLike } from "./connection-test.ts";
import { readCookie, serializeCookie, serializeSessionCookie } from "./cookies.ts";
import type { FactorStore } from "./factor-store.ts";
import type { FormTokens } from "./form-tokens.ts";
import { type FormFields, isFormContentType, MAX_FORM_BYTES, parseForm } from "./forms.ts";
import type { Metrics } from "./metrics.ts";
import { alreadySubmittedPage, messagePage } from "./pages.ts";
import type { CredentialVerifier, HashPassword } from "./passwords.ts";
import type { ProtectedRoute } from "./protected-route.ts";
import { expectedOrigin, isCsrfTokenValid, isOriginAllowed } from "./request-guard.ts";
import type { ConsoleRole } from "./roles.ts";
import type { ConsoleMode } from "./settings.ts";
import type { SetupGate } from "./setup-code.ts";

const REFUSED = "Request refused. Reload the page and try again.";
const TOKEN_BYTES = 32;
export const NOT_FOUND = "not found\n";

export interface ConsoleServerDeps {
  metrics: Metrics;
  log: Logger;
  instanceName: string;
  mode: ConsoleMode;
  publicOrigin: string | undefined;
  /** PULSE_API_URL: the default of the setup form. */
  defaultApiUrl: string;
  adminToken: string | undefined;
  store: AccountStore;
  factorStore: FactorStore;
  /** The 32-byte key of PULSE_CONSOLE_SECRET_KEY_FILE; undefined when unset. */
  secretKey: Uint8Array | undefined;
  /** The setup gate; undefined when the console was set up at start. */
  gate: SetupGate | undefined;
  now: () => number;
  randomBytes: (size: number) => Uint8Array;
  hashPassword: HashPassword;
  /** Checks a sign-in password; an unknown account runs the dummy verification. */
  verifier: CredentialVerifier;
  fetch: FetchLike;
  schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
  testRoutes?: ReadonlyMap<string, ProtectedRoute> | undefined;
  roleOf?: ((user: User) => ConsoleRole) | undefined;
}

export type State = {
  gate: SetupGate | undefined;
  setupThrottle: AuthThrottle<"client">;
  signInThrottle: AuthThrottle<"account" | "client">;
  factorThrottle: AuthThrottle<"account" | "client">;
  formTokens: FormTokens;
  protectedRoutes: ReadonlyMap<string, ProtectedRoute>;
};

/** A live session of this request with its effective stage. */
export type Current = { id: string; session: Session; user: User; stage: SessionStage };

export type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  query: URLSearchParams;
  deps: ConsoleServerDeps;
  state: State;
  cookies: string[];
  /** Set by the access gate after setup. */
  current: Current | undefined;
};

export function send(
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

export function sendHtml(
  ctx: Ctx,
  status: number,
  html: string,
  headers?: Record<string, string>,
): void {
  send(ctx, status, "text/html; charset=utf-8", html, headers);
}

export function sendText(ctx: Ctx, status: number, text: string): void {
  send(ctx, status, "text/plain; charset=utf-8", text);
}

export function redirect(ctx: Ctx, location: string): void {
  if (ctx.cookies.length > 0) ctx.res.setHeader("set-cookie", ctx.cookies);
  ctx.res.writeHead(303, { location, "cache-control": "no-store", "content-length": 0 });
  ctx.res.end();
}

export function newToken(ctx: Ctx): string {
  return Buffer.from(ctx.deps.randomBytes(TOKEN_BYTES)).toString("base64url");
}

export function cookieOf(ctx: Ctx, kind: "csrf" | "setup" | "session"): string | undefined {
  return readCookie(ctx.req.headers.cookie, kind, ctx.deps.mode);
}

/** The anonymous CSRF token of this client; a GET of a form page sets it when it is missing. */
export function ensureCsrf(ctx: Ctx): string {
  const existing = cookieOf(ctx, "csrf");
  if (existing !== undefined) return existing;
  const token = newToken(ctx);
  ctx.cookies.push(serializeCookie("csrf", token, ctx.deps.mode));
  return token;
}

/** Sets the cookie of a new session of `stage`. */
export function pushSessionCookie(ctx: Ctx, id: string, stage: SessionStage): void {
  ctx.cookies.push(serializeSessionCookie(id, stage, ctx.deps.mode));
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

export function sendRefused(ctx: Ctx): void {
  sendHtml(ctx, 403, messagePage("Request refused", REFUSED));
}

/**
 * The POST order after the gate: Origin, content type, body size, repeated fields and the CSRF
 * token. It answers the first failure and returns undefined then.
 */
export async function readFormFields<K extends string>(
  ctx: Ctx,
  known: readonly K[],
): Promise<FormFields<K | "csrf"> | undefined> {
  const { req, deps } = ctx;
  const origin = expectedOrigin(deps.mode, req.headers.host, deps.publicOrigin);
  if (!isOriginAllowed(req.headers.origin, origin)) {
    sendRefused(ctx);
    return undefined;
  }
  if (!isFormContentType(req.headers["content-type"])) {
    sendText(ctx, 415, "unsupported content type\n");
    return undefined;
  }
  const body = await readBodyOrFail(ctx);
  if (body === undefined) return undefined;
  const parsed = parseForm<K | "csrf">(body, [...known, "csrf"]);
  if (!parsed.isOk) {
    sendText(ctx, 400, "repeated form field\n");
    return undefined;
  }
  return parsed.fields;
}

export async function readPostForm<K extends string>(
  ctx: Ctx,
  known: readonly K[],
  expectedCsrf: string | undefined = cookieOf(ctx, "csrf"),
): Promise<FormFields<K | "csrf"> | undefined> {
  const fields = await readFormFields(ctx, known);
  if (fields === undefined) return undefined;
  if (!isCsrfTokenValid(fields.csrf, expectedCsrf)) {
    sendRefused(ctx);
    return undefined;
  }
  return fields;
}

/** The current session that the gate admitted; a handler behind the gate always has one. */
export function currentOf(ctx: Ctx): Current {
  if (ctx.current === undefined) throw new GateMissingError();
  return ctx.current;
}

export type SessionForm = { csrf: string; formToken: string; signOutToken: string };

/** Form tokens for a session page and its separate sign-out form. HEAD stores no token. */
export function sessionForm(ctx: Ctx): SessionForm {
  const current = currentOf(ctx);
  const binding = `s:${sessionDigest(current.id)}`;
  const issue = (path: string): string =>
    ctx.req.method === "HEAD" ? "" : ctx.state.formTokens.issue(binding, path);
  return {
    csrf: current.session.csrfToken,
    formToken: issue(ctx.path),
    signOutToken: issue("/sign-out"),
  };
}

/** Use a session form token immediately before its mutation; never count it as a guess. */
export function acceptSessionForm(
  ctx: Ctx,
  token: string | undefined,
  expiredPage: () => string,
): boolean {
  const binding = `s:${sessionDigest(currentOf(ctx).id)}`;
  const result = ctx.state.formTokens.consume(token ?? "", binding, ctx.path);
  if (result === "accepted") return true;
  ctx.deps.log.info("form token refused", { reason: result, path: ctx.path });
  const page = result === "replayed" ? alreadySubmittedPage(ctx.path) : expiredPage();
  sendHtml(ctx, 409, page);
  return false;
}

export class GateMissingError extends Error {
  override name = "GateMissingError";
  constructor() {
    super("a handler ran without the access gate");
  }
}
