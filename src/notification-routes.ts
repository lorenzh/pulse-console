import { randomBytes } from "node:crypto";
import {
  type AdminNotifyChannelsView,
  isAdminRevision,
  type NotifyDatabaseChannelView,
  validateResendRequest,
} from "@lorenzh/pulse-contract";
import { escapeHtml } from "@lorenzh/pulse-kit";
import { apiIdSegment } from "./api-path.ts";
import type { ApiReadDeps } from "./api-read.ts";
import type { CheckRouteDeps } from "./check-routes.ts";
import {
  type CheckWriteDeps,
  SAVED_NOT_LOGGED_TEXT,
  type WriteAnswer,
  writeGuardProblem,
} from "./check-write.ts";
import { paragraph } from "./html.ts";
import {
  CHANNEL_FORM_FIELDS,
  type ChannelFormError,
  type ChannelFormInput,
  channelInputOf,
  parseChannelForm,
} from "./notification-form.ts";
import {
  CHANNEL_DELETED_TEXT,
  CHANNEL_SAVED_TEXT,
  channelFormHtml,
  channelListHtml,
  DELETE_CHANNEL_PATH,
  deleteFormHtml,
  EDIT_CHANNEL_PATH,
  FAILED_PATH,
  failedListHtml,
  NEW_CHANNEL_PATH,
  NOTIFICATIONS_PATH,
  notifyProblemView,
  RESEND_PATH,
  resendFormHtml,
  resendStateHtml,
  SHADOWED_TEXT,
} from "./notification-pages.ts";
import { routeRole } from "./permissions.ts";
import type { PageRequest, PageResult, ProtectedRoute } from "./protected-route.ts";
import {
  type RuntimeReadProblem,
  readNotifyChannels,
  readNotifyFailed,
  readResendCommand,
} from "./runtime-read.ts";
import { type RuntimeWrite, sendResend, sendRuntimeWrite } from "./runtime-write.ts";
import { alertCallout, callout, notFoundState, staleState, tokenRejectedBanner } from "./states.ts";

/** R3: the body limit of the channel forms; every definition of 16 384 bytes fits in 57 344. */
export const MAX_CHANNEL_FORM_BYTES = 65_536;

export const SHADOWED_EDIT_TEXT = `${SHADOWED_TEXT}: only Delete is possible.`;
export const REVISION_INVALID_TEXT = "The form has no valid revision. Reload the page.";
export const RESEND_INVALID_TEXT = "The resend form is invalid. Open the failed list again.";
export const ID_CHANGED_TEXT = "The id of a saved channel cannot change.";

const COMMAND_ID = /^[A-Za-z0-9_-]{24}$/;
const CHANNEL_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ROLE = routeRole("settings.edit");

/** A new resend `requestId`: 24 random base64url characters (18 random bytes). */
function newRequestId(): string {
  return randomBytes(18).toString("base64url");
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

function problemPage(problem: RuntimeReadProblem, retryHref: string, title: string): PageResult {
  const view = notifyProblemView(problem, retryHref);
  return {
    kind: "page",
    status: problem.kind === "old-api" ? 404 : 200,
    title,
    body: view.body,
    banner: view.banner || undefined,
  };
}

function notFoundPage(): PageResult {
  return { kind: "page", status: 404, title: "Not found", body: notFoundState() };
}

function noticeOf(request: PageRequest): string {
  const text = request.query.get("saved") === "1" ? CHANNEL_SAVED_TEXT : undefined;
  const deleted = request.query.get("deleted") === "1" ? CHANNEL_DELETED_TEXT : undefined;
  const body = text ?? deleted;
  return body === undefined
    ? ""
    : callout({ kind: "success", body: paragraph(body), role: "status" });
}

async function showList(deps: CheckRouteDeps, request: PageRequest): Promise<PageResult> {
  const read = await readNotifyChannels(apiUrlOf(deps), readDeps(deps));
  if (read.kind !== "ok") return problemPage(read, NOTIFICATIONS_PATH, "Notifications");
  return {
    kind: "page",
    status: 200,
    title: "Notifications",
    body: channelListHtml(read.view, noticeOf(request)),
  };
}

type ChannelForm = {
  mode: "new" | "edit";
  revision: string;
  input: ChannelFormInput;
  errors?: readonly ChannelFormError[] | undefined;
  status: number;
  notice?: string | undefined;
  banner?: string | undefined;
};

function formPage(request: PageRequest, form: ChannelForm): PageResult {
  const action = form.mode === "new" ? NEW_CHANNEL_PATH : EDIT_CHANNEL_PATH;
  return {
    kind: "page",
    status: form.status,
    title: form.mode === "new" ? "New channel" : "Edit channel",
    body:
      (form.notice ?? "") +
      channelFormHtml({
        mode: form.mode,
        csrf: request.csrf,
        formToken: request.issueFormToken(action),
        revision: form.revision,
        input: form.input,
        errors: form.errors ?? [],
      }),
    banner: form.banner,
  };
}

function findChannel(
  view: AdminNotifyChannelsView,
  id: string,
): { channel: NotifyDatabaseChannelView; isShadowed: boolean } | undefined {
  const channel = view.channels.find((c) => c.id === id);
  if (channel !== undefined) return { channel, isShadowed: false };
  const shadowed = view.shadowed.find((c) => c.id === id);
  return shadowed === undefined ? undefined : { channel: shadowed, isShadowed: true };
}

async function showNew(deps: CheckRouteDeps, request: PageRequest): Promise<PageResult> {
  const read = await readNotifyChannels(apiUrlOf(deps), readDeps(deps));
  if (read.kind !== "ok") return problemPage(read, NEW_CHANNEL_PATH, "New channel");
  return formPage(request, {
    mode: "new",
    revision: read.view.revision,
    input: { type: "webhook" },
    status: 200,
  });
}

async function showEdit(deps: CheckRouteDeps, request: PageRequest): Promise<PageResult> {
  const id = request.query.get("id") ?? "";
  const read = await readNotifyChannels(apiUrlOf(deps), readDeps(deps));
  if (read.kind !== "ok") return problemPage(read, NOTIFICATIONS_PATH, "Edit channel");
  const found = findChannel(read.view, id);
  if (found === undefined) return notFoundPage();
  if (found.isShadowed) {
    const deleteHref = `${DELETE_CHANNEL_PATH}?id=${encodeURIComponent(id)}`;
    return {
      kind: "page",
      status: 409,
      title: "Edit channel",
      body: `${alertCallout(SHADOWED_EDIT_TEXT)}<p><a href="${escapeHtml(deleteHref)}">Delete the database copy</a></p>\n`,
    };
  }
  return formPage(request, {
    mode: "edit",
    revision: read.view.revision,
    input: channelInputOf(found.channel),
    status: 200,
  });
}

function postedInput(request: PageRequest): ChannelFormInput {
  const input: Partial<Record<(typeof CHANNEL_FORM_FIELDS)[number], string>> = {};
  for (const name of CHANNEL_FORM_FIELDS) {
    const value = request.fields[name];
    if (value !== undefined) input[name] = value;
  }
  return input;
}

function savedPage(answer: { isLogged: boolean }, location: string): PageResult {
  if (answer.isLogged) return { kind: "redirect", location };
  return {
    kind: "page",
    status: 200,
    title: "Saved",
    body: `${callout({ kind: "warning", body: paragraph(SAVED_NOT_LOGGED_TEXT), role: "alert" })}<p><a href="${NOTIFICATIONS_PATH}">Open the notifications</a></p>\n`,
  };
}

function formAnswerPage(request: PageRequest, answer: WriteAnswer, form: ChannelForm): PageResult {
  switch (answer.kind) {
    case "saved":
      return savedPage(answer, `${NOTIFICATIONS_PATH}?saved=1`);
    case "form":
      return formPage(request, {
        ...form,
        status: answer.status,
        errors: [{ name: "id", text: answer.message }],
      });
    case "text": {
      if (answer.reason === "token-rejected") {
        return formPage(request, { ...form, status: answer.status, banner: tokenRejectedBanner() });
      }
      const notice =
        answer.reason === "stale"
          ? staleState({ status: 412, reloadHref: NOTIFICATIONS_PATH })
          : alertCallout(answer.message);
      return formPage(request, { ...form, status: answer.status, notice });
    }
    default: {
      const never: never = answer;
      return never;
    }
  }
}

function channelWrite(
  deps: CheckRouteDeps,
  mode: "new" | "edit",
  id: string,
  revision: string,
  body: string,
): RuntimeWrite | undefined {
  if (mode === "new") {
    return {
      action: "notify-channel.create",
      target: { kind: "notify-channel", id },
      method: "POST",
      url: `${apiUrlOf(deps)}/admin/notify/channels`,
      revision,
      body,
    };
  }
  const segment = apiIdSegment(id);
  if (segment === undefined) return undefined;
  return {
    action: "notify-channel.replace",
    target: { kind: "notify-channel", id },
    method: "PUT",
    url: `${apiUrlOf(deps)}/admin/notify/channels/${segment}`,
    revision,
    body,
  };
}

/** R3 order after the dispatcher: revision, type fields, contract validation, guard, write. */
async function postChannel(
  deps: CheckRouteDeps,
  request: PageRequest,
  mode: "new" | "edit",
): Promise<PageResult> {
  const input = postedInput(request);
  const revision = input.revision ?? "";
  const form: ChannelForm = { mode, revision, input, status: 422 };
  if (!isAdminRevision(revision)) {
    return formPage(request, { ...form, status: 400, notice: alertCallout(REVISION_INVALID_TEXT) });
  }
  const parsed = parseChannelForm(input);
  if (!parsed.isOk) return formPage(request, { ...form, errors: parsed.errors });
  const write = channelWrite(
    deps,
    mode,
    parsed.definition.id,
    revision,
    JSON.stringify(parsed.definition),
  );
  if (write === undefined) {
    return formPage(request, { ...form, errors: [{ name: "id", text: ID_CHANGED_TEXT }] });
  }
  const guard = writeGuardProblem(writeDeps(deps), request, ROLE, NOTIFICATIONS_PATH);
  if (guard !== undefined) return guard;
  const answer = await sendRuntimeWrite(writeDeps(deps), write, request.user);
  return formAnswerPage(request, answer, form);
}

async function showDelete(deps: CheckRouteDeps, request: PageRequest): Promise<PageResult> {
  const id = request.query.get("id") ?? "";
  const read = await readNotifyChannels(apiUrlOf(deps), readDeps(deps));
  if (read.kind !== "ok") return problemPage(read, NOTIFICATIONS_PATH, "Delete channel");
  const found = findChannel(read.view, id);
  if (found === undefined) return notFoundPage();
  return {
    kind: "page",
    status: 200,
    title: "Delete channel",
    body: deleteFormHtml({
      csrf: request.csrf,
      formToken: request.issueFormToken(DELETE_CHANNEL_PATH),
      revision: read.view.revision,
      id,
      isShadowed: found.isShadowed,
    }),
  };
}

function deleteAnswerPage(answer: WriteAnswer): PageResult {
  switch (answer.kind) {
    case "saved":
      return savedPage(answer, `${NOTIFICATIONS_PATH}?deleted=1`);
    case "form":
      return {
        kind: "page",
        status: answer.status,
        title: "Not deleted",
        body: alertCallout(answer.message),
      };
    case "text": {
      if (answer.reason === "token-rejected") {
        return {
          kind: "page",
          status: answer.status,
          title: "Not deleted",
          body: "",
          banner: tokenRejectedBanner(),
        };
      }
      const body =
        answer.reason === "stale"
          ? staleState({ status: 412, reloadHref: NOTIFICATIONS_PATH })
          : alertCallout(answer.message);
      return { kind: "page", status: answer.status, title: "Not deleted", body };
    }
    default: {
      const never: never = answer;
      return never;
    }
  }
}

async function postDelete(deps: CheckRouteDeps, request: PageRequest): Promise<PageResult> {
  const id = request.fields.id ?? "";
  const revision = request.fields.revision ?? "";
  const segment = CHANNEL_ID.test(id) ? apiIdSegment(id) : undefined;
  if (segment === undefined || !isAdminRevision(revision)) {
    return {
      kind: "page",
      status: 400,
      title: "Not deleted",
      body: alertCallout(REVISION_INVALID_TEXT),
    };
  }
  const guard = writeGuardProblem(writeDeps(deps), request, ROLE, NOTIFICATIONS_PATH);
  if (guard !== undefined) return guard;
  const answer = await sendRuntimeWrite(
    writeDeps(deps),
    {
      action: "notify-channel.delete",
      target: { kind: "notify-channel", id },
      method: "DELETE",
      url: `${apiUrlOf(deps)}/admin/notify/channels/${segment}`,
      revision,
    },
    request.user,
  );
  return deleteAnswerPage(answer);
}

async function showFailed(deps: CheckRouteDeps, request: PageRequest): Promise<PageResult> {
  const read = await readNotifyFailed(apiUrlOf(deps), readDeps(deps));
  if (read.kind !== "ok") return problemPage(read, FAILED_PATH, "Failed deliveries");
  const body = failedListHtml(read.view, (entry) =>
    resendFormHtml({
      csrf: request.csrf,
      formToken: request.issueFormToken(RESEND_PATH),
      channelId: entry.channelId,
      key: entry.key,
      requestId: newRequestId(),
      label: "Resend",
    }),
  );
  return { kind: "page", status: 200, title: "Failed deliveries", body };
}

async function showResend(deps: CheckRouteDeps, request: PageRequest): Promise<PageResult> {
  const id = request.query.get("id") ?? "";
  if (!COMMAND_ID.test(id)) return notFoundPage();
  const read = await readResendCommand(apiUrlOf(deps), id, readDeps(deps));
  if (read.kind === "not-found") {
    return {
      kind: "page",
      status: 404,
      title: "Resend",
      body: `${alertCallout("This resend command no longer exists.")}<p><a href="${FAILED_PATH}">Failed deliveries</a></p>\n`,
    };
  }
  if (read.kind !== "ok") return problemPage(read, FAILED_PATH, "Resend");
  return { kind: "page", status: 200, title: "Resend", body: resendStateHtml(read.command) };
}

/** Decision 14: a repeat after a lost answer posts the same `requestId` with a fresh form token. */
async function postResend(deps: CheckRouteDeps, request: PageRequest): Promise<PageResult> {
  const valid = validateResendRequest({
    channelId: request.fields.channel_id ?? "",
    key: request.fields.key ?? "",
    requestId: request.fields.request_id ?? "",
  });
  if (!valid.ok) {
    return {
      kind: "page",
      status: 400,
      title: "Not resent",
      body: alertCallout(RESEND_INVALID_TEXT),
    };
  }
  const guard = writeGuardProblem(writeDeps(deps), request, ROLE, FAILED_PATH);
  if (guard !== undefined) return guard;
  const answer = await sendResend(writeDeps(deps), apiUrlOf(deps), valid.value, request.user);
  switch (answer.kind) {
    case "created":
      return savedPage(answer, `${RESEND_PATH}?id=${encodeURIComponent(answer.commandId)}`);
    case "unknown":
      return {
        kind: "page",
        status: answer.status,
        title: "Resend",
        body: `${alertCallout(answer.message)}${paragraph("Send it again: the same request is repeated and pulse-api answers with the same resend.")}${resendFormHtml(
          {
            csrf: request.csrf,
            formToken: request.issueFormToken(RESEND_PATH),
            ...valid.value,
            label: "Send again",
          },
        )}\n`,
      };
    case "busy":
      return { kind: "page", status: 503, title: "Not resent", body: alertCallout(answer.message) };
    case "refused":
      return refusedResendPage(answer.answer);
    default: {
      const never: never = answer;
      return never;
    }
  }
}

function refusedResendPage(answer: WriteAnswer): PageResult {
  if (answer.kind === "text" && answer.reason === "token-rejected") {
    return {
      kind: "page",
      status: answer.status,
      title: "Not resent",
      body: "",
      banner: tokenRejectedBanner(),
    };
  }
  const status = answer.kind === "saved" ? 502 : answer.status;
  const message = answer.kind === "saved" ? "" : answer.message;
  return {
    kind: "page",
    status,
    title: "Not resent",
    body: `${alertCallout(message)}<p><a href="${FAILED_PATH}">Failed deliveries</a></p>\n`,
  };
}

function route(
  path: string,
  methods: ProtectedRoute["methods"],
  handle: ProtectedRoute["handle"],
  extra: Partial<ProtectedRoute> = {},
): ProtectedRoute {
  return { path, methods, requiredRole: ROLE, navId: "notifications", handle, ...extra };
}

/** R3: the Owner-only notification screens. */
export function notificationRoutes(deps: CheckRouteDeps): ProtectedRoute[] {
  const channelForm = { knownFields: CHANNEL_FORM_FIELDS, maxFormBytes: MAX_CHANNEL_FORM_BYTES };
  return [
    route(NOTIFICATIONS_PATH, ["GET"], (r) => showList(deps, r)),
    route(
      NEW_CHANNEL_PATH,
      ["GET", "POST"],
      (r) => (r.method === "POST" ? postChannel(deps, r, "new") : showNew(deps, r)),
      channelForm,
    ),
    route(
      EDIT_CHANNEL_PATH,
      ["GET", "POST"],
      (r) => (r.method === "POST" ? postChannel(deps, r, "edit") : showEdit(deps, r)),
      channelForm,
    ),
    route(
      DELETE_CHANNEL_PATH,
      ["GET", "POST"],
      (r) => (r.method === "POST" ? postDelete(deps, r) : showDelete(deps, r)),
      { knownFields: ["id", "revision"] },
    ),
    route(FAILED_PATH, ["GET"], (r) => showFailed(deps, r)),
    route(
      RESEND_PATH,
      ["GET", "POST"],
      (r) => (r.method === "POST" ? postResend(deps, r) : showResend(deps, r)),
      { knownFields: ["channel_id", "key", "request_id"] },
    ),
  ];
}
