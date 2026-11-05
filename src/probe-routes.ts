import type { TokenMetadata } from "@lorenzh/pulse-contract";
import { escapeHtml } from "@lorenzh/pulse-kit";
import { apiIdSegment } from "./api-path.ts";
import { typedNameError } from "./confirm.ts";
import { paragraph } from "./html.ts";
import { routeRole } from "./permissions.ts";
import {
  PROBE_LACKS_CHECKS_TEXT,
  type ProbeFormInput,
  probeAddedHtml,
  probeFormHtml,
  probeListHtml,
  probeRevokeConfirmHtml,
  probeRotateConfirmHtml,
  probeRotatedHtml,
} from "./probe-pages.ts";
import {
  checkLocation,
  checkProbeApiUrl,
  checkProbeImage,
  checkProbeName,
  checkProbeNetwork,
  type FieldCheck,
} from "./probe-snippet.ts";
import type { PageRequest, PageResult, ProtectedRoute } from "./protected-route.ts";
import type { ProbePrefill } from "./settings.ts";
import { notFoundState, staleState, tokenRejectedBanner } from "./states.ts";
import { lacksScopeText } from "./token-pages.ts";
import {
  type OneTokenRead,
  readSelf,
  readToken,
  readTokenList,
  readTokenPage,
  type TokenRead,
} from "./token-read.ts";
import {
  apiUrlOf,
  FORM_EXPIRED_TEXT,
  fieldOf,
  INACTIVE_TEXT,
  OWN_TOKEN_REFUSED_TEXT,
  queryIdOf,
  readDeps,
  readProblem,
  selfBanner,
  type TokenRouteDeps,
  writeDeps,
} from "./token-routes.ts";
import {
  isProbeToken,
  isTokenActive,
  locationGroups,
  missingScope,
  tokenRevision,
} from "./token-view.ts";
import { sendTokenWrite, type TokenWrite, type TokenWriteAnswer } from "./token-write.ts";

export type ProbeRouteDeps = TokenRouteDeps & { probePrefill?: ProbePrefill | undefined };

const LIST = "/probes";
const CREATE = "/probes/new";
const ROTATE = "/probes/rotate";
const REVOKE = "/probes/revoke";
const FIELDS = ["location", "name", "api_url", "image", "network"] as const;

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
  return `<p><a href="${LIST}">Back to Probes</a></p>\n`;
}

function idQuery(id: string): string {
  return `?id=${encodeURIComponent(id)}`;
}

function selfRefused(self: Exclude<TokenRead<TokenMetadata>, { kind: "ok" }>, title: string) {
  const status = self.kind === "token-rejected" ? 502 : 503;
  return page(status, title, backLink(), selfBanner(self));
}

async function listPage(deps: ProbeRouteDeps, request: PageRequest): Promise<PageResult> {
  const reads = await readTokenPage(apiUrlOf(deps), readDeps(deps), true);
  const banners: string[] = [];
  if (reads.self.kind !== "ok") banners.push(selfBanner(reads.self));
  if (reads.tokens.kind !== "ok") {
    const problem = readProblem(reads.tokens, LIST);
    if (problem.banner !== undefined && reads.self.kind !== "token-rejected") {
      banners.push(problem.banner);
    }
    return page(200, "Probes", problem.body, banners.join("") || undefined);
  }
  const now = deps.now();
  const probes = reads.tokens.value.filter(isProbeToken);
  const locations = reads.locations;
  const observed =
    locations === undefined || locations.kind !== "ok"
      ? { failure: locations?.kind === "failed" ? locations.failure : { kind: "invalid" as const } }
      : locations.value;
  const body = probeListHtml({
    groups: locationGroups(probes, observed, now),
    canChange: reads.self.kind === "ok",
    selfId: reads.self.kind === "ok" ? reads.self.value.id : undefined,
    now,
  });
  const revokedId = request.query.get("revoked");
  const revoked = probes.find((t) => t.id === revokedId);
  const notice =
    revoked === undefined
      ? ""
      : paragraph(
          `Revoked ${revoked.name} (${revoked.id}). Its results stay in pulse-api.`,
          ' role="status"',
        );
  return page(200, "Probes", notice + body, banners.join("") || undefined);
}

type FormError = { name: string; text: string };

function inputOf(request: PageRequest): ProbeFormInput {
  return {
    location: fieldOf(request.fields, "location"),
    name: fieldOf(request.fields, "name"),
    apiUrl: fieldOf(request.fields, "api_url"),
    image: fieldOf(request.fields, "image"),
    network: fieldOf(request.fields, "network"),
  };
}

function prefillOf(deps: ProbeRouteDeps): ProbeFormInput {
  const prefill = deps.probePrefill;
  return {
    location: "",
    name: "",
    apiUrl: prefill?.apiUrl ?? "",
    image: prefill?.image ?? "",
    network: prefill?.network ?? "",
  };
}

function formPage(
  deps: ProbeRouteDeps,
  request: PageRequest,
  input: ProbeFormInput,
  view: { status: number; errors: readonly FormError[]; notice?: string | undefined },
): PageResult {
  const body = probeFormHtml({
    csrf: request.csrf,
    formToken: request.issueFormToken(CREATE),
    input,
    errors: view.errors,
    consoleApiUrl: apiUrlOf(deps),
    notice: view.notice,
  });
  return page(view.status, "Add location", body);
}

type Checked = { location: string; name: string; apiUrl: string; image: string; network: string };

/** Section 5: the five field rules; the errors or the checked values. */
function checkForm(input: ProbeFormInput): { errors: FormError[]; checked: Checked | undefined } {
  const location = checkLocation(input.location);
  const checks: ReadonlyArray<readonly [string, string, FieldCheck]> = [
    ["location", "Location", location],
    ["name", "Name", checkProbeName(input.name, location.isValid ? location.value : "")],
    ["api_url", "API URL", checkProbeApiUrl(input.apiUrl)],
    ["image", "Image", checkProbeImage(input.image)],
    ["network", "Network", checkProbeNetwork(input.network)],
  ];
  const errors: FormError[] = [];
  const values: string[] = [];
  for (const [name, label, check] of checks) {
    if (check.isValid) values.push(check.value);
    else errors.push({ name, text: `${label} ${check.rule}.` });
  }
  const [loc, nm, url, image, network] = values;
  if (errors.length > 0 || loc === undefined || nm === undefined || url === undefined) {
    return { errors, checked: undefined };
  }
  if (image === undefined || network === undefined) return { errors, checked: undefined };
  return { errors, checked: { location: loc, name: nm, apiUrl: url, image, network } };
}

async function showCreate(deps: ProbeRouteDeps, request: PageRequest): Promise<PageResult> {
  const self = await readSelf(apiUrlOf(deps), readDeps(deps));
  if (self.kind !== "ok") return selfRefused(self, "Add location");
  if (missingScope(["probe"], self.value.scopes) !== undefined) {
    return page(200, "Add location", alert(PROBE_LACKS_CHECKS_TEXT) + backLink());
  }
  return formPage(deps, request, prefillOf(deps), { status: 200, errors: [] });
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

/** The active credentials of `location` before the write, or `undefined` when unread. */
async function activeBefore(deps: ProbeRouteDeps, location: string): Promise<number | undefined> {
  const list = await readTokenList(apiUrlOf(deps), readDeps(deps));
  if (list.kind !== "ok") return undefined;
  const now = deps.now();
  return list.value.filter(
    (t) => isProbeToken(t) && t.location === location && isTokenActive(t, now),
  ).length;
}

async function createProbe(deps: ProbeRouteDeps, request: PageRequest): Promise<PageResult> {
  const input = inputOf(request);
  const { errors, checked } = checkForm(input);
  if (checked === undefined) return formPage(deps, request, input, { status: 422, errors });
  const apiUrl = apiUrlOf(deps);
  const self = await readSelf(apiUrl, readDeps(deps));
  if (self.kind !== "ok") return selfRefused(self, "Add location");
  const lacks = missingScope(["probe"], self.value.scopes);
  if (lacks !== undefined) {
    return page(403, "Add location", alert(lacksScopeText(lacks)) + backLink());
  }
  const before = await activeBefore(deps, checked.location);
  const write: TokenWrite = {
    action: "token.create",
    url: `${apiUrl}/admin/tokens`,
    body: JSON.stringify({ name: checked.name, scopes: ["probe"], location: checked.location }),
    value: `location=${checked.location}`,
  };
  const answer = await sendTokenWrite(
    writeDeps(deps),
    request,
    routeRole("probe.write"),
    CREATE,
    write,
  );
  if (answer.kind === "secret") {
    const body = probeAddedHtml({
      snippet: { ...checked, tokenId: answer.answer.token.id },
      answer: answer.answer,
      activeCount: before === undefined ? undefined : before + 1,
      notLogged: answer.notLogged,
    });
    return page(200, "Location added", body);
  }
  if (answer.kind === "revoked") return page(502, "Add location", backLink());
  return answerPage(answer, "Add location", (status, message) =>
    formPage(deps, request, input, { status, errors: [{ name: "location", text: message }] }),
  );
}

function createRoute(deps: ProbeRouteDeps): ProtectedRoute {
  return {
    path: CREATE,
    methods: ["GET", "POST"],
    requiredRole: routeRole("probe.write"),
    navId: "probes",
    knownFields: [...FIELDS],
    reopenHrefOf: () => CREATE,
    handle: (request) =>
      request.method === "POST" ? createProbe(deps, request) : showCreate(deps, request),
    renderForm: (request, notice) =>
      formPage(deps, request, inputOf(request), { status: 409, errors: [], notice }),
  };
}

type Change = "rotate" | "revoke";
type Target = { self: TokenMetadata; token: TokenMetadata; revision: string };

function titleOf(change: Change): string {
  return change === "rotate" ? "Rotate probe token" : "Revoke probe token";
}

function pathOf(change: Change): string {
  return change === "rotate" ? ROTATE : REVOKE;
}

function conflict(change: Change, text: string): PageResult {
  return page(409, titleOf(change), alert(text) + backLink());
}

function tokenReadPage(read: Exclude<OneTokenRead, { kind: "ok" }>, change: Change, id: string) {
  if (read.kind === "not-found") return notFound();
  const problem = readProblem(read, `${pathOf(change)}${idQuery(id)}`);
  return page(502, titleOf(change), problem.body + backLink(), problem.banner);
}

/** Section 6 steps 2 to 4: self, the target by id, a probe token only, not the own token. */
async function targetOf(
  deps: ProbeRouteDeps,
  change: Change,
  id: string,
): Promise<{ kind: "ok"; target: Target } | { kind: "page"; page: PageResult }> {
  const apiUrl = apiUrlOf(deps);
  const self = await readSelf(apiUrl, readDeps(deps));
  if (self.kind !== "ok") return { kind: "page", page: selfRefused(self, titleOf(change)) };
  const read = await readToken(apiUrl, id, readDeps(deps));
  if (read.kind !== "ok") return { kind: "page", page: tokenReadPage(read, change, id) };
  const token = read.value;
  if (!isProbeToken(token)) return { kind: "page", page: notFound() };
  if (token.id === self.value.id) {
    return { kind: "page", page: conflict(change, OWN_TOKEN_REFUSED_TEXT) };
  }
  return { kind: "ok", target: { self: self.value, token, revision: tokenRevision(token) } };
}

function confirmPage(
  request: PageRequest,
  change: Change,
  target: Target,
  view: { status: number; now: number; notice?: string; typed?: string; error?: string },
): PageResult {
  const model = {
    token: target.token,
    revision: target.revision,
    csrf: request.csrf,
    formToken: request.issueFormToken(pathOf(change)),
    ...view,
  };
  const body = change === "rotate" ? probeRotateConfirmHtml(model) : probeRevokeConfirmHtml(model);
  return page(view.status, titleOf(change), body);
}

async function showChange(
  deps: ProbeRouteDeps,
  request: PageRequest,
  change: Change,
  id: string,
): Promise<PageResult> {
  const found = await targetOf(deps, change, id);
  if (found.kind === "page") return found.page;
  const now = deps.now();
  if (!isTokenActive(found.target.token, now)) return conflict(change, INACTIVE_TEXT);
  return confirmPage(request, change, found.target, { status: 200, now });
}

/** Section 6 steps 5 to 9 (no last-admin rule: a probe token is never an admin token). */
function changeRefusal(
  request: PageRequest,
  change: Change,
  target: Target,
  now: number,
): PageResult | undefined {
  if (fieldOf(request.fields, "revision") !== target.revision) {
    const reloadHref = `${pathOf(change)}${idQuery(target.token.id)}`;
    return page(409, titleOf(change), staleState({ status: 409, reloadHref }));
  }
  if (!isTokenActive(target.token, now)) return conflict(change, INACTIVE_TEXT);
  if (change === "revoke") {
    const typed = fieldOf(request.fields, "confirm_name");
    const error = typedNameError(typed, target.token.location ?? "");
    if (error !== undefined) {
      return confirmPage(request, change, target, { status: 422, now, typed, error });
    }
  }
  const lacks = missingScope(target.token.scopes, target.self.scopes);
  if (lacks !== undefined) {
    return page(403, titleOf(change), alert(lacksScopeText(lacks)) + backLink());
  }
  return undefined;
}

function revokedPage(token: TokenMetadata, notLogged: string | undefined): PageResult {
  if (notLogged === undefined) {
    return { kind: "redirect", location: `${LIST}?revoked=${encodeURIComponent(token.id)}` };
  }
  const text = `Revoked ${token.name} (${token.id}).`;
  return page(
    200,
    "Probe token revoked",
    paragraph(text, ' role="status"') + alert(notLogged) + backLink(),
  );
}

async function postChange(
  deps: ProbeRouteDeps,
  request: PageRequest,
  change: Change,
  id: string,
): Promise<PageResult> {
  const found = await targetOf(deps, change, id);
  if (found.kind === "page") return found.page;
  const { target } = found;
  const now = deps.now();
  const refused = changeRefusal(request, change, target, now);
  if (refused !== undefined) return refused;
  const segment = apiIdSegment(target.token.id);
  if (segment === undefined) return notFound();
  const write: TokenWrite = {
    action: change === "rotate" ? "token.rotate" : "token.revoke",
    url: `${apiUrlOf(deps)}/admin/tokens/${segment}/${change}`,
    tokenId: target.token.id,
    value: `location=${target.token.location ?? ""}`,
  };
  const reopen = `${pathOf(change)}${idQuery(id)}`;
  const answer = await sendTokenWrite(
    writeDeps(deps),
    request,
    routeRole("probe.write"),
    reopen,
    write,
  );
  if (answer.kind === "secret") {
    const body = probeRotatedHtml({
      answer: answer.answer,
      notLogged: answer.notLogged,
      now: deps.now(),
    });
    return page(200, "Probe token rotated", body);
  }
  if (answer.kind === "revoked") return revokedPage(target.token, answer.notLogged);
  return answerPage(answer, titleOf(change), (status, message) =>
    confirmPage(request, change, target, { status, now, notice: message }),
  );
}

function changeRoute(deps: ProbeRouteDeps, change: Change): ProtectedRoute {
  const path = pathOf(change);
  return {
    path,
    methods: ["GET", "POST"],
    requiredRole: routeRole("probe.write"),
    navId: "probes",
    knownFields: change === "rotate" ? ["revision"] : ["revision", "confirm_name"],
    reopenHrefOf: (request) => {
      const id = queryIdOf(request.query);
      return id === undefined ? path : `${path}${idQuery(id)}`;
    },
    handle: async (request) => {
      const id = queryIdOf(request.query);
      if (id === undefined) return notFound();
      return request.method === "POST"
        ? postChange(deps, request, change, id)
        : showChange(deps, request, change, id);
    },
    renderForm: (request) => {
      const id = queryIdOf(request.query);
      const reopen =
        id === undefined
          ? ""
          : `<p><a href="${escapeHtml(path + idQuery(id))}">Open it again</a></p>\n`;
      return page(409, "Form expired", alert(FORM_EXPIRED_TEXT) + reopen);
    },
  };
}

/** The production Probes routes, Admin and Owner (`probe.write`). */
export function probeRoutes(deps: ProbeRouteDeps): ProtectedRoute[] {
  return [
    {
      path: LIST,
      methods: ["GET"],
      requiredRole: routeRole("probe.write"),
      navId: "probes",
      handle: (request) => listPage(deps, request),
    },
    createRoute(deps),
    changeRoute(deps, "rotate"),
    changeRoute(deps, "revoke"),
  ];
}
