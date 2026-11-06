import {
  type AdminConfigResponse,
  MAINTENANCE_WINDOW_ID,
  MAX_MAINTENANCE_WINDOW_ID,
} from "@lorenzh/pulse-contract";
import type { Logger } from "@lorenzh/pulse-kit";
import type { AccountStore, User } from "./account-store.ts";
import type { ApiReadDeps, FetchLike } from "./api-read.ts";
import { checkProblemView } from "./check-pages.ts";
import { type CheckReadProblem, readCheckConfig } from "./check-read.ts";
import {
  type CheckWriteDeps,
  isWithinApiBodyLimit,
  SAVED_NOT_LOGGED_TEXT,
  sendApiWrite,
  type WriteAnswer,
  type WriteTexts,
  writeGuardProblem,
} from "./check-write.ts";
import { plainConfirmPage } from "./confirm.ts";
import { MAX_MAINTENANCE_FORM_BYTES } from "./forms.ts";
import { paragraph } from "./html.ts";
import {
  type MaintenanceErrors,
  type MaintenanceInput,
  maintenanceBody,
  type StoredTimes,
  utcInputValue,
} from "./maintenance-form.ts";
import {
  FILE_WINDOW_TEXT,
  MAINTENANCE_DELETED_TEXT,
  MAINTENANCE_SAVED_TEXT,
  maintenanceFormHtml,
  maintenanceKeptHtml,
  maintenanceListBody,
  WINDOW_GONE_TEXT,
} from "./maintenance-pages.ts";
import {
  type MaintenanceReadProblem,
  OLD_MAINTENANCE_API_TEXT,
  readMaintenance,
  readMaintenanceAndConfig,
  readMaintenanceForm,
} from "./maintenance-read.ts";
import { maintenanceSections, windowPlace } from "./maintenance-view.ts";
import { isAllowed, routeRole } from "./permissions.ts";
import type { PageRequest, PageResult, ProtectedRoute } from "./protected-route.ts";
import type { ConsoleRole } from "./roles.ts";
import { alertCallout, callout, notFoundState, staleState, tokenRejectedBanner } from "./states.ts";

export type MaintenanceRouteDeps = {
  store: AccountStore;
  defaultApiUrl: string;
  adminToken: string | undefined;
  fetch: FetchLike;
  schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
  roleOf?: ((user: User) => ConsoleRole) | undefined;
  now: () => number;
  log: Logger;
};

export const MAINTENANCE_SCOPE_TEXT =
  "The console token lacks the admin or checks scope. Saving maintenance windows needs both.";
export const MAINTENANCE_UNKNOWN_TEXT =
  "The result is unknown. Open Maintenance to see whether the window was saved.";
export const MAINTENANCE_TOO_LARGE_TEXT = "The window is larger than pulse-api accepts.";

const TEXTS: WriteTexts = {
  scope: MAINTENANCE_SCOPE_TEXT,
  gone: WINDOW_GONE_TEXT,
  unknown: MAINTENANCE_UNKNOWN_TEXT,
  unknownHint: "open Maintenance to see whether the window was saved.",
  unknownAnswered: MAINTENANCE_UNKNOWN_TEXT,
};

const LIST_PATH = "/maintenance";
const NEW_PATH = "/maintenance/new";
const EDIT_PATH = "/maintenance/edit";
const DELETE_PATH = "/maintenance/delete";

function apiUrlOf(deps: MaintenanceRouteDeps): string {
  return deps.store.instance()?.apiUrl ?? deps.defaultApiUrl;
}

function readDeps(deps: MaintenanceRouteDeps): ApiReadDeps {
  return {
    fetch: deps.fetch,
    token: deps.adminToken,
    schedule: deps.schedule,
    warn: (message, fields) => deps.log.warn(message, fields),
  };
}

function writeDeps(deps: MaintenanceRouteDeps): CheckWriteDeps {
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

function isWindowId(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length <= MAX_MAINTENANCE_WINDOW_ID &&
    MAINTENANCE_WINDOW_ID.test(value)
  );
}

/** The `id` query, present once and a valid window id; else undefined (the shell 404). */
function queryIdOf(query: URLSearchParams): string | undefined {
  const ids = query.getAll("id");
  const id = ids.length === 1 ? ids[0] : undefined;
  return isWindowId(id) ? id : undefined;
}

function fieldOf(request: PageRequest, name: string): string {
  return Object.hasOwn(request.fields, name) ? (request.fields[name] ?? "") : "";
}

/** The posted `target`, when it equals the `id` query. */
function postedTargetOf(request: PageRequest): string | undefined {
  const id = queryIdOf(request.query);
  return id !== undefined && fieldOf(request, "target") === id ? id : undefined;
}

function page(status: number, title: string, body: string, banner?: string): PageResult {
  return { kind: "page", status, title, body, banner };
}

function notFound(text?: string): PageResult {
  return page(
    404,
    "Page not found",
    `${text === undefined ? "" : alertCallout(text)}${notFoundState()}`,
  );
}

function problemPage(
  problem: MaintenanceReadProblem,
  retryHref: string,
  title: string,
  kept = "",
): PageResult {
  if (problem.kind === "old-maintenance") {
    return page(502, title, alertCallout(OLD_MAINTENANCE_API_TEXT) + kept);
  }
  const view = checkProblemView(problem satisfies CheckReadProblem, retryHref);
  return page(502, title, view.body + kept, view.banner === "" ? undefined : view.banner);
}

function editHref(id: string): string {
  return `${EDIT_PATH}?id=${encodeURIComponent(id)}`;
}

function staleFormPage(reopen: string, kept: string, status: 409 | 412 = 409): PageResult {
  return page(
    status,
    "Changed since you opened it",
    `${staleState({ status, reloadHref: reopen })}${kept}<p><a href="${reopen}">Open the form again</a></p>\n`,
  );
}

function expiredPage(request: PageRequest, path: string): PageResult {
  const id = queryIdOf(request.query);
  const href = id === undefined ? path : `${path}?id=${encodeURIComponent(id)}`;
  return page(
    409,
    "Form expired",
    `${alertCallout("This form has expired. Open it again.")}<p><a href="${href}">Open it again</a></p>\n`,
  );
}

// --- List -------------------------------------------------------------------------------------

function listNotice(query: URLSearchParams): string | undefined {
  if (query.get("saved") === "1") return MAINTENANCE_SAVED_TEXT;
  if (query.get("deleted") === "1") return MAINTENANCE_DELETED_TEXT;
  return undefined;
}

function listRoute(deps: MaintenanceRouteDeps): ProtectedRoute {
  return {
    path: LIST_PATH,
    methods: ["GET"],
    requiredRole: routeRole("overview.view"),
    navId: "maintenance",
    handle: async (request) => {
      const now = deps.now();
      const read = await readMaintenanceAndConfig(apiUrlOf(deps), readDeps(deps));
      if (read.kind !== "ok") return problemPage(read, LIST_PATH, "Maintenance");
      const names = new Map(read.config.checks.map((c) => [c.id, c.name]));
      const body = maintenanceListBody({
        sections: maintenanceSections(read.list, names, request.role),
        now,
        canCreate: isAllowed(request.role, "maintenance.create"),
        notice: listNotice(request.query),
      });
      return page(200, "Maintenance", body);
    },
  };
}

// --- Create and edit --------------------------------------------------------------------------

const EMPTY_INPUT: MaintenanceInput = {
  id: "",
  checks: [],
  components: [],
  start: "",
  end: "",
  note: "",
};

type FormView = {
  status: number;
  target: string | undefined;
  revision: string;
  input: MaintenanceInput;
  config: AdminConfigResponse;
  errors?: MaintenanceErrors | undefined;
  notice?: string | undefined;
};

function formPage(request: PageRequest, view: FormView): PageResult {
  const action = view.target === undefined ? NEW_PATH : EDIT_PATH;
  const body = maintenanceFormHtml({
    csrf: request.csrf,
    formToken: request.issueFormToken(action),
    revision: view.revision,
    target: view.target,
    input: view.input,
    errors: view.errors ?? {},
    config: view.config,
    notice: view.notice,
  });
  const title = view.target === undefined ? "Plan maintenance" : `Edit ${view.target}`;
  return page(view.status, title, body);
}

function inputOf(request: PageRequest, id: string): MaintenanceInput {
  return {
    id,
    checks: request.lists.check ?? [],
    components: request.lists.component ?? [],
    start: fieldOf(request, "start"),
    end: fieldOf(request, "end"),
    note: fieldOf(request, "note"),
  };
}

async function showForm(
  deps: MaintenanceRouteDeps,
  request: PageRequest,
  target: string | undefined,
): Promise<PageResult> {
  const reopen = target === undefined ? NEW_PATH : editHref(target);
  const title = target === undefined ? "Plan maintenance" : "Edit maintenance window";
  const read = await readMaintenanceForm(apiUrlOf(deps), readDeps(deps));
  if (read.kind !== "ok") return problemPage(read, reopen, title);
  if (!read.isCoherent) return staleFormPage(reopen, "");
  const base = { revision: read.list.revision, config: read.config, status: 200, target };
  if (target === undefined) return formPage(request, { ...base, input: EMPTY_INPUT });
  const place = windowPlace(read.list, target);
  if (place.kind === "missing") return notFound(WINDOW_GONE_TEXT);
  if (place.kind !== "database") return page(409, title, alertCallout(FILE_WINDOW_TEXT));
  const { window } = place;
  return formPage(request, {
    ...base,
    input: {
      id: target,
      checks: window.checkIds,
      components: [],
      start: utcInputValue(window.start),
      end: utcInputValue(window.end),
      note: window.note,
    },
  });
}

type Saving = {
  target: string | undefined;
  input: MaintenanceInput;
  config: AdminConfigResponse;
  revision: string;
  stored: StoredTimes | undefined;
  reopen: string;
};

function writeAnswerPage(
  answer: WriteAnswer,
  kept: string,
  reopen: string,
  formOf: (message: string, status: number) => PageResult,
): PageResult {
  switch (answer.kind) {
    case "saved":
      return answer.isLogged
        ? { kind: "redirect", location: "/maintenance?saved=1" }
        : savedNotLogged();
    case "form":
      return formOf(answer.message, answer.status);
    case "text":
      if (answer.reason === "token-rejected") {
        return page(answer.status, "Not saved", kept, tokenRejectedBanner());
      }
      if (answer.reason === "stale") return staleFormPage(reopen, kept, 412);
      return page(answer.status, "Not saved", alertCallout(answer.message) + kept);
    default: {
      const never: never = answer;
      return never;
    }
  }
}

function savedNotLogged(): PageResult {
  return page(
    200,
    "Saved",
    `${callout({ kind: "warning", body: paragraph(SAVED_NOT_LOGGED_TEXT), role: "alert" })}<p><a href="${LIST_PATH}">Open Maintenance</a></p>\n`,
  );
}

async function save(
  deps: MaintenanceRouteDeps,
  request: PageRequest,
  saving: Saving,
): Promise<PageResult> {
  const { target, input, config, revision } = saving;
  const formOf = (notice: string | undefined, status: number, errors?: MaintenanceErrors) =>
    formPage(request, { status, target, revision, input, config, errors, notice });
  const built = maintenanceBody(input, config.components, saving.stored);
  if (!built.ok) return formOf(undefined, 422, built.errors);
  const body = JSON.stringify(built.body);
  if (!isWithinApiBodyLimit(body)) return formOf(MAINTENANCE_TOO_LARGE_TEXT, 422);
  const role = routeRole(target === undefined ? "maintenance.create" : "maintenance.edit");
  const kept = maintenanceKeptHtml(input);
  const guard = writeGuardProblem(writeDeps(deps), request, role, saving.reopen);
  if (guard !== undefined) {
    return guard.kind === "page" ? { ...guard, body: guard.body + kept } : guard;
  }
  const id = built.body.id;
  const apiUrl = apiUrlOf(deps);
  const answer = await sendApiWrite(
    writeDeps(deps),
    {
      action: target === undefined ? "maintenance.create" : "maintenance.replace",
      targetOf: () => ({ kind: "maintenance", id }),
      logMessage: "maintenance change",
      logIds: { windowId: id },
      method: target === undefined ? "POST" : "PUT",
      url:
        target === undefined
          ? `${apiUrl}/admin/maintenance`
          : `${apiUrl}/admin/maintenance/${encodeURIComponent(target)}`,
      revision,
      body,
      savedValue: "revision",
      texts: TEXTS,
    },
    request.user,
  );
  return writeAnswerPage(answer, kept, saving.reopen, (message, status) => formOf(message, status));
}

async function createWindow(deps: MaintenanceRouteDeps, request: PageRequest): Promise<PageResult> {
  const input = inputOf(request, fieldOf(request, "id"));
  const revision = fieldOf(request, "revision");
  const kept = maintenanceKeptHtml(input);
  const read = await readCheckConfig(apiUrlOf(deps), readDeps(deps));
  if (read.kind !== "ok") return problemPage(read, NEW_PATH, "Plan maintenance", kept);
  if (read.config.revision !== revision) return staleFormPage(NEW_PATH, kept);
  return save(deps, request, {
    target: undefined,
    input,
    config: read.config,
    revision,
    stored: undefined,
    reopen: NEW_PATH,
  });
}

async function editWindow(
  deps: MaintenanceRouteDeps,
  request: PageRequest,
  target: string,
): Promise<PageResult> {
  const reopen = editHref(target);
  const input = inputOf(request, target);
  const revision = fieldOf(request, "revision");
  const kept = maintenanceKeptHtml(input);
  const title = "Edit maintenance window";
  // Both reads always run before any comparison (section 13, step 1).
  const read = await readMaintenanceAndConfig(apiUrlOf(deps), readDeps(deps));
  if (read.kind !== "ok") return problemPage(read, reopen, title, kept);
  if (read.list.revision !== revision || read.config.revision !== revision) {
    return staleFormPage(reopen, kept);
  }
  const place = windowPlace(read.list, target);
  if (place.kind === "missing") return notFound(WINDOW_GONE_TEXT);
  if (place.kind !== "database") return page(409, title, alertCallout(FILE_WINDOW_TEXT) + kept);
  return save(deps, request, {
    target,
    input,
    config: read.config,
    revision,
    stored: { start: place.window.start, end: place.window.end },
    reopen,
  });
}

function newRoute(deps: MaintenanceRouteDeps): ProtectedRoute {
  return {
    path: NEW_PATH,
    methods: ["GET", "POST"],
    requiredRole: routeRole("maintenance.create"),
    navId: "maintenance",
    knownFields: ["revision", "id", "start", "end", "note"],
    listFields: { check: 1000, component: 1000 },
    maxFormBytes: MAX_MAINTENANCE_FORM_BYTES,
    reopenHrefOf: () => NEW_PATH,
    handle: (request) =>
      request.method === "POST" ? createWindow(deps, request) : showForm(deps, request, undefined),
    renderForm: (request) => expiredPage(request, NEW_PATH),
  };
}

function editRoute(deps: MaintenanceRouteDeps): ProtectedRoute {
  return {
    path: EDIT_PATH,
    methods: ["GET", "POST"],
    requiredRole: routeRole("maintenance.edit"),
    navId: "maintenance",
    knownFields: ["revision", "target", "start", "end", "note"],
    listFields: { check: 1000, component: 1000 },
    maxFormBytes: MAX_MAINTENANCE_FORM_BYTES,
    reopenHrefOf: (request) => {
      const id = queryIdOf(request.query);
      return id === undefined ? LIST_PATH : editHref(id);
    },
    handle: async (request) => {
      const id = queryIdOf(request.query);
      if (id === undefined) return notFound();
      if (request.method !== "POST") return showForm(deps, request, id);
      const target = postedTargetOf(request);
      return target === undefined ? notFound() : editWindow(deps, request, target);
    },
    renderForm: (request) => expiredPage(request, EDIT_PATH),
  };
}

// --- Delete -----------------------------------------------------------------------------------

async function showDelete(
  deps: MaintenanceRouteDeps,
  request: PageRequest,
  id: string,
): Promise<PageResult> {
  const reopen = `${DELETE_PATH}?id=${encodeURIComponent(id)}`;
  const read = await readMaintenance(apiUrlOf(deps), readDeps(deps));
  if (read.kind !== "ok") return problemPage(read, reopen, "Delete maintenance window");
  const place = windowPlace(read.list, id);
  if (place.kind !== "database" && place.kind !== "shadowed") return notFound(WINDOW_GONE_TEXT);
  const isShadowed = place.kind === "shadowed";
  const body = plainConfirmPage({
    tone: "danger",
    consequence: isShadowed
      ? `Delete the database copy of ${id}? The file window stays in force.`
      : `Delete maintenance window ${id}?`,
    action: reopen,
    csrf: request.csrf,
    formToken: request.issueFormToken(DELETE_PATH),
    revision: read.list.revision,
    hidden: [["target", id]],
    submitLabel: isShadowed ? "Delete database copy" : "Delete window",
    busyLabel: "Deleting…",
    cancelHref: LIST_PATH,
  });
  return page(200, "Delete maintenance window", body);
}

async function deleteWindow(
  deps: MaintenanceRouteDeps,
  request: PageRequest,
  id: string,
): Promise<PageResult> {
  const reopen = `${DELETE_PATH}?id=${encodeURIComponent(id)}`;
  const guard = writeGuardProblem(
    writeDeps(deps),
    request,
    routeRole("maintenance.delete"),
    reopen,
  );
  if (guard !== undefined) return guard;
  const answer = await sendApiWrite(
    writeDeps(deps),
    {
      action: "maintenance.delete",
      targetOf: () => ({ kind: "maintenance", id }),
      logMessage: "maintenance change",
      logIds: { windowId: id },
      method: "DELETE",
      url: `${apiUrlOf(deps)}/admin/maintenance/${encodeURIComponent(id)}`,
      revision: fieldOf(request, "revision"),
      savedValue: "revision",
      texts: TEXTS,
    },
    request.user,
  );
  if (answer.kind === "saved" && answer.isLogged) {
    return { kind: "redirect", location: "/maintenance?deleted=1" };
  }
  return writeAnswerPage(answer, "", reopen, (message, status) =>
    page(status, "Not deleted", alertCallout(message)),
  );
}

function deleteRoute(deps: MaintenanceRouteDeps): ProtectedRoute {
  return {
    path: DELETE_PATH,
    methods: ["GET", "POST"],
    requiredRole: routeRole("maintenance.delete"),
    navId: "maintenance",
    knownFields: ["revision", "target"],
    reopenHrefOf: (request) => {
      const id = queryIdOf(request.query);
      return id === undefined ? LIST_PATH : `${DELETE_PATH}?id=${encodeURIComponent(id)}`;
    },
    handle: async (request) => {
      const id = queryIdOf(request.query);
      if (id === undefined) return notFound();
      if (request.method !== "POST") return showDelete(deps, request, id);
      const target = postedTargetOf(request);
      return target === undefined ? notFound() : deleteWindow(deps, request, target);
    },
    renderForm: (request) => expiredPage(request, DELETE_PATH),
  };
}

/** The production maintenance routes (section 1). */
export function maintenanceRoutes(deps: MaintenanceRouteDeps): ProtectedRoute[] {
  return [listRoute(deps), newRoute(deps), editRoute(deps), deleteRoute(deps)];
}
