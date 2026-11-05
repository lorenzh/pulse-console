import type { TokenMetadata, TokenScope } from "@lorenzh/pulse-contract";
import { escapeHtml, type Logger } from "@lorenzh/pulse-kit";
import type { AccountStore, User } from "./account-store.ts";
import { apiIdSegment } from "./api-path.ts";
import type { ApiReadDeps, FetchLike } from "./api-read.ts";
import { typedNameError } from "./confirm.ts";
import { NO_TOKEN_TEXT } from "./connection-test.ts";
import { paragraph } from "./html.ts";
import { routeRole } from "./permissions.ts";
import type { PageRequest, PageResult, ProtectedRoute } from "./protected-route.ts";
import type { ConsoleRole } from "./roles.ts";
import { apiUnavailableState, notFoundState, staleState, tokenRejectedBanner } from "./states.ts";
import {
  createFormHtml,
  LAST_ADMIN_TEXT,
  lacksScopeText,
  lastAdminExpiryText,
  revokeConfirmHtml,
  rotateConfirmHtml,
  secretHtml,
  tokenListHtml,
  tokenQuery,
} from "./token-pages.ts";
import {
  type OneTokenRead,
  readSelf,
  readToken,
  readTokenList,
  readTokenPage,
  type TokenRead,
} from "./token-read.ts";
import {
  isProbeToken,
  isTokenActive,
  lastActiveAdmin,
  missingScope,
  presetOf,
  selfUnknownText,
  tokenRevision,
} from "./token-view.ts";
import { sendTokenWrite, type TokenWrite, type TokenWriteAnswer } from "./token-write.ts";

export type TokenRouteDeps = {
  store: AccountStore;
  defaultApiUrl: string;
  adminToken: string | undefined;
  fetch: FetchLike;
  schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
  roleOf?: ((user: User) => ConsoleRole) | undefined;
  now: () => number;
  log: Logger;
};

export const OWN_TOKEN_REFUSED_TEXT = "This is the console's own token. Nothing was changed.";
export const INACTIVE_TEXT = "This token is already revoked or expired.";
export const LAST_ADMIN_REFUSED_TEXT = "This is the last active admin token. Nothing was changed.";
export const FORM_EXPIRED_TEXT =
  "This form has expired. Nothing was sent. Open it again to see the current version.";
const NAME_MAX = 100;
const LIST = "/tokens";
const CREATE = "/tokens/new";
const ROTATE = "/tokens/rotate";
const REVOKE = "/tokens/revoke";

function apiUrlOf(deps: TokenRouteDeps): string {
  return deps.store.instance()?.apiUrl ?? deps.defaultApiUrl;
}

function readDeps(deps: TokenRouteDeps): ApiReadDeps {
  return {
    fetch: deps.fetch,
    token: deps.adminToken,
    schedule: deps.schedule,
    warn: (message, fields) => deps.log.warn(message, fields),
  };
}

function page(status: number, title: string, body: string, banner?: string): PageResult {
  return { kind: "page", status, title, body, banner };
}

function notFound(): PageResult {
  return page(404, "Page not found", notFoundState());
}

function alert(text: string): string {
  return paragraph(text, ' role="alert"');
}

function backLink(): string {
  return `<p><a href="${LIST}">Back to Tokens</a></p>\n`;
}

/** A failed read as a banner and a body; `retry` is the link of the failure state. */
function readProblem(read: Exclude<TokenRead<unknown>, { kind: "ok" }>, retry: string) {
  switch (read.kind) {
    case "no-token":
      return { banner: undefined, body: alert(NO_TOKEN_TEXT) };
    case "token-rejected":
      return { banner: tokenRejectedBanner(), body: "" };
    case "failed":
      return { banner: undefined, body: apiUnavailableState(read.failure, retry) };
    default: {
      const never: never = read;
      return never;
    }
  }
}

/** Section 3: the banner of a `/self` read that failed; changes are off. */
function selfBanner(self: Exclude<TokenRead<TokenMetadata>, { kind: "ok" }>): string {
  switch (self.kind) {
    case "token-rejected":
      return tokenRejectedBanner();
    case "no-token":
      return `<section class="state state-error" role="alert">${paragraph(NO_TOKEN_TEXT)}</section>\n`;
    case "failed":
      return `<section class="state state-error" role="alert">${paragraph(selfUnknownText(self.failure))}</section>\n`;
    default: {
      const never: never = self;
      return never;
    }
  }
}

/** The mutation refusal of a failed `/self` read: `503`, or the token-rejected `502`. */
function selfRefused(self: Exclude<TokenRead<TokenMetadata>, { kind: "ok" }>, title: string) {
  const status = self.kind === "token-rejected" ? 502 : 503;
  return page(status, title, backLink(), selfBanner(self));
}

function queryIdOf(query: URLSearchParams): string | undefined {
  const ids = query.getAll("id");
  const [id] = ids;
  return ids.length === 1 && id !== undefined && id !== "" ? id : undefined;
}

function fieldOf(fields: PageRequest["fields"], name: string): string {
  return Object.hasOwn(fields, name) ? (fields[name] ?? "") : "";
}

function listBanner(tokens: readonly TokenMetadata[], now: number): string | undefined {
  const last = lastActiveAdmin(tokens, now);
  if (last?.expiresAt === null || last === undefined) return undefined;
  return `<section class="state state-warning" role="alert">${paragraph(lastAdminExpiryText(last.expiresAt))}</section>\n`;
}

function revokedNotice(tokens: readonly TokenMetadata[], id: string | null): string {
  if (id === null) return "";
  const name = tokens.find((t) => t.id === id)?.name;
  const text = name === undefined ? `Revoked (${id}).` : `Revoked ${name} (${id}).`;
  return paragraph(text, ' role="status"');
}

async function listPage(deps: TokenRouteDeps, request: PageRequest): Promise<PageResult> {
  const reads = await readTokenPage(apiUrlOf(deps), readDeps(deps), false);
  const now = deps.now();
  const banners: string[] = [];
  if (reads.self.kind !== "ok") banners.push(selfBanner(reads.self));
  if (reads.tokens.kind !== "ok") {
    const problem = readProblem(reads.tokens, LIST);
    if (problem.banner !== undefined && reads.self.kind !== "token-rejected") {
      banners.push(problem.banner);
    }
    return page(200, "Tokens", problem.body, banners.join("") || undefined);
  }
  const all = reads.tokens.value;
  const tokens = all.filter((t) => !isProbeToken(t));
  const expiry = listBanner(all, now);
  if (expiry !== undefined) banners.push(expiry);
  const body = tokenListHtml({
    tokens,
    probeCount: all.length - tokens.length,
    selfId: reads.self.kind === "ok" ? reads.self.value.id : undefined,
    canChange: reads.self.kind === "ok",
    lastAdminId: lastActiveAdmin(all, now)?.id,
    now,
  });
  const notice = revokedNotice(all, request.query.get("revoked"));
  return page(200, "Tokens", notice + body, banners.join("") || undefined);
}

function listRoute(deps: TokenRouteDeps): ProtectedRoute {
  return {
    path: LIST,
    methods: ["GET"],
    requiredRole: routeRole("token.write"),
    navId: "tokens",
    handle: (request) => listPage(deps, request),
  };
}

type CreateInput = { name: string; preset: string };
type FormError = { name: string; text: string };

function createPage(
  request: PageRequest,
  input: CreateInput,
  view: {
    status: number;
    errors: readonly FormError[];
    held?: readonly TokenScope[] | undefined;
    notice?: string | undefined;
    banner?: string | undefined;
  },
): PageResult {
  const body = createFormHtml({
    csrf: request.csrf,
    formToken: request.issueFormToken(CREATE),
    name: input.name,
    preset: input.preset,
    errors: view.errors,
    held: view.held,
    notice: view.notice,
  });
  return page(view.status, "New token", body, view.banner);
}

/** The name rule: trimmed 1 to 100 characters, no control character. */
function nameError(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "") return "Enter a name.";
  if ([...trimmed].length > NAME_MAX) return `Use at most ${NAME_MAX} characters.`;
  if (/\p{Cc}/u.test(trimmed)) return "The name cannot hold control characters.";
  return undefined;
}

function createErrors(input: CreateInput): FormError[] {
  const errors: FormError[] = [];
  const name = nameError(input.name);
  if (name !== undefined) errors.push({ name: "name", text: name });
  if (presetOf(input.preset) === undefined)
    errors.push({ name: "preset", text: "Choose the access." });
  return errors;
}

async function showCreate(deps: TokenRouteDeps, request: PageRequest): Promise<PageResult> {
  const self = await readSelf(apiUrlOf(deps), readDeps(deps));
  const input = { name: "", preset: "" };
  if (self.kind !== "ok") return selfRefused(self, "New token");
  return createPage(request, input, { status: 200, errors: [], held: self.value.scopes });
}

function writeDeps(deps: TokenRouteDeps) {
  return {
    store: deps.store,
    fetch: deps.fetch,
    adminToken: deps.adminToken,
    schedule: deps.schedule,
    roleOf: deps.roleOf,
    now: deps.now,
    log: deps.log,
  };
}

/** The page of every answer that is not a shown secret or a revoke. */
function answerPage(
  answer: Exclude<TokenWriteAnswer, { kind: "secret" } | { kind: "revoked" }>,
  title: string,
  formOf: (status: number, message: string) => PageResult,
): PageResult {
  switch (answer.kind) {
    case "guard":
      return answer.page;
    case "form":
      return formOf(answer.status, answer.message);
    case "text":
      if (answer.reason === "not-found") return notFound();
      if (answer.reason === "token-rejected") {
        return page(answer.status, title, backLink(), tokenRejectedBanner());
      }
      return page(answer.status, title, alert(answer.message) + backLink());
    default: {
      const never: never = answer;
      return never;
    }
  }
}

async function createToken(deps: TokenRouteDeps, request: PageRequest): Promise<PageResult> {
  const input = {
    name: fieldOf(request.fields, "name"),
    preset: fieldOf(request.fields, "preset"),
  };
  const errors = createErrors(input);
  if (errors.length > 0) return createPage(request, input, { status: 422, errors });
  const apiUrl = apiUrlOf(deps);
  const self = await readSelf(apiUrl, readDeps(deps));
  if (self.kind !== "ok") return selfRefused(self, "New token");
  const held = self.value.scopes;
  const preset = presetOf(input.preset);
  if (preset === undefined) return createPage(request, input, { status: 422, errors });
  const lacks = missingScope(preset.scopes, held);
  if (lacks !== undefined) {
    const error = { name: "preset", text: lacksScopeText(lacks) };
    return createPage(request, input, { status: 422, errors: [error], held });
  }
  const write: TokenWrite = {
    action: "token.create",
    url: `${apiUrl}/admin/tokens`,
    body: JSON.stringify({ name: input.name.trim(), scopes: preset.scopes }),
    value: `scopes=${preset.scopes.join(",")}`,
  };
  const answer = await sendTokenWrite(
    writeDeps(deps),
    request,
    routeRole("token.write"),
    CREATE,
    write,
  );
  if (answer.kind === "secret") {
    const body = secretHtml({
      action: "create",
      answer: answer.answer,
      notLogged: answer.notLogged,
      now: deps.now(),
    });
    return page(200, "Token created", body);
  }
  if (answer.kind === "revoked") return page(502, "New token", backLink());
  return answerPage(answer, "New token", (status, message) =>
    createPage(request, input, { status, errors: [{ name: "name", text: message }], held }),
  );
}

function expiredCreate(request: PageRequest, notice: string): PageResult {
  const input = {
    name: fieldOf(request.fields, "name"),
    preset: fieldOf(request.fields, "preset"),
  };
  return createPage(request, input, { status: 409, errors: [], notice });
}

function createRoute(deps: TokenRouteDeps): ProtectedRoute {
  return {
    path: CREATE,
    methods: ["GET", "POST"],
    requiredRole: routeRole("token.write"),
    navId: "tokens",
    knownFields: ["name", "preset"],
    reopenHrefOf: () => CREATE,
    handle: (request) =>
      request.method === "POST" ? createToken(deps, request) : showCreate(deps, request),
    renderForm: expiredCreate,
  };
}

type Change = "rotate" | "revoke";
type Target = {
  self: TokenMetadata;
  token: TokenMetadata;
  revision: string;
  all?: TokenMetadata[] | undefined;
};

function titleOf(change: Change): string {
  return change === "rotate" ? "Rotate token" : "Revoke token";
}

function pathOf(change: Change): string {
  return change === "rotate" ? ROTATE : REVOKE;
}

function conflict(change: Change, text: string): PageResult {
  return page(409, titleOf(change), alert(text) + backLink());
}

function tokenReadPage(
  read: Exclude<OneTokenRead, { kind: "ok" }>,
  change: Change,
  id: string,
): PageResult {
  if (read.kind === "not-found") return notFound();
  const problem = readProblem(read, `${pathOf(change)}${tokenQuery(id)}`);
  return page(502, titleOf(change), problem.body + backLink(), problem.banner);
}

/** Section 6 steps 2 to 4: self, the target by id, the screen kind, the own token. */
async function targetOf(
  deps: TokenRouteDeps,
  change: Change,
  id: string,
): Promise<{ kind: "ok"; target: Target } | { kind: "page"; page: PageResult }> {
  const apiUrl = apiUrlOf(deps);
  const self = await readSelf(apiUrl, readDeps(deps));
  if (self.kind !== "ok") return { kind: "page", page: selfRefused(self, titleOf(change)) };
  const read = await readToken(apiUrl, id, readDeps(deps));
  if (read.kind !== "ok") return { kind: "page", page: tokenReadPage(read, change, id) };
  const token = read.value;
  if (isProbeToken(token)) return { kind: "page", page: notFound() };
  if (token.id === self.value.id) {
    return { kind: "page", page: conflict(change, OWN_TOKEN_REFUSED_TEXT) };
  }
  return { kind: "ok", target: { self: self.value, token, revision: tokenRevision(token) } };
}

/** Revoke only: the list read of this request for the last-admin rule. */
async function lastAdminPage(
  deps: TokenRouteDeps,
  token: TokenMetadata,
): Promise<PageResult | undefined> {
  const list = await readTokenList(apiUrlOf(deps), readDeps(deps));
  if (list.kind !== "ok") {
    const problem = readProblem(list, `${REVOKE}${tokenQuery(token.id)}`);
    return page(502, "Revoke token", problem.body + backLink(), problem.banner);
  }
  return lastActiveAdmin(list.value, deps.now())?.id === token.id
    ? conflict("revoke", LAST_ADMIN_TEXT)
    : undefined;
}

function confirmPage(
  request: PageRequest,
  change: Change,
  target: Target,
  view: {
    status: number;
    now: number;
    notice?: string | undefined;
    typed?: string | undefined;
    error?: string | undefined;
  },
): PageResult {
  const model = {
    token: target.token,
    revision: target.revision,
    csrf: request.csrf,
    formToken: request.issueFormToken(pathOf(change)),
    notice: view.notice,
    typed: view.typed,
    error: view.error,
  };
  const body =
    change === "rotate" ? rotateConfirmHtml(model, view.now) : revokeConfirmHtml(model, view.now);
  return page(view.status, titleOf(change), body);
}

async function showChange(
  deps: TokenRouteDeps,
  request: PageRequest,
  change: Change,
  id: string,
): Promise<PageResult> {
  const found = await targetOf(deps, change, id);
  if (found.kind === "page") return found.page;
  const { target } = found;
  const now = deps.now();
  if (!isTokenActive(target.token, now)) return conflict(change, INACTIVE_TEXT);
  if (change === "revoke") {
    const refused = await lastAdminPage(deps, target.token);
    if (refused !== undefined) return refused;
  }
  return confirmPage(request, change, target, { status: 200, now });
}

function stalePage(change: Change, id: string): PageResult {
  return page(
    409,
    titleOf(change),
    staleState({ status: 409, reloadHref: `${pathOf(change)}${tokenQuery(id)}` }),
  );
}

/** Section 6 steps 5 to 9 for a found target; `undefined` when the write may go on. */
async function changeRefusal(
  deps: TokenRouteDeps,
  request: PageRequest,
  change: Change,
  target: Target,
  now: number,
): Promise<PageResult | undefined> {
  if (fieldOf(request.fields, "revision") !== target.revision)
    return stalePage(change, target.token.id);
  if (!isTokenActive(target.token, now)) return conflict(change, INACTIVE_TEXT);
  if (change === "revoke") {
    const typed = fieldOf(request.fields, "confirm_name");
    const error = typedNameError(typed, target.token.name);
    if (error !== undefined)
      return confirmPage(request, change, target, { status: 422, now, typed, error });
    const refused = await lastAdminPage(deps, target.token);
    if (refused !== undefined) return refused;
  }
  const lacks = missingScope(target.token.scopes, target.self.scopes);
  if (lacks !== undefined)
    return page(403, titleOf(change), alert(lacksScopeText(lacks)) + backLink());
  return undefined;
}

async function postChange(
  deps: TokenRouteDeps,
  request: PageRequest,
  change: Change,
  id: string,
): Promise<PageResult> {
  const found = await targetOf(deps, change, id);
  if (found.kind === "page") return found.page;
  const { target } = found;
  const now = deps.now();
  const refused = await changeRefusal(deps, request, change, target, now);
  if (refused !== undefined) return refused;
  const segment = apiIdSegment(target.token.id);
  if (segment === undefined) return notFound();
  const write: TokenWrite = {
    action: change === "rotate" ? "token.rotate" : "token.revoke",
    url: `${apiUrlOf(deps)}/admin/tokens/${segment}/${change}`,
    tokenId: target.token.id,
    value: `scopes=${target.token.scopes.join(",")}`,
  };
  const reopen = `${pathOf(change)}${tokenQuery(id)}`;
  const answer = await sendTokenWrite(
    writeDeps(deps),
    request,
    routeRole("token.write"),
    reopen,
    write,
  );
  if (answer.kind === "secret") {
    const body = secretHtml({
      action: "rotate",
      answer: answer.answer,
      notLogged: answer.notLogged,
      now: deps.now(),
    });
    return page(200, "Token rotated", body);
  }
  if (answer.kind === "revoked") {
    if (answer.notLogged === undefined) {
      return {
        kind: "redirect",
        location: `${LIST}?revoked=${encodeURIComponent(target.token.id)}`,
      };
    }
    const text = `Revoked ${target.token.name} (${target.token.id}).`;
    return page(
      200,
      "Token revoked",
      paragraph(text, ' role="status"') + alert(answer.notLogged) + backLink(),
    );
  }
  return answerPage(answer, titleOf(change), (status, message) =>
    confirmPage(request, change, target, { status, now, notice: message }),
  );
}

function expiredChange(change: Change): (request: PageRequest) => PageResult {
  return (request) => {
    const id = queryIdOf(request.query);
    const reopen =
      id === undefined
        ? ""
        : `<p><a href="${escapeHtml(pathOf(change) + tokenQuery(id))}">Open it again</a></p>\n`;
    return page(409, "Form expired", alert(FORM_EXPIRED_TEXT) + reopen);
  };
}

function changeRoute(deps: TokenRouteDeps, change: Change): ProtectedRoute {
  const path = pathOf(change);
  return {
    path,
    methods: ["GET", "POST"],
    requiredRole: routeRole("token.write"),
    navId: "tokens",
    knownFields: change === "rotate" ? ["revision"] : ["revision", "confirm_name"],
    reopenHrefOf: (request) => {
      const id = queryIdOf(request.query);
      return id === undefined ? path : `${path}${tokenQuery(id)}`;
    },
    handle: async (request) => {
      const id = queryIdOf(request.query);
      if (id === undefined) return notFound();
      return request.method === "POST"
        ? postChange(deps, request, change, id)
        : showChange(deps, request, change, id);
    },
    renderForm: expiredChange(change),
  };
}

/** The production Tokens routes, Admin and Owner (`token.write`). */
export function tokenRoutes(deps: TokenRouteDeps): ProtectedRoute[] {
  return [
    listRoute(deps),
    createRoute(deps),
    changeRoute(deps, "rotate"),
    changeRoute(deps, "revoke"),
  ];
}
