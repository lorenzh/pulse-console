import { escapeHtml, type Logger } from "@lorenzh/pulse-kit";
import type { AccountStore, User } from "./account-store.ts";
import type { ApiReadDeps, FetchLike } from "./api-read.ts";
import { checkDetailPage, type DetailPage, shadowedPage } from "./check-detail-pages.ts";
import {
  checkEditorHtml,
  checkTypeChoiceHtml,
  createInputOf,
  type RetainedInput,
  retainedInputOf,
} from "./check-editor-page.ts";
import { exportBody, shadowedCheckExport, singleCheckExport } from "./check-export.ts";
import { parseCheckFilters } from "./check-filters.ts";
import {
  CHECK_FORM_FIELDS,
  type CheckType,
  type FieldError,
  isCheckType,
  parseCreateForm,
} from "./check-form.ts";
import { checkListView, checkProblemView, idQuery, TYPE_LABELS } from "./check-pages.ts";
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
  SAVED_NOT_LOGGED_TEXT,
  sendCheckWrite,
  type WriteAnswer,
  writeGuardProblem,
} from "./check-write.ts";
import { MAX_CHECK_FORM_BYTES } from "./forms.ts";
import { paragraph } from "./html.ts";
import { routeRole } from "./permissions.ts";
import type { PageRequest, PageResult, ProtectedRoute } from "./protected-route.ts";
import type { ConsoleRole } from "./roles.ts";
import { notFoundState, staleState, tokenRejectedBanner } from "./states.ts";

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
      return { kind: "page", status: 200, title: "Checks", body: view.body, banner };
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

function detailResult(page: DetailPage, isSaved = false): PageResult {
  if (page.kind === "not-found") return notFound();
  const banner = page.view.banner === "" ? undefined : page.view.banner;
  const saved = isSaved ? paragraph(CHECK_SAVED_TEXT, ' role="status"') : "";
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
      return detailResult(
        checkDetailPage(read, { id, before, role: request.role, apiUrl }),
        isSaved,
      );
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
  const top = notice === undefined ? "" : paragraph(notice, ' role="alert"');
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
  const top = view.notice === undefined ? "" : paragraph(view.notice, ' role="alert"');
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
  const entries = Object.entries(input.values).filter(([name]) => name !== "revision");
  if (entries.length === 0) return "";
  const items = entries
    .map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("\n");
  return `<h2>Your input</h2>
<dl class="settings">
${items}
</dl>
`;
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
        body: paragraph(answer.message, ' role="alert"') + kept,
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
    body: `${paragraph(SAVED_NOT_LOGGED_TEXT, ' role="alert"')}<p><a href="${escapeHtml(href)}">Open the check</a></p>\n`,
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
    return problemPage(view, "New check");
  }
  const { id } = parsed.input;
  const all = [...read.config.checks, ...read.config.shadowed];
  if (all.some((check) => check.id === id)) {
    return formOf([{ field: "id", message: CHECK_EXISTS_TEXT }], 409);
  }
  const guard = writeGuardProblem(writeDeps(deps), request, routeRole("check.write"), CREATE_PATH);
  if (guard !== undefined) return guard;
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

/** The production Checks routes. Edit and delete follow in a later step. */
export function checkRoutes(deps: CheckRouteDeps): ProtectedRoute[] {
  return [
    listRoute(deps),
    detailRoute(deps),
    shadowedRoute(deps),
    exportRoute(deps),
    createRoute(deps),
  ];
}
