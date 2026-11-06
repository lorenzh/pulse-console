import {
  type AdminStatusSettingsView,
  STATUS_COLOR_KEYS,
  STATUS_FONT_KEYS,
  STATUS_RADIUS_KEYS,
  type StatusLockedField,
} from "@lorenzh/pulse-contract";
import { escapeHtml } from "@lorenzh/pulse-kit";
import { NO_TOKEN_TEXT } from "./connection-test.ts";
import { csrfField, formErrorSummary, formTokenField, paragraph, submitButton } from "./html.ts";
import { RUNTIME_OLD_API_TEXT, type RuntimeReadProblem } from "./runtime-read.ts";
import { apiUnavailableState, callout, tokenRejectedBanner } from "./states.ts";

export const STATUS_PAGE_PATH = "/status-page";
export const NOT_REPORTED_TEXT = "pulse-status has not reported; overrides are unknown";
export const NOT_APPLIED_TEXT = "Saved, not yet applied";
export const ORDER_INVALID_TEXT = "The component order is invalid.";
export const STATUS_SAVED_TEXT = "Status page settings saved.";
export const EMPTY_ORDER_TEXT =
  "No order is set: components follow the pulse-api order. Reset order lists them here.";

/** The four switches: form name, settings key, and the default text of "Not set". */
export const STATUS_FLAGS = [
  { name: "show_checks", key: "showChecks", label: "Show checks", fallback: "Off" },
  { name: "show_latency", key: "showLatency", label: "Show latency", fallback: "On" },
  { name: "show_slos", key: "showSlos", label: "Show SLOs", fallback: "On" },
  { name: "hide_details", key: "hideDetails", label: "Hide details", fallback: "On" },
] as const;

export type StatusTextField = { name: string; path: string; label: string };

/** Every text field of the form with its dotted settings path, in form order. */
export const STATUS_TEXT_FIELDS: readonly StatusTextField[] = [
  { name: "name", path: "name", label: "Name" },
  { name: "logo_url", path: "logoUrl", label: "Logo URL" },
  ...STATUS_COLOR_KEYS.map((key) => ({
    name: `light-${key}`,
    path: `theme.light.${key}`,
    label: key,
  })),
  ...STATUS_COLOR_KEYS.map((key) => ({
    name: `dark-${key}`,
    path: `theme.dark.${key}`,
    label: key,
  })),
  ...[...STATUS_FONT_KEYS, ...STATUS_RADIUS_KEYS].map((key) => ({
    name: key,
    path: `theme.${key}`,
    label: key,
  })),
];

/** The form as shown: text values by form name, flag values ("", "on", "off") and the order. */
export type StatusFormInput = {
  values: Readonly<Record<string, string>>;
  order: readonly string[];
};

export type StatusFormModel = {
  csrf: string;
  formToken: string;
  view: AdminStatusSettingsView;
  input: StatusFormInput;
  errors: ReadonlyArray<{ name: string; text: string }>;
};

/** The lock of `path` in a fresh report: an exact match or a locked parent such as `theme`. */
export function lockOf(view: AdminStatusSettingsView, path: string): StatusLockedField | undefined {
  if (view.service.state !== "fresh") return undefined;
  return view.service.report?.locked.find(
    (lock) => lock.field === path || path.startsWith(`${lock.field}.`),
  );
}

function lockedHtml(label: string, id: string, lock: StatusLockedField): string {
  const text = typeof lock.value === "string" ? lock.value : JSON.stringify(lock.value);
  const value = lock.value === undefined ? "" : ` <span class="mono">${escapeHtml(text)}</span>`;
  return `<p class="locked" id="${id}"><span>${escapeHtml(label)}:</span>${value} <small class="hint">Set by <code>${escapeHtml(lock.via)}</code> on pulse-status</small></p>\n`;
}

function errorText(model: StatusFormModel, name: string): string | undefined {
  return model.errors.find((e) => e.name === name)?.text;
}

function textInput(model: StatusFormModel, f: StatusTextField): string {
  const id = `field-${f.name}`;
  const lock = lockOf(model.view, f.path);
  if (lock !== undefined) return lockedHtml(f.label, id, lock);
  const error = errorText(model, f.name);
  const described =
    error === undefined ? "" : ` aria-describedby="${id}-error" aria-invalid="true"`;
  const errorHtml =
    error === undefined ? "" : `\n<span class="error" id="${id}-error">${escapeHtml(error)}</span>`;
  return `<label for="${id}">${escapeHtml(f.label)}
<input id="${id}" name="${escapeHtml(f.name)}" type="text" autocomplete="off" value="${escapeHtml(model.input.values[f.name] ?? "")}"${described}>${errorHtml}
</label>\n`;
}

function flagInput(model: StatusFormModel, flag: (typeof STATUS_FLAGS)[number]): string {
  const id = `field-${flag.name}`;
  const lock = lockOf(model.view, flag.key);
  if (lock !== undefined) return lockedHtml(flag.label, id, lock);
  const current = model.input.values[flag.name] ?? "";
  const options = [
    ["", `Not set (default: ${flag.fallback})`],
    ["on", "On"],
    ["off", "Off"],
  ]
    .map(
      ([value, text]) =>
        `<option value="${value}"${value === current ? " selected" : ""}>${escapeHtml(text ?? "")}</option>`,
    )
    .join("");
  return `<label for="${id}">${escapeHtml(flag.label)}
<select id="${id}" name="${flag.name}">${options}</select>
</label>\n`;
}

function fieldsFor(model: StatusFormModel, prefix: string): string {
  return STATUS_TEXT_FIELDS.filter((f) => f.path.startsWith(prefix))
    .map((f) => textInput(model, f))
    .join("");
}

function orderItem(id: string, i: number, count: number): string {
  const up =
    i === 0
      ? ""
      : submitButton({
          label: "Move up",
          busyLabel: "Moving…",
          name: "action",
          value: `up:${i}`,
          variant: "secondary",
          size: "small",
        });
  const down =
    i === count - 1
      ? ""
      : submitButton({
          label: "Move down",
          busyLabel: "Moving…",
          name: "action",
          value: `down:${i}`,
          variant: "secondary",
          size: "small",
        });
  return `<li><span class="mono">${escapeHtml(id)}</span> ${up}${down}</li>`;
}

function orderHtml(model: StatusFormModel): string {
  const lock = lockOf(model.view, "componentOrder");
  if (lock !== undefined) {
    return `<fieldset id="field-order"><legend>Component order</legend>\n${lockedHtml("Component order", "field-order-lock", { ...lock, value: undefined })}</fieldset>\n`;
  }
  const { order } = model.input;
  const items =
    order.length === 0
      ? paragraph(EMPTY_ORDER_TEXT, ' class="hint"')
      : `<ol class="component-order">\n${order.map((id, i) => orderItem(id, i, order.length)).join("\n")}\n</ol>\n`;
  const error = errorText(model, "order");
  const errorHtml =
    error === undefined
      ? ""
      : `<span class="error" id="field-order-error">${escapeHtml(error)}</span>\n`;
  const reset = submitButton({
    label: "Reset order",
    busyLabel: "Resetting…",
    name: "action",
    value: "reset-order",
    variant: "secondary",
  });
  return `<fieldset id="field-order"><legend>Component order</legend>
<input type="hidden" name="order" value="${escapeHtml(order.join(","))}">
${errorHtml}${items}<div class="actions">${reset}</div>
</fieldset>\n`;
}

function bannersOf(view: AdminStatusSettingsView): string {
  const { service } = view;
  if (service.state !== "fresh" || service.report === null) {
    return callout({ kind: "warning", body: paragraph(NOT_REPORTED_TEXT), role: "status" });
  }
  const rejected =
    service.report.rejected === null
      ? ""
      : callout({
          kind: "error",
          title: "pulse-status rejected the settings",
          body: paragraph(service.report.rejected.reason),
          role: "alert",
        });
  const pending =
    service.report.appliedRevision === view.revision
      ? ""
      : callout({ kind: "info", body: paragraph(NOT_APPLIED_TEXT), role: "status" });
  return rejected + pending;
}

function saveButton(): string {
  return submitButton({ label: "Save", busyLabel: "Saving…", name: "action", value: "save" });
}

/**
 * R3: the status page form. The first submit button is Save, so Enter in a text field saves.
 * The order is one hidden comma-joined field; a move button names its action, nothing else.
 */
export function statusFormHtml(model: StatusFormModel): string {
  const flags = STATUS_FLAGS.map((flag) => flagInput(model, flag)).join("");
  return `${bannersOf(model.view)}${formErrorSummary(model.errors)}<form method="post" action="${STATUS_PAGE_PATH}" class="status-settings" novalidate>
${csrfField(model.csrf)}
${formTokenField(model.formToken)}
<input type="hidden" name="revision" value="${escapeHtml(model.view.revision)}">
${paragraph("Leave a field empty to use the default of pulse-status.", ' class="hint"')}${fieldsFor(model, "name")}${fieldsFor(model, "logoUrl")}<div class="actions">${saveButton()}</div>
<fieldset><legend>Light colours</legend>
${fieldsFor(model, "theme.light.")}</fieldset>
<fieldset><legend>Dark colours</legend>
${fieldsFor(model, "theme.dark.")}</fieldset>
<fieldset><legend>Fonts and radii</legend>
${fieldsFor(model, "theme.font-")}${fieldsFor(model, "theme.radius-")}</fieldset>
<fieldset><legend>Switches</legend>
${flags}</fieldset>
${orderHtml(model)}<div class="actions">${saveButton()}</div>
</form>
`;
}

/** The page body of a read that cannot be used. */
export function statusProblemView(problem: RuntimeReadProblem): { banner: string; body: string } {
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
      return { banner: "", body: apiUnavailableState(problem.failure, STATUS_PAGE_PATH) };
    default: {
      const never: never = problem;
      return never;
    }
  }
}
