import {
  type AdminComponent,
  type AdminConfigResponse,
  MANUAL_INCIDENT_MAX_BODY_BYTES,
  type ManualIncident,
} from "@lorenzh/pulse-contract";
import type { Logger } from "@lorenzh/pulse-kit";
import type { AccountStore, User } from "./account-store.ts";
import type { ApiReadDeps, FetchLike } from "./api-read.ts";
import { checkProblemView } from "./check-pages.ts";
import { type CheckReadProblem, readCheckConfig } from "./check-read.ts";
import { type CheckWriteDeps, SAVED_NOT_LOGGED_TEXT, writeGuardProblem } from "./check-write.ts";
import { typedConfirmPage, typedNameError } from "./confirm.ts";
import { MAX_INCIDENT_FORM_BYTES } from "./forms.ts";
import { paragraph } from "./html.ts";
import {
  type ComposerInput,
  composerBody,
  type FieldErrors,
  incidentConfirmName,
  incidentTitleText,
  normalizeMessage,
  resolveBody,
  updateBody,
} from "./incident-form.ts";
import { parseIncidentFilters } from "./incident-list.ts";
import {
  ALREADY_RESOLVED_TEXT,
  AUTOMATIC_GONE_TEXT,
  automaticDetailBody,
  composerHtml,
  INCIDENT_DELETED_TEXT,
  INCIDENT_PUBLISHED_TEXT,
  INCIDENT_RESOLVED_TEXT,
  incidentListBody,
  keptInputHtml,
  manualDetailBody,
  resolveFormHtml,
  UPDATE_POSTED_TEXT,
  updateFormHtml,
} from "./incident-pages.ts";
import { openPreview, resolvedPreview } from "./incident-preview.ts";
import {
  readAutomaticIncident,
  readComposer,
  readIncidentList,
  readManualIncident,
} from "./incident-read.ts";
import {
  INCIDENT_GONE_TEXT,
  type IncidentWrite,
  type IncidentWriteAnswer,
  PUBLISHED_UNREADABLE_TEXT,
  sendIncidentWrite,
} from "./incident-write.ts";
import { isAllowed, routeRole } from "./permissions.ts";
import type { PageRequest, PageResult, ProtectedRoute } from "./protected-route.ts";
import type { ConsoleRole } from "./roles.ts";
import { alertCallout, callout, notFoundState, tokenRejectedBanner } from "./states.ts";

export type IncidentRouteDeps = {
  store: AccountStore;
  defaultApiUrl: string;
  adminToken: string | undefined;
  fetch: FetchLike;
  schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
  roleOf?: ((user: User) => ConsoleRole) | undefined;
  now: () => number;
  log: Logger;
};

export const INCIDENT_TOO_LARGE_TEXT = `The incident is larger than pulse-api accepts (${MANUAL_INCIDENT_MAX_BODY_BYTES} bytes).`;
export const INCIDENT_EXPIRED_TEXT = "This form has expired. Open it again.";
const DELETE_CONSEQUENCE =
  "Deleting removes the incident from the status page and feeds. Notifications already sent cannot be recalled.";

const NEW_PATH = "/incidents/new";
const UPDATE_PATH = "/incidents/update";
const RESOLVE_PATH = "/incidents/resolve";
const DELETE_PATH = "/incidents/delete";
const RESOLVED_DEFAULT_MESSAGE = "Resolved.";

function apiUrlOf(deps: IncidentRouteDeps): string {
  return deps.store.instance()?.apiUrl ?? deps.defaultApiUrl;
}

function readDeps(deps: IncidentRouteDeps): ApiReadDeps {
  return {
    fetch: deps.fetch,
    token: deps.adminToken,
    schedule: deps.schedule,
    warn: (message, fields) => deps.log.warn(message, fields),
  };
}

function writeDeps(deps: IncidentRouteDeps): CheckWriteDeps {
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

const INCIDENT_ID = /^[1-9]\d{0,14}$/;

function idOf(value: string | undefined): number | undefined {
  return value !== undefined && INCIDENT_ID.test(value) ? Number(value) : undefined;
}

/** The `id` query, present once and a valid incident id; else `undefined` (the shell 404). */
function queryIdOf(query: URLSearchParams): number | undefined {
  const ids = query.getAll("id");
  return ids.length === 1 ? idOf(ids[0]) : undefined;
}

function fieldOf(request: PageRequest, name: string): string {
  return Object.hasOwn(request.fields, name) ? (request.fields[name] ?? "") : "";
}

function postedIdOf(request: PageRequest): number | undefined {
  return idOf(Object.hasOwn(request.fields, "incident") ? request.fields.incident : undefined);
}

function notFound(text?: string): PageResult {
  return {
    kind: "page",
    status: 404,
    title: "Page not found",
    body: `${text === undefined ? "" : alertCallout(text)}${notFoundState()}`,
  };
}

function page(status: number, title: string, body: string, banner?: string): PageResult {
  return { kind: "page", status, title, body, banner };
}

function problemPage(problem: CheckReadProblem, retryHref: string, title: string, kept = "") {
  const view = checkProblemView(problem, retryHref);
  return page(502, title, view.body + kept, view.banner === "" ? undefined : view.banner);
}

function detailHref(id: number): string {
  return `/incidents/manual?id=${id}`;
}

/** The answer of an incident write that is not a re-rendered form. */
function answerPage(
  answer: Exclude<IncidentWriteAnswer, { kind: "form" }>,
  kept: string,
): PageResult {
  switch (answer.kind) {
    case "redirect":
      return { kind: "redirect", location: answer.location };
    case "not-logged":
      return page(
        200,
        "Saved",
        `${callout({ kind: "warning", body: paragraph(SAVED_NOT_LOGGED_TEXT), role: "alert" })}<p><a href="${answer.href}">Open the incident</a></p>\n`,
      );
    case "text":
      if (answer.reason === "token-rejected") {
        return page(answer.status, "Not saved", kept, tokenRejectedBanner());
      }
      return page(answer.status, "Not saved", alertCallout(answer.message) + kept);
    default: {
      const never: never = answer;
      return never;
    }
  }
}

/** Guard, write and answer; `formOf` re-renders the form with a write's message. */
async function commit(
  deps: IncidentRouteDeps,
  request: PageRequest,
  write: IncidentWrite,
  view: { requiredRole: ConsoleRole; reopen: string; kept: string },
  formOf: (notice: string, status: number) => PageResult,
): Promise<PageResult> {
  const guard = writeGuardProblem(writeDeps(deps), request, view.requiredRole, view.reopen);
  if (guard !== undefined) {
    return guard.kind === "page" ? { ...guard, body: guard.body + view.kept } : guard;
  }
  const answer = await sendIncidentWrite(writeDeps(deps), apiUrlOf(deps), write, request.user);
  return answer.kind === "form"
    ? formOf(answer.message, answer.status)
    : answerPage(answer, view.kept);
}

function isWithinIncidentLimit(body: unknown): boolean {
  return new TextEncoder().encode(JSON.stringify(body)).length <= MANUAL_INCIDENT_MAX_BODY_BYTES;
}

function expiredPage(request: PageRequest, href: (id: number) => string): PageResult {
  const id = queryIdOf(request.query) ?? postedIdOf(request);
  const reopen = id === undefined ? "" : `<p><a href="${href(id)}">Open it again</a></p>\n`;
  return page(
    409,
    "Form expired",
    callout({ kind: "warning", body: paragraph(INCIDENT_EXPIRED_TEXT), role: "alert" }) + reopen,
  );
}

// --- List and details ---------------------------------------------------------------------

function listNotice(query: URLSearchParams): string | undefined {
  if (query.get("deleted") === "1") return INCIDENT_DELETED_TEXT;
  if (query.get("published") === "1") return PUBLISHED_UNREADABLE_TEXT;
  return undefined;
}

function listRoute(deps: IncidentRouteDeps): ProtectedRoute {
  return {
    path: "/incidents",
    methods: ["GET"],
    requiredRole: routeRole("overview.view"),
    navId: "incidents",
    handle: async (request) => {
      const now = deps.now();
      const read = await readIncidentList(apiUrlOf(deps), readDeps(deps), now);
      if (read.kind !== "ok") return problemPage(read, "/incidents", "Incidents");
      const body = incidentListBody({
        manual: read.manual,
        automatic: read.automatic,
        config: read.config,
        filters: parseIncidentFilters(request.query.toString()),
        role: request.role,
        now,
        notice: listNotice(request.query),
      });
      return page(200, "Incidents", body);
    },
  };
}

function detailNotice(query: URLSearchParams): string | undefined {
  if (query.get("published") === "1") return INCIDENT_PUBLISHED_TEXT;
  if (query.get("posted") === "1") return UPDATE_POSTED_TEXT;
  if (query.get("resolved") === "1") return INCIDENT_RESOLVED_TEXT;
  return undefined;
}

type UpdateState = {
  status: string;
  message: string;
  errors: FieldErrors;
  notice?: string | undefined;
};

function manualPage(
  request: PageRequest,
  incident: ManualIncident,
  components: readonly AdminComponent[],
  view: { status: number; now: number; notice?: string | undefined; update?: UpdateState },
): PageResult {
  const isOpen = incident.resolvedAt === null;
  const update = view.update ?? { status: incident.status, message: "", errors: {} };
  const updateForm =
    isOpen && isAllowed(request.role, "incident.write")
      ? updateFormHtml({
          id: incident.id,
          status: update.status,
          message: update.message,
          errors: update.errors,
          notice: update.notice,
          csrf: request.csrf,
          formToken: request.issueFormToken(UPDATE_PATH),
          preview: openPreview(
            {
              title: incident.title,
              impact: incident.impact,
              status: update.status,
              components: incident.componentIds,
              message: update.message,
            },
            components,
          ),
        })
      : "";
  const body = manualDetailBody({
    incident,
    components,
    role: request.role,
    now: view.now,
    notice: view.notice,
    updateForm,
  });
  return page(view.status, incidentTitleText(incident.id, incident.title), body);
}

function manualRoute(deps: IncidentRouteDeps): ProtectedRoute {
  return {
    path: "/incidents/manual",
    methods: ["GET"],
    requiredRole: routeRole("overview.view"),
    navId: "incidents",
    handle: async (request) => {
      const id = queryIdOf(request.query);
      if (id === undefined) return notFound();
      const read = await readManualIncident(apiUrlOf(deps), readDeps(deps), id, true);
      if (read.kind === "not-found") return notFound(INCIDENT_GONE_TEXT);
      if (read.kind !== "ok") return problemPage(read, detailHref(id), "Incident");
      return manualPage(request, read.incident, read.config?.components ?? [], {
        status: 200,
        now: deps.now(),
        notice: detailNotice(request.query),
      });
    },
  };
}

function automaticRoute(deps: IncidentRouteDeps): ProtectedRoute {
  return {
    path: "/incidents/automatic",
    methods: ["GET"],
    requiredRole: routeRole("overview.view"),
    navId: "incidents",
    handle: async (request) => {
      const id = queryIdOf(request.query);
      if (id === undefined) return notFound();
      const now = deps.now();
      const href = `/incidents/automatic?id=${id}`;
      const read = await readAutomaticIncident(apiUrlOf(deps), readDeps(deps), id, now);
      if (read.kind === "not-found") return notFound(AUTOMATIC_GONE_TEXT);
      if (read.kind !== "ok") return problemPage(read, href, "Automatic incident");
      const results = read.results;
      const isProblem =
        results.kind !== "ok" && results.kind !== "check-gone" && results.kind !== "unaddressable";
      const view = isProblem ? checkProblemView(results, href) : { banner: "", body: "" };
      const body = automaticDetailBody({
        incident: read.incident,
        config: read.config,
        results,
        resultsProblem: view.body,
        role: request.role,
        now,
      });
      const banner = view.banner === "" ? undefined : view.banner;
      return page(200, `Automatic incident #${id}`, body, banner);
    },
  };
}

// --- Composer -----------------------------------------------------------------------------

const DEFAULT_INPUT: ComposerInput = {
  title: "",
  impact: "minor",
  status: "investigating",
  components: [],
  message: "",
};

function composerPage(
  request: PageRequest,
  components: readonly AdminComponent[],
  view: {
    status: number;
    input: ComposerInput;
    errors?: FieldErrors;
    notice?: string | undefined;
    noticeKind?: "info" | "error";
  },
): PageResult {
  const body = composerHtml({
    csrf: request.csrf,
    formToken: request.issueFormToken(NEW_PATH),
    input: view.input,
    components,
    errors: view.errors ?? {},
    notice: view.notice,
    noticeKind: view.noticeKind,
    preview: openPreview(view.input, components),
  });
  return page(view.status, "Declare incident", body);
}

function fromOf(query: URLSearchParams): number | undefined {
  const values = query.getAll("from");
  return values.length === 1 ? idOf(values[0]) : undefined;
}

function fromNotice(
  from: number,
  found: { checkId: string } | undefined,
  config: AdminConfigResponse,
  selected: readonly string[],
): string {
  if (found === undefined) {
    return `Automatic incident #${from} is not among the incidents of the last 14 days; nothing was preselected.`;
  }
  const base = `Publishing creates a new manual incident. Automatic incident #${from} stays unchanged.`;
  if (selected.length > 0) return base;
  const name = config.checks.find((c) => c.id === found.checkId)?.name ?? found.checkId;
  return `${base} No component contains check ${name}; pick components or publish a general incident.`;
}

async function showComposer(deps: IncidentRouteDeps, request: PageRequest): Promise<PageResult> {
  const from = fromOf(request.query);
  const read = await readComposer(apiUrlOf(deps), readDeps(deps), from, deps.now());
  if (read.kind !== "ok") return problemPage(read, NEW_PATH, "Declare incident");
  const found = read.from;
  const selected =
    found === undefined
      ? []
      : read.config.components.filter((c) => c.checkIds.includes(found.checkId)).map((c) => c.id);
  const notice = from === undefined ? undefined : fromNotice(from, found, read.config, selected);
  return composerPage(request, read.config.components, {
    status: 200,
    input: { ...DEFAULT_INPUT, components: selected },
    notice,
    noticeKind: "info",
  });
}

function composerInputOf(request: PageRequest): ComposerInput {
  return {
    title: fieldOf(request, "title"),
    impact: fieldOf(request, "impact"),
    status: fieldOf(request, "status"),
    components: request.lists.component ?? [],
    message: normalizeMessage(fieldOf(request, "message")),
  };
}

function composerKept(input: ComposerInput): string {
  return keptInputHtml([
    ["Title", input.title],
    ["Impact", input.impact],
    ["Status", input.status],
    ["Components", input.components.join(", ")],
    ["Message", input.message],
  ]);
}

async function createIncident(deps: IncidentRouteDeps, request: PageRequest): Promise<PageResult> {
  const input = composerInputOf(request);
  const read = await readCheckConfig(apiUrlOf(deps), readDeps(deps));
  if (read.kind !== "ok") {
    return problemPage(read, NEW_PATH, "Declare incident", composerKept(input));
  }
  const components = read.config.components;
  const formOf = (notice: string | undefined, status: number, errors: FieldErrors = {}) =>
    composerPage(request, components, { status, input, errors, notice });
  if (fieldOf(request, "action") !== "publish") return formOf(undefined, 200);
  const built = composerBody(input, new Set(components.map((c) => c.id)));
  if (!built.ok) return formOf(undefined, 422, built.errors);
  if (!isWithinIncidentLimit(built.body)) return formOf(INCIDENT_TOO_LARGE_TEXT, 422);
  return commit(
    deps,
    request,
    { action: "manual-incident.create", body: built.body },
    { requiredRole: routeRole("incident.write"), reopen: NEW_PATH, kept: composerKept(input) },
    (notice, status) => formOf(notice, status),
  );
}

function composerRoute(deps: IncidentRouteDeps): ProtectedRoute {
  return {
    path: NEW_PATH,
    methods: ["GET", "POST"],
    requiredRole: routeRole("incident.write"),
    navId: "incidents",
    knownFields: ["title", "impact", "status", "message", "action"],
    listFields: { component: 1000 },
    maxFormBytes: MAX_INCIDENT_FORM_BYTES,
    reopenHrefOf: () => NEW_PATH,
    handle: (request) =>
      request.method === "POST" ? createIncident(deps, request) : showComposer(deps, request),
    renderForm: (_request, notice) =>
      page(
        409,
        "Form expired",
        `${alertCallout(notice)}<p><a href="${NEW_PATH}">Open it again</a></p>\n`,
      ),
  };
}

// --- Update and resolve -------------------------------------------------------------------

type OpenRead =
  | { kind: "page"; page: PageResult }
  | { kind: "ok"; incident: ManualIncident; components: readonly AdminComponent[] };

/** The two reads of update and resolve; a resolved incident is `409` with `kept` as text. */
async function readOpen(
  deps: IncidentRouteDeps,
  id: number,
  retryHref: string,
  kept: string,
): Promise<OpenRead> {
  const read = await readManualIncident(apiUrlOf(deps), readDeps(deps), id, true);
  if (read.kind === "not-found") return { kind: "page", page: notFound(INCIDENT_GONE_TEXT) };
  if (read.kind !== "ok") {
    return { kind: "page", page: problemPage(read, retryHref, "Incident", kept) };
  }
  if (read.incident.resolvedAt !== null || read.incident.status === "resolved") {
    return {
      kind: "page",
      page: page(409, "Already resolved", alertCallout(ALREADY_RESOLVED_TEXT) + kept),
    };
  }
  return { kind: "ok", incident: read.incident, components: read.config?.components ?? [] };
}

async function postUpdate(deps: IncidentRouteDeps, request: PageRequest): Promise<PageResult> {
  const id = postedIdOf(request);
  if (id === undefined) return notFound();
  const status = fieldOf(request, "status");
  const message = normalizeMessage(fieldOf(request, "message"));
  const kept = keptInputHtml([
    ["Status", status],
    ["Message", message],
  ]);
  const read = await readOpen(deps, id, detailHref(id), kept);
  if (read.kind === "page") return read.page;
  const formOf = (notice: string | undefined, code: number, errors: FieldErrors = {}) =>
    manualPage(request, read.incident, read.components, {
      status: code,
      now: deps.now(),
      update: { status, message, errors, notice },
    });
  if (fieldOf(request, "action") !== "publish") return formOf(undefined, 200);
  const built = updateBody(status, message);
  if (!built.ok) return formOf(undefined, 422, built.errors);
  if (!isWithinIncidentLimit(built.body)) return formOf(INCIDENT_TOO_LARGE_TEXT, 422);
  return commit(
    deps,
    request,
    { action: "manual-incident.update", id, body: built.body },
    { requiredRole: routeRole("incident.write"), reopen: detailHref(id), kept },
    (notice, code) => formOf(notice, code),
  );
}

function updateRoute(deps: IncidentRouteDeps): ProtectedRoute {
  return {
    path: UPDATE_PATH,
    methods: ["POST"],
    requiredRole: routeRole("incident.write"),
    navId: "incidents",
    knownFields: ["incident", "status", "message", "action"],
    maxFormBytes: MAX_INCIDENT_FORM_BYTES,
    reopenHrefOf: (request) => {
      const id = postedIdOf(request);
      return id === undefined ? "/incidents" : detailHref(id);
    },
    handle: (request) => postUpdate(deps, request),
    renderForm: (request) => expiredPage(request, detailHref),
  };
}

function resolvePage(
  request: PageRequest,
  incident: ManualIncident,
  components: readonly AdminComponent[],
  view: { status: number; message: string; errors?: FieldErrors; notice?: string | undefined },
): PageResult {
  const body = resolveFormHtml({
    id: incident.id,
    message: view.message,
    errors: view.errors ?? {},
    notice: view.notice,
    csrf: request.csrf,
    formToken: request.issueFormToken(RESOLVE_PATH),
    preview: resolvedPreview(incident, view.message, components),
  });
  return page(view.status, `Resolve ${incidentTitleText(incident.id, incident.title)}`, body);
}

async function resolveIncident(
  deps: IncidentRouteDeps,
  request: PageRequest,
  id: number,
): Promise<PageResult> {
  const message = normalizeMessage(fieldOf(request, "message"));
  const kept = keptInputHtml([["Message", message]]);
  const reopen = `${RESOLVE_PATH}?id=${id}`;
  const read = await readOpen(deps, id, reopen, kept);
  if (read.kind === "page") return read.page;
  const formOf = (notice: string | undefined, status: number, errors: FieldErrors = {}) =>
    resolvePage(request, read.incident, read.components, { status, message, errors, notice });
  if (fieldOf(request, "action") !== "publish") return formOf(undefined, 200);
  const built = resolveBody(message);
  if (!built.ok) return formOf(undefined, 422, built.errors);
  if (!isWithinIncidentLimit(built.body)) return formOf(INCIDENT_TOO_LARGE_TEXT, 422);
  return commit(
    deps,
    request,
    { action: "manual-incident.resolve", id, message: built.body.message },
    { requiredRole: routeRole("incident.write"), reopen, kept },
    (notice, status) => formOf(notice, status),
  );
}

function resolveRoute(deps: IncidentRouteDeps): ProtectedRoute {
  return {
    path: RESOLVE_PATH,
    methods: ["GET", "POST"],
    requiredRole: routeRole("incident.write"),
    navId: "incidents",
    knownFields: ["incident", "message", "action"],
    maxFormBytes: MAX_INCIDENT_FORM_BYTES,
    reopenHrefOf: (request) => {
      const id = queryIdOf(request.query);
      return id === undefined ? "/incidents" : `${RESOLVE_PATH}?id=${id}`;
    },
    handle: async (request) => {
      const id = queryIdOf(request.query);
      if (id === undefined) return notFound();
      if (request.method === "POST") {
        return postedIdOf(request) === id ? resolveIncident(deps, request, id) : notFound();
      }
      const read = await readOpen(deps, id, `${RESOLVE_PATH}?id=${id}`, "");
      if (read.kind === "page") return read.page;
      return resolvePage(request, read.incident, read.components, {
        status: 200,
        message: RESOLVED_DEFAULT_MESSAGE,
      });
    },
    renderForm: (request) => expiredPage(request, (id) => `${RESOLVE_PATH}?id=${id}`),
  };
}

// --- Delete -------------------------------------------------------------------------------

function deletePage(
  request: PageRequest,
  incident: ManualIncident,
  view: { status: number; typed?: string; error?: string },
): PageResult {
  const body = typedConfirmPage({
    consequence: DELETE_CONSEQUENCE,
    action: `${DELETE_PATH}?id=${incident.id}`,
    csrf: request.csrf,
    formToken: request.issueFormToken(DELETE_PATH),
    revision: String(incident.updates.length),
    hidden: [["incident", String(incident.id)]],
    submitLabel: "Delete incident",
    busyLabel: "Deleting…",
    cancelHref: detailHref(incident.id),
    targetName: incidentConfirmName(incident.id, incident.title).trim(),
    typed: view.typed,
    error: view.error,
  });
  return page(view.status, `Delete ${incidentTitleText(incident.id, incident.title)}`, body);
}

async function deleteIncident(
  deps: IncidentRouteDeps,
  request: PageRequest,
  id: number,
): Promise<PageResult> {
  const reopen = `${DELETE_PATH}?id=${id}`;
  const read = await readManualIncident(apiUrlOf(deps), readDeps(deps), id, false);
  if (read.kind === "not-found") return notFound(INCIDENT_GONE_TEXT);
  if (read.kind !== "ok") return problemPage(read, reopen, "Delete incident");
  const { incident } = read;
  const typed = fieldOf(request, "confirm_name");
  const error = typedNameError(typed, incidentConfirmName(incident.id, incident.title));
  if (error !== undefined) return deletePage(request, incident, { status: 422, typed, error });
  return commit(
    deps,
    request,
    { action: "manual-incident.delete", id },
    { requiredRole: routeRole("incident.delete"), reopen, kept: "" },
    (notice, status) => page(status, "Not deleted", alertCallout(notice)),
  );
}

function deleteRoute(deps: IncidentRouteDeps): ProtectedRoute {
  return {
    path: DELETE_PATH,
    methods: ["GET", "POST"],
    requiredRole: routeRole("incident.delete"),
    navId: "incidents",
    knownFields: ["revision", "incident", "confirm_name"],
    reopenHrefOf: (request) => {
      const id = queryIdOf(request.query);
      return id === undefined ? "/incidents" : `${DELETE_PATH}?id=${id}`;
    },
    handle: async (request) => {
      const id = queryIdOf(request.query);
      if (id === undefined) return notFound();
      if (request.method === "POST") {
        return postedIdOf(request) === id ? deleteIncident(deps, request, id) : notFound();
      }
      const read = await readManualIncident(apiUrlOf(deps), readDeps(deps), id, false);
      if (read.kind === "not-found") return notFound(INCIDENT_GONE_TEXT);
      if (read.kind !== "ok")
        return problemPage(read, `${DELETE_PATH}?id=${id}`, "Delete incident");
      return deletePage(request, read.incident, { status: 200 });
    },
    renderForm: (request) => expiredPage(request, (id) => `${DELETE_PATH}?id=${id}`),
  };
}

/** The production incident routes (section 1). */
export function incidentRoutes(deps: IncidentRouteDeps): ProtectedRoute[] {
  return [
    listRoute(deps),
    manualRoute(deps),
    automaticRoute(deps),
    composerRoute(deps),
    updateRoute(deps),
    resolveRoute(deps),
    deleteRoute(deps),
  ];
}
