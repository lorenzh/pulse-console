import type { AdminCheckView, AdminConfigResponse } from "@lorenzh/pulse-contract";
import { escapeHtml, type Logger } from "@lorenzh/pulse-kit";
import type { AccountStore, User } from "./account-store.ts";
import { apiIdSegment } from "./api-path.ts";
import type { ApiReadDeps, FetchLike } from "./api-read.ts";
import { checkDetailPage, type DetailPage, shadowedPage } from "./check-detail-pages.ts";
import {
  checkEditorHtml,
  checkTypeChoiceHtml,
  createInputOf,
  editInputOf,
  NOT_KEPT_TEXT,
  type RetainedInput,
  retainedInputOf,
  type StoredRows,
  storedRowsOf,
} from "./check-editor-page.ts";
import { exportBody, shadowedCheckExport, singleCheckExport } from "./check-export.ts";
import { parseCheckFilters } from "./check-filters.ts";
import {
  CHECK_FORM_FIELDS,
  type CheckType,
  type FieldError,
  isCheckType,
  parseCreateForm,
  parseEditForm,
} from "./check-form.ts";
import {
  checkListView,
  checkProblemView,
  idQuery,
  link,
  TYPE_LABELS,
  UNADDRESSABLE,
} from "./check-pages.ts";
import {
  readCheckConfig,
  readCheckDetail,
  readCheckExport,
  readCheckList,
  resultsBeforeOf,
} from "./check-read.ts";
import {
  type CheckWriteDeps,
  isWithinApiBodyLimit,
  NO_REASON_TEXT,
  SAVED_NOT_LOGGED_TEXT,
  sendCheckWrite,
  type WriteAnswer,
  writeGuardProblem,
} from "./check-write.ts";
import { typedConfirmPage, typedNameError } from "./confirm.ts";
import { MAX_CHECK_FORM_BYTES } from "./forms.ts";
import { paragraph } from "./html.ts";
import { isAllowed, routeRole } from "./permissions.ts";
import type { PageRequest, PageResult, ProtectedRoute } from "./protected-route.ts";
import type { ConsoleRole } from "./roles.ts";
import { alertCallout, callout, notFoundState, staleState, tokenRejectedBanner } from "./states.ts";

export type CheckRouteDeps = {
  store: AccountStore;
  defaultApiUrl: string;
  adminToken: string | undefined;
  fetch: FetchLike;
  schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
  roleOf?: ((user: User) => ConsoleRole) | undefined;
  now: () => number;
  log: Logger;
};

function apiUrlOf(deps: CheckRouteDeps): string {
  return deps.store.instance()?.apiUrl ?? deps.defaultApiUrl;
}

function readDeps(deps: CheckRouteDeps): ApiReadDeps {
  return {
    fetch: deps.fetch,
    token: deps.adminToken,
    schedule: deps.schedule,
    warn: (message, fields) => deps.log.warn(message, fields),
  };
}

function notFound(): PageResult {
  return { kind: "page", status: 404, title: "Page not found", body: notFoundState() };
}

/** R1: `GET /checks`, Viewer+. */
function listRoute(deps: CheckRouteDeps): ProtectedRoute {
  return {
    path: "/checks",
    methods: ["GET"],
    requiredRole: routeRole("overview.view"),
    navId: "checks",
    handle: async (request) => {
      const read = await readCheckList(apiUrlOf(deps), readDeps(deps));
      const view = checkListView(read, parseCheckFilters(request.query), request.role);
      const banner = view.banner === "" ? undefined : view.banner;
      const deleted =
        request.query.get("deleted") === "1"
          ? callout({ kind: "success", body: paragraph(CHECK_DELETED_TEXT), role: "status" })
          : "";
      return { kind: "page", status: 200, title: "Checks", body: deleted + view.body, banner };
    },
  };
}

/** Decision 4: the query id, present once and non-empty; else `undefined` (the shell 404). */
function queryIdOf(query: URLSearchParams): string | undefined {
  const ids = query.getAll("id");
  const [id] = ids;
  return ids.length === 1 && id !== undefined && id !== "" ? id : undefined;
}

export const CHECK_SAVED_TEXT = "Check saved.";
export const CHECK_DELETED_TEXT = "Check deleted.";

function detailResult(page: DetailPage, isSaved = false): PageResult {
  if (page.kind === "not-found") return notFound();
  const banner = page.view.banner === "" ? undefined : page.view.banner;
  const saved = isSaved
    ? callout({ kind: "success", body: paragraph(CHECK_SAVED_TEXT), role: "status" })
    : "";
  return { kind: "page", status: 200, title: page.title, body: saved + page.view.body, banner };
}

/** R2: `GET /checks/check?id=<id>`, Viewer+. */
function detailRoute(deps: CheckRouteDeps): ProtectedRoute {
  return {
    path: "/checks/check",
    methods: ["GET"],
    requiredRole: routeRole("overview.view"),
    navId: "checks",
    handle: async (request) => {
      const id = queryIdOf(request.query);
      if (id === undefined) return notFound();
      const apiUrl = apiUrlOf(deps);
      const before = resultsBeforeOf(request.query);
      const read = await readCheckDetail(apiUrl, readDeps(deps), id, before);
      const isSaved = request.query.get("saved") === "1";
      return detailResult(checkDetailPage(read, { id, before, role: request.role }), isSaved);
    },
  };
}

/** R3: `GET /checks/shadowed?id=<id>`, Viewer+. Reads only `/admin/config`. */
function shadowedRoute(deps: CheckRouteDeps): ProtectedRoute {
  return {
    path: "/checks/shadowed",
    methods: ["GET"],
    requiredRole: routeRole("overview.view"),
    navId: "checks",
    handle: async (request) => {
      const id = queryIdOf(request.query);
      if (id === undefined) return notFound();
      const read = await readCheckConfig(apiUrlOf(deps), readDeps(deps));
      const shown =
        read.kind === "ok"
          ? { kind: "ok" as const, view: read.config.shadowed.find((check) => check.id === id) }
          : read;
      return detailResult(shadowedPage(shown, id, request.role));
    },
  };
}

/** The export a query asks for; `undefined` for any other query shape (Decision 4). */
type ExportTarget =
  | { kind: "all" }
  | { kind: "single"; id: string }
  | { kind: "shadowed"; id: string };

function exportTargetOf(query: URLSearchParams): ExportTarget | undefined {
  const keys = [...query.keys()];
  if (keys.length === 0) return { kind: "all" };
  const id = queryIdOf(query);
  if (id === undefined || keys[0] !== "id") return undefined;
  if (keys.length === 1) return { kind: "single", id };
  const isShadowed = keys.length === 2 && keys[1] === "shadowed" && query.get("shadowed") === "1";
  return isShadowed ? { kind: "shadowed", id } : undefined;
}

function problemPage(view: { banner: string; body: string }, title = "Export"): PageResult {
  const banner = view.banner === "" ? undefined : view.banner;
  return { kind: "page", status: 502, title, body: view.body, banner };
}

async function exportOf(target: ExportTarget, deps: CheckRouteDeps): Promise<PageResult> {
  const apiUrl = apiUrlOf(deps);
  if (target.kind === "shadowed") {
    const read = await readCheckConfig(apiUrl, readDeps(deps));
    if (read.kind !== "ok") return problemPage(checkProblemView(read, "/checks"));
    const view = read.config.shadowed.find((check) => check.id === target.id);
    if (view === undefined) return notFound();
    const built = shadowedCheckExport(view);
    if (built.kind === "invalid") {
      deps.log.warn("check export invalid", { kind: "shadowed" });
      return problemPage(
        checkProblemView({ kind: "failed", failure: { kind: "invalid" } }, "/checks"),
      );
    }
    return { kind: "download", filename: "check.json", body: exportBody(built.document) };
  }
  const read = await readCheckExport(apiUrl, readDeps(deps));
  if (read.kind !== "ok") return problemPage(checkProblemView(read, "/checks"));
  if (target.kind === "all") {
    return { kind: "download", filename: "checks.json", body: exportBody(read.document) };
  }
  const single = singleCheckExport(read.document, target.id);
  if (single === undefined) return notFound();
  return { kind: "download", filename: "check.json", body: exportBody(single) };
}

/** R7: `GET /checks/export[?id=<id>[&shadowed=1]]`, Member+. */
function exportRoute(deps: CheckRouteDeps): ProtectedRoute {
  return {
    path: "/checks/export",
    methods: ["GET"],
    requiredRole: routeRole("check.write"),
    navId: "checks",
    handle: async (request: PageRequest) => {
      const target = exportTargetOf(request.query);
      return target === undefined ? notFound() : exportOf(target, deps);
    },
  };
}

const CREATE_PATH = "/checks/new";
export const CHECK_EXISTS_TEXT = "A check with this id exists.";
export const CHECK_TOO_LARGE_TEXT = "The check is larger than pulse-api accepts (1 MiB).";

function writeDeps(deps: CheckRouteDeps): CheckWriteDeps {
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

function choicePage(status: number, notice?: string): PageResult {
  const top = alertCallout(notice);
  return { kind: "page", status, title: "New check", body: top + checkTypeChoiceHtml() };
}

type CreateView = {
  type: CheckType;
  input: RetainedInput;
  errors: readonly FieldError[];
  status: number;
  notice?: string | undefined;
};

function createEditorPage(request: PageRequest, view: CreateView): PageResult {
  const html = checkEditorHtml({
    type: view.type,
    stored: undefined,
    input: view.input,
    errors: view.errors,
    revision: "",
    csrf: request.csrf,
    formToken: request.issueFormToken(CREATE_PATH),
  });
  const top = alertCallout(view.notice);
  return {
    kind: "page",
    status: view.status,
    title: `New ${TYPE_LABELS[view.type]} check`,
    body: top + html,
  };
}

function typeOf(value: string | null | undefined): CheckType | undefined {
  return value !== null && value !== undefined && isCheckType(value) ? value : undefined;
}

function postedTypeOf(fields: PageRequest["fields"]): CheckType | undefined {
  return typeOf(Object.hasOwn(fields, "type") ? fields.type : undefined);
}

/** The kept non-secret input as text, without a form (R8 "text"). */
function keptInputHtml(input: RetainedInput): string {
  const entries = Object.entries(input.values).filter(
    ([name]) => name !== "revision" && !input.dropped.has(name),
  );
  const dropped = [...input.dropped].map((name) => [name, NOT_KEPT_TEXT] as const);
  const all = [...entries, ...dropped];
  if (all.length === 0) return "";
  const items = all
    .map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("\n");
  return `<h2>Your input</h2>
<dl class="settings">
${items}
</dl>
`;
}

/** A refused page before the write still shows the kept non-secret input (Decision 7). */
function withKeptInput(page: PageResult, input: RetainedInput): PageResult {
  return page.kind === "page" ? { ...page, body: page.body + keptInputHtml(input) } : page;
}

/** The page of a write answer that is not `saved`; `form` re-renders through `formOf`. */
function writeAnswerPage(
  answer: Exclude<WriteAnswer, { kind: "saved" }>,
  input: RetainedInput,
  reloadHref: string,
  formOf: (errors: readonly FieldError[], status: number) => PageResult,
): PageResult {
  if (answer.kind === "form")
    return formOf([{ field: "check", message: answer.message }], answer.status);
  const kept = keptInputHtml(input);
  switch (answer.reason) {
    case "token-rejected":
      return {
        kind: "page",
        status: answer.status,
        title: "Not saved",
        body: kept,
        banner: tokenRejectedBanner(),
      };
    case "stale":
      return {
        kind: "page",
        status: answer.status,
        title: "Not saved",
        body: staleState({ status: 412, reloadHref }) + kept,
      };
    case "gone":
    case "other":
      return {
        kind: "page",
        status: answer.status,
        title: "Not saved",
        body: alertCallout(answer.message) + kept,
      };
    default: {
      const never: never = answer.reason;
      return never;
    }
  }
}

function savedPage(id: string, answer: Extract<WriteAnswer, { kind: "saved" }>): PageResult {
  const href = `/checks/check${idQuery(id)}`;
  if (answer.isLogged) return { kind: "redirect", location: `${href}&saved=1` };
  return {
    kind: "page",
    status: 200,
    title: "Saved",
    body: `${callout({ kind: "warning", body: paragraph(SAVED_NOT_LOGGED_TEXT), role: "alert" })}<p><a href="${escapeHtml(href)}">Open the check</a></p>\n`,
  };
}

/** R4 commit order after the dispatcher: fields, JSON size, config read, id, guard, write. */
async function createCheck(deps: CheckRouteDeps, request: PageRequest): Promise<PageResult> {
  const type = postedTypeOf(request.fields);
  if (type === undefined) return choicePage(422, "Choose a type.");
  const input = retainedInputOf(request.fields, undefined);
  const formOf = (errors: readonly FieldError[], status: number): PageResult =>
    createEditorPage(request, { type, input, errors, status });
  const parsed = parseCreateForm(request.fields);
  if (!parsed.isOk) return formOf(parsed.errors, 422);
  const body = JSON.stringify(parsed.input);
  if (!isWithinApiBodyLimit(body)) {
    return formOf([{ field: "check", message: CHECK_TOO_LARGE_TEXT }], 422);
  }
  const apiUrl = apiUrlOf(deps);
  const read = await readCheckConfig(apiUrl, readDeps(deps));
  if (read.kind !== "ok") {
    const view = checkProblemView(read, `${CREATE_PATH}?type=${type}`);
    return problemPage({ ...view, body: view.body + keptInputHtml(input) }, "New check");
  }
  const { id } = parsed.input;
  const all = [...read.config.checks, ...read.config.shadowed];
  if (all.some((check) => check.id === id)) {
    return formOf([{ field: "id", message: CHECK_EXISTS_TEXT }], 409);
  }
  const guard = writeGuardProblem(writeDeps(deps), request, routeRole("check.write"), CREATE_PATH);
  if (guard !== undefined) return withKeptInput(guard, input);
  const answer = await sendCheckWrite(
    writeDeps(deps),
    {
      action: "check.create",
      checkId: id,
      method: "POST",
      url: `${apiUrl}/admin/checks`,
      revision: read.config.revision,
      body,
    },
    request.user,
  );
  if (answer.kind === "saved") return savedPage(id, answer);
  return writeAnswerPage(answer, input, `${CREATE_PATH}?type=${type}`, formOf);
}

/** R4: `GET|POST /checks/new`, Member+. */
function createRoute(deps: CheckRouteDeps): ProtectedRoute {
  return {
    path: CREATE_PATH,
    methods: ["GET", "POST"],
    requiredRole: routeRole("check.write"),
    navId: "checks",
    knownFields: CHECK_FORM_FIELDS,
    maxFormBytes: MAX_CHECK_FORM_BYTES,
    reopenHrefOf: () => CREATE_PATH,
    handle: async (request) => {
      if (request.method === "POST") return createCheck(deps, request);
      const types = request.query.getAll("type");
      const type = types.length === 1 ? typeOf(types[0]) : undefined;
      if (type === undefined) return choicePage(200);
      return createEditorPage(request, {
        type,
        input: createInputOf(type),
        errors: [],
        status: 200,
      });
    },
    // Decision 13: the posted type's form with the kept non-secret input, else the choice.
    renderForm: (request, notice) => {
      const type = postedTypeOf(request.fields);
      if (type === undefined) return choicePage(409, notice);
      const input = retainedInputOf(request.fields, undefined);
      return createEditorPage(request, { type, input, errors: [], status: 409, notice });
    },
  };
}

const EDIT_PATH = "/checks/edit";
const DELETE_PATH = "/checks/delete";
export const SHADOWED_EDIT_TEXT = "Shadowed by checks.json: only Delete and Export are possible.";
export const FILE_EDIT_TEXT = "This check comes from checks.json. Edit the file to change it.";
export const FILE_DELETE_TEXT = "This check comes from checks.json.";
export const NOT_SAVED_READ_TEXT = "Not saved: the current version could not be read.";
export const NOT_DELETED_READ_TEXT = "Not deleted: the current version could not be read.";
export const CHANGE_EXPIRED_TEXT =
  "This form has expired. Nothing was sent. Open it again to see the current version.";
export const DATABASE_CONSEQUENCE =
  "The check stops running. Its results stay in pulse-api and its open incidents are resolved.";
export const SHADOWED_CONSEQUENCE =
  "Only the database definition is removed. The check from checks.json keeps running.";

/** Decision 14: the 409 text for an id that no api path can carry. */
export function unaddressableText(id: string): string {
  return `pulse-api cannot address the id "${id}" in a URL path, so the Console cannot change or delete it.`;
}

function conflictPage(text: string, links = ""): PageResult {
  return {
    kind: "page",
    status: 409,
    title: "Not possible",
    body: `${alertCallout(text)}${links}`,
  };
}

function shadowedConflict(id: string, role: ConsoleRole): PageResult {
  const links: string[] = [];
  if (isAllowed(role, "check.delete")) links.push(link(`${DELETE_PATH}${idQuery(id)}`, "Delete"));
  if (isAllowed(role, "check.write")) {
    links.push(link(`/checks/export${idQuery(id)}&shadowed=1`, "Export"));
  }
  const html = links.length === 0 ? "" : `<p class="actions">${links.join(" ")}</p>\n`;
  return conflictPage(SHADOWED_EDIT_TEXT, html);
}

type Target<T> = { kind: "ok"; value: T } | { kind: "page"; page: PageResult };

/** R5 step 3: shadowed first (a shadowed id always has an effective file entry), then the rest. */
function editTargetOf(
  config: AdminConfigResponse,
  id: string,
  role: ConsoleRole,
): Target<AdminCheckView> {
  if (config.shadowed.some((check) => check.id === id)) {
    return { kind: "page", page: shadowedConflict(id, role) };
  }
  const view = config.checks.find((check) => check.id === id);
  if (view === undefined) return { kind: "page", page: notFound() };
  if (view.source === "file") return { kind: "page", page: conflictPage(FILE_EDIT_TEXT) };
  if (UNADDRESSABLE.has(id)) return { kind: "page", page: conflictPage(unaddressableText(id)) };
  return { kind: "ok", value: view };
}

type DeleteTarget = { target: "database" | "shadowed"; view: AdminCheckView };

/** R6 step 3: the target from the read; the posted `target` is only compared. */
function deleteTargetOf(config: AdminConfigResponse, id: string): Target<DeleteTarget> {
  const shadowed = config.shadowed.find((check) => check.id === id);
  const view = config.checks.find((check) => check.id === id);
  let found: DeleteTarget | undefined;
  if (shadowed !== undefined) found = { target: "shadowed", view: shadowed };
  else if (view?.source === "database") found = { target: "database", view };
  if (found === undefined) {
    const page = view === undefined ? notFound() : conflictPage(FILE_DELETE_TEXT);
    return { kind: "page", page };
  }
  if (UNADDRESSABLE.has(id)) return { kind: "page", page: conflictPage(unaddressableText(id)) };
  return { kind: "ok", value: found };
}

function stalePage(input: RetainedInput, reloadHref: string): PageResult {
  return {
    kind: "page",
    status: 409,
    title: "Not saved",
    body: staleState({ status: 409, reloadHref }) + keptInputHtml(input),
  };
}

/** R5/R6 step 2: a failed POST-time read, with the kept input as text and a reopen link. */
function readFailedPage(
  view: { banner: string; body: string },
  title: string,
  reopenHref: string,
  input: RetainedInput,
): PageResult {
  const reopen = `<p>${link(reopenHref, "Open it again")}</p>\n`;
  return problemPage({ ...view, body: view.body + keptInputHtml(input) + reopen }, title);
}

/** Decision 13: the expired notice and an id-preserving link, no form and no input. */
function expiredChangePage(request: PageRequest, path: string): PageResult {
  const id = queryIdOf(request.query);
  const href = id === undefined ? undefined : path + idQuery(id);
  const reopen = href === undefined ? "" : `<p>${link(href, "Open it again")}</p>\n`;
  return {
    kind: "page",
    status: 409,
    title: "Form expired",
    body:
      callout({ kind: "warning", body: paragraph(CHANGE_EXPIRED_TEXT), role: "alert" }) + reopen,
  };
}

function reopenOf(path: string): (request: PageRequest) => string {
  return (request) => {
    const id = queryIdOf(request.query);
    return id === undefined ? path : `${path}${idQuery(id)}`;
  };
}

type EditView = {
  stored: StoredRows;
  input: RetainedInput;
  errors: readonly FieldError[];
  revision: string;
  status: number;
};

function editEditorPage(request: PageRequest, view: EditView): PageResult {
  const html = checkEditorHtml({
    type: view.stored.type,
    stored: view.stored,
    input: view.input,
    errors: view.errors,
    revision: view.revision,
    csrf: request.csrf,
    formToken: request.issueFormToken(EDIT_PATH),
  });
  return { kind: "page", status: view.status, title: `Edit ${view.stored.id}`, body: html };
}

function postedRevisionOf(fields: PageRequest["fields"]): string {
  return Object.hasOwn(fields, "revision") ? (fields.revision ?? "") : "";
}

async function showEdit(
  deps: CheckRouteDeps,
  request: PageRequest,
  id: string,
): Promise<PageResult> {
  const reopen = `${EDIT_PATH}${idQuery(id)}`;
  const read = await readCheckConfig(apiUrlOf(deps), readDeps(deps));
  if (read.kind !== "ok") return problemPage(checkProblemView(read, reopen), "Edit check");
  const target = editTargetOf(read.config, id, request.role);
  if (target.kind === "page") return target.page;
  return editEditorPage(request, {
    stored: storedRowsOf(target.value),
    input: editInputOf(target.value),
    errors: [],
    revision: read.config.revision,
    status: 200,
  });
}

/** R5 commit order after the dispatcher: read, target, revision, fields, size, guard, PUT. */
async function editCheck(
  deps: CheckRouteDeps,
  request: PageRequest,
  id: string,
): Promise<PageResult> {
  const reopen = `${EDIT_PATH}${idQuery(id)}`;
  const apiUrl = apiUrlOf(deps);
  const read = await readCheckConfig(apiUrl, readDeps(deps));
  if (read.kind !== "ok") {
    const input = retainedInputOf(request.fields, undefined);
    return readFailedPage(checkProblemView(read, reopen), NOT_SAVED_READ_TEXT, reopen, input);
  }
  const target = editTargetOf(read.config, id, request.role);
  if (target.kind === "page") {
    return withKeptInput(target.page, retainedInputOf(request.fields, undefined));
  }
  const revision = postedRevisionOf(request.fields);
  // The form was built from an older layout: classify by posted kind, not by the new stored rows.
  if (revision !== read.config.revision) {
    return stalePage(retainedInputOf(request.fields, undefined), reopen);
  }
  const stored = storedRowsOf(target.value);
  const input = retainedInputOf(request.fields, stored);
  const formOf = (errors: readonly FieldError[], status: number): PageResult =>
    editEditorPage(request, { stored, input, errors, revision, status });
  const parsed = parseEditForm(request.fields, target.value);
  if (!parsed.isOk) return formOf(parsed.errors, 422);
  const body = JSON.stringify(parsed.input);
  if (!isWithinApiBodyLimit(body)) {
    return formOf([{ field: "check", message: CHECK_TOO_LARGE_TEXT }], 422);
  }
  const guard = writeGuardProblem(writeDeps(deps), request, routeRole("check.write"), reopen);
  if (guard !== undefined) return withKeptInput(guard, input);
  const segment = apiIdSegment(id);
  if (segment === undefined) return withKeptInput(conflictPage(unaddressableText(id)), input);
  const answer = await sendCheckWrite(
    writeDeps(deps),
    {
      action: "check.replace",
      checkId: id,
      method: "PUT",
      url: `${apiUrl}/admin/checks/${segment}`,
      revision,
      body,
    },
    request.user,
  );
  if (answer.kind === "saved") return savedPage(id, answer);
  return writeAnswerPage(answer, input, reopen, formOf);
}

/** R5: `GET|POST /checks/edit?id=<id>`, Member+. */
function editRoute(deps: CheckRouteDeps): ProtectedRoute {
  return {
    path: EDIT_PATH,
    methods: ["GET", "POST"],
    requiredRole: routeRole("check.write"),
    navId: "checks",
    knownFields: CHECK_FORM_FIELDS,
    maxFormBytes: MAX_CHECK_FORM_BYTES,
    reopenHrefOf: reopenOf(EDIT_PATH),
    handle: async (request) => {
      const id = queryIdOf(request.query);
      if (id === undefined) return notFound();
      return request.method === "POST" ? editCheck(deps, request, id) : showEdit(deps, request, id);
    },
    renderForm: (request) => expiredChangePage(request, EDIT_PATH),
  };
}

type ConfirmModel = {
  id: string;
  found: DeleteTarget;
  revision: string;
  status: number;
  typed?: string | undefined;
  error?: string | undefined;
};

function deleteConfirmPage(request: PageRequest, model: ConfirmModel): PageResult {
  const isShadowed = model.found.target === "shadowed";
  const query = idQuery(model.id);
  const body = typedConfirmPage({
    consequence: isShadowed ? SHADOWED_CONSEQUENCE : DATABASE_CONSEQUENCE,
    action: `${DELETE_PATH}${query}`,
    csrf: request.csrf,
    formToken: request.issueFormToken(DELETE_PATH),
    revision: model.revision,
    hidden: [["target", model.found.target]],
    submitLabel: "Delete check",
    busyLabel: "Deleting…",
    cancelHref: isShadowed ? `/checks/shadowed${query}` : `/checks/check${query}`,
    targetName: model.found.view.name.trim(),
    typed: model.typed,
    error: model.error,
  });
  return { kind: "page", status: model.status, title: "Delete check", body };
}

async function showDelete(
  deps: CheckRouteDeps,
  request: PageRequest,
  id: string,
): Promise<PageResult> {
  const reopen = `${DELETE_PATH}${idQuery(id)}`;
  const read = await readCheckConfig(apiUrlOf(deps), readDeps(deps));
  if (read.kind !== "ok") return problemPage(checkProblemView(read, reopen), "Delete check");
  const target = deleteTargetOf(read.config, id);
  if (target.kind === "page") return target.page;
  return deleteConfirmPage(request, {
    id,
    found: target.value,
    revision: read.config.revision,
    status: 200,
  });
}

const NO_INPUT: RetainedInput = { values: {}, dropped: new Set() };

/** R6 commit order after the dispatcher: read, target, revision, typed name, guard, DELETE. */
async function deleteCheck(
  deps: CheckRouteDeps,
  request: PageRequest,
  id: string,
): Promise<PageResult> {
  const reopen = `${DELETE_PATH}${idQuery(id)}`;
  const apiUrl = apiUrlOf(deps);
  const read = await readCheckConfig(apiUrl, readDeps(deps));
  if (read.kind !== "ok") {
    return readFailedPage(checkProblemView(read, reopen), NOT_DELETED_READ_TEXT, reopen, NO_INPUT);
  }
  const target = deleteTargetOf(read.config, id);
  if (target.kind === "page") return target.page;
  const found = target.value;
  const posted = Object.hasOwn(request.fields, "target") ? request.fields.target : undefined;
  const revision = postedRevisionOf(request.fields);
  if (posted !== found.target || revision !== read.config.revision) {
    return stalePage(NO_INPUT, reopen);
  }
  const typed = Object.hasOwn(request.fields, "confirm_name")
    ? (request.fields.confirm_name ?? "")
    : "";
  const formOf = (error: string, status: number): PageResult =>
    deleteConfirmPage(request, { id, found, revision, status, typed, error });
  const error = typedNameError(typed, found.view.name);
  if (error !== undefined) return formOf(error, 422);
  const guard = writeGuardProblem(writeDeps(deps), request, routeRole("check.delete"), reopen);
  if (guard !== undefined) return guard;
  const segment = apiIdSegment(id);
  if (segment === undefined) return conflictPage(unaddressableText(id));
  const answer = await sendCheckWrite(
    writeDeps(deps),
    {
      action: "check.delete",
      checkId: id,
      method: "DELETE",
      url: `${apiUrl}/admin/checks/${segment}`,
      revision,
    },
    request.user,
  );
  if (answer.kind === "saved") {
    if (answer.isLogged) return { kind: "redirect", location: "/checks?deleted=1" };
    return {
      kind: "page",
      status: 200,
      title: "Deleted",
      body: `${callout({ kind: "warning", body: paragraph(SAVED_NOT_LOGGED_TEXT), role: "alert" })}<p>${link("/checks", "Open the checks")}</p>\n`,
    };
  }
  return writeAnswerPage(answer, NO_INPUT, reopen, (errors, status) =>
    formOf(errors[0]?.message ?? NO_REASON_TEXT, status),
  );
}

/** R6: `GET|POST /checks/delete?id=<id>`, Admin+. */
function deleteRoute(deps: CheckRouteDeps): ProtectedRoute {
  return {
    path: DELETE_PATH,
    methods: ["GET", "POST"],
    requiredRole: routeRole("check.delete"),
    navId: "checks",
    knownFields: ["revision", "target", "confirm_name"],
    reopenHrefOf: reopenOf(DELETE_PATH),
    handle: async (request) => {
      const id = queryIdOf(request.query);
      if (id === undefined) return notFound();
      return request.method === "POST"
        ? deleteCheck(deps, request, id)
        : showDelete(deps, request, id);
    },
    renderForm: (request) => expiredChangePage(request, DELETE_PATH),
  };
}

/** The production Checks routes. */
export function checkRoutes(deps: CheckRouteDeps): ProtectedRoute[] {
  return [
    listRoute(deps),
    detailRoute(deps),
    shadowedRoute(deps),
    exportRoute(deps),
    createRoute(deps),
    editRoute(deps),
    deleteRoute(deps),
  ];
}
