import {
  type AdminNotifyChannelsView,
  type AdminNotifyFailedView,
  NOTIFY_SECRET_ENV_PREFIX,
  type NotifyDatabaseChannelView,
  type NotifyFailedDelivery,
  type NotifyFileChannelView,
  type ResendCommand,
} from "@lorenzh/pulse-contract";
import { escapeHtml } from "@lorenzh/pulse-kit";
import { NO_TOKEN_TEXT } from "./connection-test.ts";
import { csrfField, formErrorSummary, formTokenField, paragraph, submitButton } from "./html.ts";
import {
  ALERT_FIELDS,
  CHANNEL_TYPES,
  type ChannelFormError,
  type ChannelFormField,
  type ChannelFormInput,
  LIST_FIELDS,
} from "./notification-form.ts";
import { RUNTIME_OLD_API_TEXT, type RuntimeReadProblem } from "./runtime-read.ts";
import { apiUnavailableState, callout, emptyState, tokenRejectedBanner } from "./states.ts";

export const NOTIFICATIONS_PATH = "/notifications";
export const NEW_CHANNEL_PATH = "/notifications/new";
export const EDIT_CHANNEL_PATH = "/notifications/edit";
export const DELETE_CHANNEL_PATH = "/notifications/delete";
export const FAILED_PATH = "/notifications/failed";
export const RESEND_PATH = "/notifications/resend";

export const FILE_CHANNEL_TEXT = "From the notify channel file";
export const SHADOWED_TEXT = "Shadowed by the channel file";
export const REJECTED_PREFIX = "Rejected by pulse-notify: ";
export const NOT_APPLIED_TEXT = "Saved, not yet applied";
export const NOTIFY_NOT_REPORTED_TEXT =
  "pulse-notify has not reported; file channels and the applied state are unknown";
export const CHANNEL_SAVED_TEXT = "Notification channel saved.";
export const CHANNEL_DELETED_TEXT = "Notification channel deleted.";
export const ZERO_CHANNELS_TITLE = "No notification channels yet";
export const ZERO_CHANNELS_TEXT =
  "Add a channel to send alerts to a webhook, Slack, Teams or email. Secrets stay on pulse-notify: a channel names them by reference only.";
export const NO_FAILED_TEXT = "No failed deliveries.";
export const SECRET_DIR_HINT = "a file in PULSE_NOTIFY_SECRET_DIR on pulse-notify";

/** A notify read problem as a banner and a body; `retryHref` is the page to load again. */
export function notifyProblemView(
  problem: RuntimeReadProblem,
  retryHref: string,
): { banner: string; body: string } {
  switch (problem.kind) {
    case "no-token":
      return {
        banner: "",
        body: callout({
          kind: "error",
          title: "pulse-api is not available",
          body: paragraph(NO_TOKEN_TEXT),
          role: "alert",
        }),
      };
    case "token-rejected":
      return { banner: tokenRejectedBanner(), body: "" };
    case "old-api":
      return {
        banner: "",
        body: callout({
          kind: "error",
          title: "pulse-api is too old",
          body: paragraph(RUNTIME_OLD_API_TEXT),
          role: "alert",
        }),
      };
    case "failed":
      return { banner: "", body: apiUnavailableState(problem.failure, retryHref) };
    default: {
      const never: never = problem;
      return never;
    }
  }
}

function link(href: string, label: string, extra = ""): string {
  return `<a href="${escapeHtml(href)}"${extra}>${escapeHtml(label)}</a>`;
}

function idQuery(path: string, id: string): string {
  return `${path}?id=${encodeURIComponent(id)}`;
}

/** The banners of the list: not reported, rejections without a channel, not yet applied. */
function serviceBanners(view: AdminNotifyChannelsView): string {
  const { service } = view;
  if (service.state !== "fresh" || service.report === null) {
    return callout({ kind: "warning", body: paragraph(NOTIFY_NOT_REPORTED_TEXT), role: "status" });
  }
  const report = service.report;
  const general = report.rejected
    .filter((r) => r.channelId === null)
    .map((r) =>
      callout({ kind: "error", body: paragraph(REJECTED_PREFIX + r.reason), role: "alert" }),
    )
    .join("");
  const notApplied =
    report.appliedRevision === view.revision
      ? ""
      : callout({ kind: "info", body: paragraph(NOT_APPLIED_TEXT), role: "status" });
  return general + notApplied;
}

/** The reason of a fresh report's rejection of `id`, if any (Decision 6, per channel). */
function rejectionOf(view: AdminNotifyChannelsView, id: string): string | undefined {
  if (view.service.state !== "fresh") return undefined;
  return view.service.report?.rejected.find((r) => r.channelId === id)?.reason;
}

function databaseRow(
  view: AdminNotifyChannelsView,
  channel: NotifyDatabaseChannelView,
  isShadowed: boolean,
): string {
  const rejected = rejectionOf(view, channel.id);
  const notes = [
    isShadowed ? `<span class="pill">${escapeHtml(SHADOWED_TEXT)}</span>` : "",
    rejected === undefined
      ? ""
      : `<span class="error">${escapeHtml(REJECTED_PREFIX + rejected)}</span>`,
  ].filter((n) => n !== "");
  const actions = [
    isShadowed ? "" : link(idQuery(EDIT_CHANNEL_PATH, channel.id), "Edit"),
    link(idQuery(DELETE_CHANNEL_PATH, channel.id), "Delete"),
  ].filter((a) => a !== "");
  return `<tr><td class="mono">${escapeHtml(channel.id)}</td><td>${escapeHtml(channel.type)}</td><td>Database</td><td>${notes.join(" ")}</td><td>${actions.join(" ")}</td></tr>`;
}

function fileRow(channel: NotifyFileChannelView): string {
  const refs =
    channel.refs.length === 0
      ? ""
      : channel.refs.map((r) => `<code>${escapeHtml(r)}</code>`).join(", ");
  return `<tr><td class="mono">${escapeHtml(channel.id)}</td><td>${escapeHtml(channel.type)}</td><td>${escapeHtml(FILE_CHANNEL_TEXT)}</td><td>${refs}</td><td></td></tr>`;
}

function fileRows(view: AdminNotifyChannelsView): { rows: string[]; more: string } {
  const report = view.service.report;
  if (report === null) return { rows: [], more: "" };
  const extra = report.fileChannelsTotal - report.fileChannels.length;
  const more =
    extra > 0
      ? paragraph(`${extra} more file channels exist and are not listed.`, ' class="hint"')
      : "";
  return { rows: report.fileChannels.map(fileRow), more };
}

/** `/notifications`: database channels, shadowed copies and the reported file channels. */
export function channelListHtml(view: AdminNotifyChannelsView, notice: string): string {
  const files = fileRows(view);
  const rows = [
    ...view.channels.map((c) => databaseRow(view, c, false)),
    ...view.shadowed.map((c) => databaseRow(view, c, true)),
    ...files.rows,
  ];
  const actions = `<p>${link(NEW_CHANNEL_PATH, "New channel", ' class="button"')} ${link(FAILED_PATH, "Failed deliveries")}</p>\n`;
  if (rows.length === 0) {
    return `${notice}${serviceBanners(view)}${emptyState({
      title: ZERO_CHANNELS_TITLE,
      text: ZERO_CHANNELS_TEXT,
      action: { href: NEW_CHANNEL_PATH, label: "New channel" },
    })}<p>${link(FAILED_PATH, "Failed deliveries")}</p>\n`;
  }
  return `${notice}${serviceBanners(view)}${actions}<table>
<thead><tr><th scope="col">Id</th><th scope="col">Type</th><th scope="col">Source</th><th scope="col">Notes</th><th scope="col">Actions</th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>
${files.more}`;
}

function errorOf(errors: readonly ChannelFormError[], name: string): string | undefined {
  return errors.find((e) => e.name === name)?.text;
}

function described(name: string, error: string | undefined, hint: string | undefined): string {
  const ids = [
    hint === undefined ? "" : `field-${name}-hint`,
    error === undefined ? "" : `field-${name}-error`,
  ].filter((id) => id !== "");
  const invalid = error === undefined ? "" : ' aria-invalid="true"';
  return ids.length === 0 ? invalid : ` aria-describedby="${ids.join(" ")}"${invalid}`;
}

type FieldView = {
  name: ChannelFormField;
  label: string;
  input: ChannelFormInput;
  errors: readonly ChannelFormError[];
  hint?: string | undefined;
  prefix?: string | undefined;
  isReadOnly?: boolean | undefined;
};

function hintAndError(name: string, hint: string | undefined, error: string | undefined): string {
  const h =
    hint === undefined
      ? ""
      : `\n<small class="hint" id="field-${name}-hint">${escapeHtml(hint)}</small>`;
  const e =
    error === undefined
      ? ""
      : `\n<span class="error" id="field-${name}-error">${escapeHtml(error)}</span>`;
  return h + e;
}

function textInput(f: FieldView): string {
  const error = errorOf(f.errors, f.name);
  const prefix = f.prefix === undefined ? "" : `<span class="mono">${escapeHtml(f.prefix)}</span>`;
  const readOnly = f.isReadOnly === true ? " readonly" : "";
  return `<label for="field-${f.name}">${escapeHtml(f.label)}
${prefix}<input id="field-${f.name}" name="${f.name}" type="text" autocomplete="off"${readOnly} value="${escapeHtml(f.input[f.name] ?? "")}"${described(f.name, error, f.hint)}>${hintAndError(f.name, f.hint, error)}
</label>\n`;
}

function textareaInput(f: FieldView): string {
  const error = errorOf(f.errors, f.name);
  return `<label for="field-${f.name}">${escapeHtml(f.label)}
<textarea id="field-${f.name}" name="${f.name}" rows="3"${described(f.name, error, f.hint)}>${escapeHtml(f.input[f.name] ?? "")}</textarea>${hintAndError(f.name, f.hint, error)}
</label>\n`;
}

function selectInput(
  f: FieldView,
  options: ReadonlyArray<{ value: string; label: string }>,
): string {
  const error = errorOf(f.errors, f.name);
  const current = f.input[f.name] ?? "";
  const items = options
    .map(
      (o) =>
        `<option value="${escapeHtml(o.value)}"${o.value === current ? " selected" : ""}>${escapeHtml(o.label)}</option>`,
    )
    .join("");
  return `<label for="field-${f.name}">${escapeHtml(f.label)}
<select id="field-${f.name}" name="${f.name}"${described(f.name, error, f.hint)}>${items}</select>${hintAndError(f.name, f.hint, error)}
</label>\n`;
}

function switchInput(f: FieldView, fallback: string): string {
  return selectInput(f, [
    { value: "", label: `Not set (default: ${fallback})` },
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ]);
}

function checkbox(name: string, label: string, isChecked: boolean): string {
  return `<label class="checkbox"><input type="checkbox" name="${name}" value="on"${isChecked ? " checked" : ""}> ${escapeHtml(label)}</label>\n`;
}

const ENV_HINT = `The name of an environment variable on pulse-notify; the prefix ${NOTIFY_SECRET_ENV_PREFIX} is added.`;
const FILE_HINT = `The name of ${SECRET_DIR_HINT}.`;

function refFields(
  base: Omit<FieldView, "name" | "label">,
  env: ChannelFormField,
  file: ChannelFormField,
  what: string,
): string {
  return (
    textInput({
      ...base,
      name: env,
      label: `${what}: environment variable`,
      prefix: NOTIFY_SECRET_ENV_PREFIX,
      hint: ENV_HINT,
    }) + textInput({ ...base, name: file, label: `${what}: secret file`, hint: FILE_HINT })
  );
}

function fieldset(legend: string, body: string): string {
  return `<fieldset>\n<legend>${escapeHtml(legend)}</legend>\n${body}</fieldset>\n`;
}

function routingFields(base: Omit<FieldView, "name" | "label">): string {
  const lists = LIST_FIELDS.map((f) =>
    textareaInput({ ...base, name: f.name, label: f.label, hint: "One per line." }),
  ).join("");
  const alerts = ALERT_FIELDS.map((f) =>
    checkbox(f.name, f.label, (base.input[f.name] ?? "") !== ""),
  ).join("");
  return fieldset(
    "Routing",
    lists +
      textInput({
        ...base,
        name: "remind_every_seconds",
        label: "Remind every (seconds)",
        hint: "At least 60.",
      }) +
      `<p>Alerts</p>\n${alerts}` +
      switchInput(
        { ...base, name: "send_incidents", label: "Send incidents" },
        "pulse-notify default",
      ),
  );
}

function messageFields(base: Omit<FieldView, "name" | "label">): string {
  return (
    textInput({ ...base, name: "status_url", label: "Status page URL" }) +
    switchInput({ ...base, name: "hide_reason", label: "Hide reason" }, "Off")
  );
}

function emailFields(base: Omit<FieldView, "name" | "label">): string {
  return fieldset(
    "Email",
    textInput({ ...base, name: "smtp_host", label: "SMTP host" }) +
      textInput({ ...base, name: "smtp_port", label: "SMTP port" }) +
      selectInput({ ...base, name: "smtp_tls", label: "SMTP TLS" }, [
        { value: "", label: "Not set" },
        { value: "starttls", label: "STARTTLS" },
        { value: "tls", label: "TLS" },
        { value: "none", label: "None" },
      ]) +
      textInput({ ...base, name: "smtp_username", label: "SMTP username" }) +
      refFields(base, "smtp_password_env", "smtp_password_file", "SMTP password") +
      textInput({ ...base, name: "smtp_client_name", label: "SMTP client name" }) +
      textInput({ ...base, name: "from", label: "From" }) +
      textareaInput({ ...base, name: "to", label: "To", hint: "One address per line." }) +
      textInput({ ...base, name: "subject_prefix", label: "Subject prefix" }) +
      messageFields(base),
  );
}

export type ChannelFormModel = {
  mode: "new" | "edit";
  csrf: string;
  formToken: string;
  revision: string;
  input: ChannelFormInput;
  errors: readonly ChannelFormError[];
};

/** The channel editor: every field of every type, grouped by the types that use it. */
export function channelFormHtml(model: ChannelFormModel): string {
  const base = { input: model.input, errors: model.errors };
  const action = model.mode === "new" ? NEW_CHANNEL_PATH : EDIT_CHANNEL_PATH;
  const types = CHANNEL_TYPES.map((t) => ({ value: t, label: t }));
  return `${formErrorSummary(model.errors)}<form method="post" action="${action}" novalidate>
${csrfField(model.csrf)}
${formTokenField(model.formToken)}
<input type="hidden" name="revision" value="${escapeHtml(model.revision)}">
${submitButton({ label: "Save", busyLabel: "Saving…" })}
${textInput({ ...base, name: "id", label: "Id", isReadOnly: model.mode === "edit", hint: "Lower-case letters, digits, - and _; at most 64 characters." })}${selectInput({ ...base, name: "type", label: "Type", hint: "Only the fields of this type are saved." }, types)}${routingFields(base)}${fieldset(
  "Webhook, Slack and Teams",
  `${refFields(base, "url_env", "url_file", "URL")}${paragraph("Give exactly one of the two.", ' class="hint"')}`,
)}${fieldset("Webhook", refFields(base, "secret_env", "secret_file", "Signing secret"))}${fieldset("Slack and Teams", messageFields(base))}${emailFields(base)}${submitButton({ label: "Save", busyLabel: "Saving…" })}
</form>
<p>${link(NOTIFICATIONS_PATH, "Back to notifications")}</p>
`;
}

/** The delete confirmation of one database channel. */
export function deleteFormHtml(model: {
  csrf: string;
  formToken: string;
  revision: string;
  id: string;
  isShadowed: boolean;
}): string {
  const note = model.isShadowed
    ? paragraph(`This is a database copy that the channel file shadows. ${SHADOWED_TEXT}.`)
    : "";
  const question = paragraph(
    `Delete the notification channel ${model.id}? pulse-notify stops using it after its next apply.`,
  );
  return `${note}${question}<form method="post" action="${DELETE_CHANNEL_PATH}">
${csrfField(model.csrf)}
${formTokenField(model.formToken)}
<input type="hidden" name="revision" value="${escapeHtml(model.revision)}">
<input type="hidden" name="id" value="${escapeHtml(model.id)}">
${submitButton({ label: "Delete channel", busyLabel: "Deleting…", variant: "danger" })}
</form>
<p>${link(NOTIFICATIONS_PATH, "Cancel")}</p>
`;
}

/** The hidden fields and button of one resend; the same `requestId` repeats the same request. */
export function resendFormHtml(model: {
  csrf: string;
  formToken: string;
  channelId: string;
  key: string;
  requestId: string;
  label: string;
}): string {
  return `<form method="post" action="${RESEND_PATH}">
${csrfField(model.csrf)}
${formTokenField(model.formToken)}
<input type="hidden" name="channel_id" value="${escapeHtml(model.channelId)}">
<input type="hidden" name="key" value="${escapeHtml(model.key)}">
<input type="hidden" name="request_id" value="${escapeHtml(model.requestId)}">
${submitButton({ label: model.label, busyLabel: "Sending…", variant: "secondary", size: "small" })}
</form>`;
}

/** The event text of a failed row: the event value, then "manual" only when `isManual`. */
export function failedEventText(entry: NotifyFailedDelivery): string {
  return entry.isManual ? `${entry.event} manual` : entry.event;
}

function failedRow(
  entry: NotifyFailedDelivery,
  resend: (e: NotifyFailedDelivery) => string,
): string {
  const at = new Date(entry.failedAt).toISOString();
  return `<tr><td class="mono">${escapeHtml(entry.channelId)}</td><td class="mono">${escapeHtml(entry.key)}</td><td>${escapeHtml(failedEventText(entry))}</td><td><time datetime="${at}">${at}</time></td><td>${entry.hasPayload ? resend(entry) : ""}</td></tr>`;
}

/** `/notifications/failed`: up to 200 rows, newest first, as the report holds them. */
export function failedListHtml(
  view: AdminNotifyFailedView,
  resend: (entry: NotifyFailedDelivery) => string,
): string {
  const banner =
    view.state === "fresh"
      ? ""
      : callout({ kind: "warning", body: paragraph(NOTIFY_NOT_REPORTED_TEXT), role: "status" });
  const back = `<p>${link(NOTIFICATIONS_PATH, "Back to notifications")}</p>\n`;
  if (view.failed.length === 0) return `${banner}${paragraph(NO_FAILED_TEXT)}${back}`;
  const extra = view.failedTotal - view.failed.length;
  const more =
    extra > 0 ? paragraph(`${extra} more failed deliveries are not listed.`, ' class="hint"') : "";
  return `${banner}<table>
<thead><tr><th scope="col">Channel</th><th scope="col">Key</th><th scope="col">Event</th><th scope="col">Failed at</th><th scope="col">Resend</th></tr></thead>
<tbody>
${view.failed.map((e) => failedRow(e, resend)).join("\n")}
</tbody>
</table>
${more}${back}`;
}

const STATE_TEXT: Readonly<Record<ResendCommand["state"], string>> = {
  queued: "Queued: pulse-notify has not picked it up yet.",
  claimed: "Claimed: pulse-notify is handling it.",
  admitted: "Admitted: pulse-notify queued the delivery again.",
  delivered: "Delivered.",
  failed: "Failed again.",
  dropped: "Dropped by pulse-notify.",
  "not-failed": "Not resent: the delivery is no longer failed.",
  "no-payload": "Not resent: pulse-notify has no stored payload for it.",
  "channel-unavailable": "Not resent: the channel is not installed on pulse-notify.",
};

/** `/notifications/resend?id=`: the command state, read on each load. */
export function resendStateHtml(command: ResendCommand): string {
  return `<dl>
<dt>Channel</dt><dd class="mono">${escapeHtml(command.channelId)}</dd>
<dt>Key</dt><dd class="mono">${escapeHtml(command.key)}</dd>
<dt>State</dt><dd><span class="mono">${escapeHtml(command.state)}</span> ${escapeHtml(STATE_TEXT[command.state])}</dd>
</dl>
<p>${link(idQuery(RESEND_PATH, command.id), "Reload")} ${link(FAILED_PATH, "Failed deliveries")}</p>
`;
}
