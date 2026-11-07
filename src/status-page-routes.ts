import {
  type AdminStatusSettingsView,
  STATUS_COMPONENT_ORDER_MAX,
  type StatusSettings,
  validateStatusSettings,
} from "@lorenzh/pulse-contract";
import { escapeHtml } from "@lorenzh/pulse-kit";
import type { ApiReadDeps } from "./api-read.ts";
import { readCheckConfig } from "./check-read.ts";
import type { CheckRouteDeps } from "./check-routes.ts";
import {
  type CheckWriteDeps,
  SAVED_NOT_LOGGED_TEXT,
  type WriteAnswer,
  writeGuardProblem,
} from "./check-write.ts";
import { paragraph } from "./html.ts";
import { routeRole } from "./permissions.ts";
import type { PageRequest, PageResult, ProtectedRoute } from "./protected-route.ts";
import { readStatusSettings } from "./runtime-read.ts";
import { sendRuntimeWrite } from "./runtime-write.ts";
import { alertCallout, callout, staleState, tokenRejectedBanner } from "./states.ts";
import {
  lockOf,
  ORDER_INVALID_TEXT,
  STATUS_FLAGS,
  STATUS_PAGE_PATH,
  STATUS_SAVED_TEXT,
  STATUS_TEXT_FIELDS,
  type StatusFormInput,
  statusFormHtml,
  statusProblemView,
} from "./status-page-pages.ts";

/** R3: the body limit of `POST /status-page`; every valid settings form is below 47 000 bytes. */
export const MAX_STATUS_FORM_BYTES = 65_536;

export const LOCKED_FIELD_TEXT = "This field is set on pulse-status and cannot be changed here.";
export const FLAG_INVALID_TEXT = "Choose Not set, On or Off.";
export const COMPONENTS_UNREAD_TEXT = "The components could not be read from pulse-api. Try again.";
const ACTION_INVALID_TEXT = "The form sent an unknown action.";

const COMPONENT_ID = /^[a-z0-9][a-z0-9._-]*$/;
const COMPONENT_ID_MAX = 64;

const STATUS_FORM_FIELDS: readonly string[] = [
  "revision",
  "action",
  "order",
  ...STATUS_TEXT_FIELDS.map((f) => f.name),
  ...STATUS_FLAGS.map((f) => f.name),
];

type FieldError = { name: string; text: string };

/**
 * R3 order reading: absent or empty is "not set" (`[]`); else the value split on `,`. An empty
 * item, an id that breaks the component id rule or more than 500 items is invalid. Duplicates
 * and unknown ids are left to pulse-api.
 */
export function parseOrder(value: string | undefined): readonly string[] | undefined {
  if (value === undefined || value === "") return [];
  const ids = value.split(",");
  if (ids.length > STATUS_COMPONENT_ORDER_MAX) return undefined;
  const isValid = ids.every((id) => id.length <= COMPONENT_ID_MAX && COMPONENT_ID.test(id));
  return isValid ? ids : undefined;
}

type Action =
  | { kind: "save" }
  | { kind: "reset" }
  | { kind: "move"; from: number; to: number }
  | { kind: "invalid" };

function actionOf(value: string | undefined): Action {
  if (value === undefined || value === "save") return { kind: "save" };
  if (value === "reset-order") return { kind: "reset" };
  const match = /^(up|down):(0|[1-9]\d{0,3})$/.exec(value);
  if (match === null) return { kind: "invalid" };
  const from = Number(match[2]);
  return { kind: "move", from, to: match[1] === "up" ? from - 1 : from + 1 };
}

/** Moves one item; a position outside the list is ignored. */
function moved(order: readonly string[], from: number, to: number): readonly string[] {
  if (from >= order.length || to < 0 || to >= order.length) return order;
  const next = [...order];
  const [item] = next.splice(from, 1);
  if (item === undefined) return order;
  next.splice(to, 0, item);
  return next;
}

function settingAt(settings: StatusSettings, path: string): unknown {
  let value: unknown = settings;
  for (const part of path.split(".")) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, part))
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function flagText(value: unknown): string {
  if (value === true) return "on";
  if (value === false) return "off";
  return "";
}

/** The form input of the stored settings. */
function storedInputOf(view: AdminStatusSettingsView): StatusFormInput {
  const values: Record<string, string> = {};
  for (const f of STATUS_TEXT_FIELDS) {
    const value = settingAt(view.settings, f.path);
    values[f.name] = typeof value === "string" ? value : "";
  }
  for (const flag of STATUS_FLAGS) values[flag.name] = flagText(view.settings[flag.key]);
  return { values, order: view.settings.componentOrder ?? [] };
}

function postedInputOf(fields: PageRequest["fields"], order: readonly string[]): StatusFormInput {
  const values: Record<string, string> = {};
  for (const f of STATUS_TEXT_FIELDS) values[f.name] = fields[f.name] ?? "";
  for (const flag of STATUS_FLAGS) values[flag.name] = fields[flag.name] ?? "";
  return { values, order };
}

/** The posted fields that a fresh report locks: a forged write of a read-only field. */
function forgedLocks(view: AdminStatusSettingsView, fields: PageRequest["fields"]): FieldError[] {
  const named = [
    ...STATUS_TEXT_FIELDS.map((f) => ({ name: f.name, path: f.path })),
    ...STATUS_FLAGS.map((f) => ({ name: f.name, path: f.key as string })),
    { name: "order", path: "componentOrder" },
  ];
  return named
    .filter((f) => Object.hasOwn(fields, f.name) && lockOf(view, f.path) !== undefined)
    .map((f) => ({ name: f.name, text: LOCKED_FIELD_TEXT }));
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  const last = parts.pop();
  if (last === undefined) return;
  let node = target;
  for (const part of parts) {
    const child = node[part];
    const next =
      typeof child === "object" && child !== null ? (child as Record<string, unknown>) : {};
    node[part] = next;
    node = next;
  }
  node[last] = value;
}

/** The document of a save: posted values, and the stored value of every locked field. */
function documentOf(
  view: AdminStatusSettingsView,
  input: StatusFormInput,
): { document: Record<string, unknown>; errors: FieldError[] } {
  const document: Record<string, unknown> = {};
  const errors: FieldError[] = [];
  const keep = (path: string, posted: unknown): void => {
    const value = lockOf(view, path) === undefined ? posted : settingAt(view.settings, path);
    if (value !== undefined) setPath(document, path, value);
  };
  for (const f of STATUS_TEXT_FIELDS) {
    const text = input.values[f.name] ?? "";
    keep(f.path, text === "" ? undefined : text);
  }
  for (const flag of STATUS_FLAGS) {
    const text = input.values[flag.name] ?? "";
    if (text !== "" && text !== "on" && text !== "off") {
      errors.push({ name: flag.name, text: FLAG_INVALID_TEXT });
    }
    keep(flag.key, text === "" ? undefined : text === "on");
  }
  keep("componentOrder", input.order.length === 0 ? undefined : [...input.order]);
  return { document, errors };
}

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

type FormView = {
  view: AdminStatusSettingsView;
  input: StatusFormInput;
  errors?: readonly FieldError[] | undefined;
  status: number;
  /** A callout above the form. */
  notice?: string | undefined;
  banner?: string | undefined;
};

function formPage(request: PageRequest, form: FormView): PageResult {
  const html = statusFormHtml({
    csrf: request.csrf,
    formToken: request.issueFormToken(STATUS_PAGE_PATH),
    view: form.view,
    input: form.input,
    errors: form.errors ?? [],
  });
  return {
    kind: "page",
    status: form.status,
    title: "Status page",
    body: (form.notice ?? "") + html,
    banner: form.banner,
  };
}

function keptInputText(input: StatusFormInput): string {
  const rows = Object.entries(input.values)
    .filter(([, value]) => value !== "")
    .map(
      ([name, value]) =>
        `<li><span class="mono">${escapeHtml(name)}</span>: ${escapeHtml(value)}</li>`,
    );
  if (input.order.length > 0) {
    rows.push(`<li><span class="mono">order</span>: ${escapeHtml(input.order.join(","))}</li>`);
  }
  return rows.length === 0 ? "" : `<h2>Your input</h2>\n<ul>\n${rows.join("\n")}\n</ul>\n`;
}

async function showStatus(deps: CheckRouteDeps, request: PageRequest): Promise<PageResult> {
  const read = await readStatusSettings(apiUrlOf(deps), readDeps(deps));
  if (read.kind !== "ok") {
    const problem = statusProblemView(read);
    const status = read.kind === "old-api" ? 404 : 200;
    return {
      kind: "page",
      status,
      title: "Status page",
      body: problem.body,
      banner: problem.banner || undefined,
    };
  }
  const saved =
    request.query.get("saved") === "1"
      ? callout({ kind: "success", body: paragraph(STATUS_SAVED_TEXT), role: "status" })
      : "";
  return formPage(request, {
    view: read.view,
    input: storedInputOf(read.view),
    status: 200,
    notice: saved,
  });
}

function answerPage(
  request: PageRequest,
  answer: WriteAnswer,
  form: Omit<FormView, "status">,
): PageResult {
  switch (answer.kind) {
    case "saved":
      if (answer.isLogged) return { kind: "redirect", location: `${STATUS_PAGE_PATH}?saved=1` };
      return {
        kind: "page",
        status: 200,
        title: "Saved",
        body: `${callout({ kind: "warning", body: paragraph(SAVED_NOT_LOGGED_TEXT), role: "alert" })}<p><a href="${STATUS_PAGE_PATH}">Open the status page settings</a></p>\n`,
      };
    case "form":
      return formPage(request, {
        ...form,
        status: answer.status,
        errors: [{ name: "name", text: answer.message }],
      });
    case "text": {
      if (answer.reason === "token-rejected") {
        return formPage(request, { ...form, status: answer.status, banner: tokenRejectedBanner() });
      }
      const notice =
        answer.reason === "stale"
          ? staleState({ status: 412, reloadHref: STATUS_PAGE_PATH })
          : alertCallout(answer.message);
      return formPage(request, { ...form, status: answer.status, notice });
    }
    default: {
      const never: never = answer;
      return never;
    }
  }
}

async function resetPage(
  deps: CheckRouteDeps,
  request: PageRequest,
  form: Omit<FormView, "status">,
): Promise<PageResult> {
  const config = await readCheckConfig(apiUrlOf(deps), readDeps(deps));
  if (config.kind !== "ok") {
    return formPage(request, {
      ...form,
      status: 502,
      errors: [{ name: "order", text: COMPONENTS_UNREAD_TEXT }],
    });
  }
  const order = config.config.components.map((c) => c.id).slice(0, STATUS_COMPONENT_ORDER_MAX);
  return formPage(request, { ...form, input: { ...form.input, order }, status: 200 });
}

async function saveStatus(
  deps: CheckRouteDeps,
  request: PageRequest,
  form: Omit<FormView, "status">,
): Promise<PageResult> {
  const { view, input } = form;
  if ((request.fields.revision ?? "") !== view.revision) {
    const notice = staleState({ status: 409, reloadHref: STATUS_PAGE_PATH });
    return formPage(request, { ...form, status: 409, notice });
  }
  const built = documentOf(view, input);
  if (built.errors.length > 0)
    return formPage(request, { ...form, status: 422, errors: built.errors });
  // R3: duplicates go to pulse-api, whose 422 names them; every other rule is checked here.
  const order = built.document.componentOrder;
  const unique = Array.isArray(order)
    ? { ...built.document, componentOrder: [...new Set(order)] }
    : built.document;
  const valid = validateStatusSettings(unique);
  if (!valid.ok) {
    return formPage(request, {
      ...form,
      status: 422,
      errors: [{ name: "name", text: valid.error }],
    });
  }
  const guard = writeGuardProblem(
    writeDeps(deps),
    request,
    routeRole("settings.edit"),
    STATUS_PAGE_PATH,
  );
  if (guard !== undefined) {
    return guard.kind === "page" ? { ...guard, body: guard.body + keptInputText(input) } : guard;
  }
  const answer = await sendRuntimeWrite(
    writeDeps(deps),
    {
      action: "status-settings.replace",
      target: { kind: "status-settings" },
      method: "PUT",
      url: `${apiUrlOf(deps)}/admin/status/settings`,
      revision: view.revision,
      body: JSON.stringify(built.document),
    },
    request.user,
  );
  return answerPage(request, answer, form);
}

/** R3 order after the dispatcher: read, locks, order, action, then revision, document, guard, PUT. */
async function postStatus(deps: CheckRouteDeps, request: PageRequest): Promise<PageResult> {
  const read = await readStatusSettings(apiUrlOf(deps), readDeps(deps));
  const order = parseOrder(request.fields.order);
  const input = postedInputOf(request.fields, order ?? []);
  if (read.kind !== "ok") {
    const problem = statusProblemView(read);
    return {
      kind: "page",
      status: read.kind === "old-api" ? 404 : 502,
      title: "Not saved",
      body: problem.body + keptInputText(input),
      banner: problem.banner || undefined,
    };
  }
  const form = { view: read.view, input };
  const forged = forgedLocks(read.view, request.fields);
  if (forged.length > 0) return formPage(request, { ...form, status: 422, errors: forged });
  if (order === undefined) {
    // The raw value split on `,` joins back to the posted value, so the input is kept as sent.
    const kept = { ...form, input: { ...input, order: (request.fields.order ?? "").split(",") } };
    return formPage(request, {
      ...kept,
      status: 422,
      errors: [{ name: "order", text: ORDER_INVALID_TEXT }],
    });
  }
  const action = actionOf(request.fields.action);
  switch (action.kind) {
    case "move":
      return formPage(request, {
        ...form,
        input: { ...input, order: moved(order, action.from, action.to) },
        status: 200,
      });
    case "reset":
      return resetPage(deps, request, form);
    case "invalid":
      return formPage(request, {
        ...form,
        status: 400,
        errors: [{ name: "order", text: ACTION_INVALID_TEXT }],
      });
    case "save":
      return saveStatus(deps, request, form);
    default: {
      const never: never = action;
      return never;
    }
  }
}

/** R3: `GET|POST /status-page`, Owner. */
export function statusPageRoutes(deps: CheckRouteDeps): ProtectedRoute[] {
  return [
    {
      path: STATUS_PAGE_PATH,
      methods: ["GET", "POST"],
      requiredRole: routeRole("settings.edit"),
      navId: "status-page",
      knownFields: STATUS_FORM_FIELDS,
      maxFormBytes: MAX_STATUS_FORM_BYTES,
      handle: (request) =>
        request.method === "POST" ? postStatus(deps, request) : showStatus(deps, request),
    },
  ];
}
