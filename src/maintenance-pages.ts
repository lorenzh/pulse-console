import type { AdminConfigResponse } from "@lorenzh/pulse-contract";
import { escapeHtml } from "@lorenzh/pulse-kit";
import { utcTime } from "./check-format.ts";
import {
  csrfField,
  field,
  formErrorSummary,
  formTokenField,
  paragraph,
  submitButton,
} from "./html.ts";
import { durationText } from "./incident-list.ts";
import type { MaintenanceErrors, MaintenanceInput } from "./maintenance-form.ts";
import {
  checkLabel,
  type MaintenanceRow,
  type MaintenanceSection,
  SHADOWED_TEXT,
} from "./maintenance-view.ts";
import { callout, emptyState } from "./states.ts";

export const MAINTENANCE_SAVED_TEXT = "Maintenance window saved.";
export const MAINTENANCE_DELETED_TEXT = "Maintenance window deleted.";
export const NO_WINDOWS_TEXT = "No maintenance windows.";
export const FILE_WINDOW_TEXT =
  "This window comes from the checks file or is shadowed by it; it cannot be edited here.";
export const WINDOW_GONE_TEXT = "This maintenance window no longer exists.";

function timeHtml(epoch: number): string {
  return `<time datetime="${new Date(epoch).toISOString()}">${escapeHtml(utcTime(epoch))}</time>`;
}

function actionLinks(row: MaintenanceRow): string {
  if (row.id === undefined || row.actions.length === 0) return "";
  const id = encodeURIComponent(row.id);
  const links = row.actions.map((action) => {
    switch (action) {
      case "edit":
        return `<a class="button secondary small" href="/maintenance/edit?id=${id}">Edit</a>`;
      case "delete":
        return `<a class="button danger small" href="/maintenance/delete?id=${id}">Delete</a>`;
      case "delete-copy":
        return `<a class="button danger small" href="/maintenance/delete?id=${id}">Delete database copy</a>`;
      default: {
        const never: never = action;
        return never;
      }
    }
  });
  return `<p class="row-actions">${links.join(" ")}</p>`;
}

function rowHtml(row: MaintenanceRow): string {
  const shadowed = row.isShadowed ? paragraph(SHADOWED_TEXT) : "";
  return `<li class="maintenance-row">
<h3 class="mono">${escapeHtml(row.identity)}</h3>
<p class="muted">${escapeHtml(row.source)}</p>
<dl class="settings">
<dt>Checks</dt><dd>${escapeHtml(row.checks.join(", "))}</dd>
<dt>Start</dt><dd>${timeHtml(row.start)}</dd>
<dt>End</dt><dd>${timeHtml(row.end)}</dd>
<dt>Duration</dt><dd>${escapeHtml(durationText(row.end - row.start))}</dd>
<dt>Note</dt><dd class="incident-message">${escapeHtml(row.note)}</dd>
</dl>
${shadowed}${actionLinks(row)}
</li>`;
}

function sectionHtml(section: MaintenanceSection): string {
  const id = `maintenance-${section.key}`;
  const rows =
    section.rows.length === 0
      ? paragraph("None.")
      : `<ul class="maintenance-rows">\n${section.rows.map(rowHtml).join("\n")}\n</ul>`;
  const limit = section.limitText === undefined ? "" : paragraph(section.limitText);
  return `<section class="panel" aria-labelledby="${id}">
<div class="panel-head"><h2 class="eyebrow" id="${id}">${escapeHtml(section.title)} (${section.total})</h2></div>
<div class="panel-body">${rows}${limit}</div>
</section>`;
}

/** The Maintenance list body (section 12). */
export function maintenanceListBody(view: {
  sections: readonly MaintenanceSection[];
  now: number;
  canCreate: boolean;
  notice: string | undefined;
}): string {
  const notice =
    view.notice === undefined
      ? ""
      : callout({ kind: "success", body: paragraph(view.notice), role: "status" });
  const plan = view.canCreate
    ? `<a class="button" href="/maintenance/new">Plan maintenance</a> `
    : "";
  const head = `<p class="toolbar">${plan}As of ${timeHtml(view.now)} <a href="/maintenance">Reload</a></p>\n`;
  const isEmpty = view.sections.every((s) => s.total === 0);
  if (isEmpty) {
    return `${notice}${head}${emptyState({ title: NO_WINDOWS_TEXT, text: "" })}`;
  }
  return `${notice}${head}${view.sections.map(sectionHtml).join("\n")}\n`;
}

const FIELD_ORDER = ["id", "check", "component", "start", "end", "note"] as const;

function summaryOf(errors: MaintenanceErrors): string {
  return formErrorSummary(
    FIELD_ORDER.flatMap((name) => {
      const text = errors[name];
      return text === undefined ? [] : [{ name, text }];
    }),
  );
}

function errorSpan(name: string, error: string | undefined): string {
  return error === undefined
    ? ""
    : `<span class="error" id="field-${name}-error">${escapeHtml(error)}</span>`;
}

function checkChoices(config: AdminConfigResponse, selected: readonly string[], error?: string) {
  const known = new Set(config.checks.map((c) => c.id));
  const choices = [
    ...config.checks.map((c) => ({ id: c.id, label: `${c.name} (${c.id})` })),
    ...selected
      .filter((id) => !known.has(id))
      .map((id) => ({ id, label: `${id} (not configured)` })),
  ];
  const boxes = choices
    .map((c, index) => {
      const id = index === 0 ? ` id="field-check"` : "";
      const isChecked = selected.includes(c.id) ? " checked" : "";
      return `<label class="choice"><input type="checkbox"${id} name="check" value="${escapeHtml(c.id)}"${isChecked}> ${escapeHtml(c.label)}</label>`;
    })
    .join("\n");
  const body = choices.length === 0 ? paragraph("No checks are configured.") : boxes;
  return `<fieldset class="choices"><legend>Checks</legend>\n${body}${errorSpan("check", error)}</fieldset>`;
}

function componentChoices(
  config: AdminConfigResponse,
  selected: readonly string[],
  error?: string,
): string {
  const names = new Map(config.checks.map((c) => [c.id, c.name]));
  const known = new Set(config.components.map((c) => c.id));
  const shown = [
    ...config.components,
    ...selected.filter((id) => !known.has(id)).map((id) => ({ id, name: id, checkIds: [] })),
  ];
  if (shown.length === 0)
    return `${paragraph("No components are configured.")}${errorSpan("component", error)}`;
  const boxes = shown
    .map((c, index) => {
      const id = index === 0 ? ` id="field-component"` : "";
      const isChecked = selected.includes(c.id) ? " checked" : "";
      const members = c.checkIds.map((check) => checkLabel(check, names)).join(", ");
      return `<label class="choice"><input type="checkbox"${id} name="component" value="${escapeHtml(c.id)}"${isChecked}> ${escapeHtml(c.name)} <span class="muted">(${escapeHtml(members)})</span></label>`;
    })
    .join("\n");
  return `<fieldset class="choices"><legend>Add the checks of components</legend>\n${boxes}${errorSpan("component", error)}</fieldset>`;
}

function timeField(name: "start" | "end", label: string, value: string, error?: string): string {
  const described =
    error === undefined ? "" : ` aria-describedby="field-${name}-error" aria-invalid="true"`;
  return `<label for="field-${name}">${label} (UTC)
<input id="field-${name}" name="${name}" type="datetime-local" step="1" required value="${escapeHtml(value)}"${described}>${errorSpan(name, error)}
</label>`;
}

/** The create or edit form (section 13). `target` is set for an edit. */
export function maintenanceFormHtml(view: {
  csrf: string;
  formToken: string;
  revision: string;
  target: string | undefined;
  input: MaintenanceInput;
  errors: MaintenanceErrors;
  config: AdminConfigResponse;
  notice?: string | undefined;
}): string {
  const { input, errors, target } = view;
  const action =
    target === undefined
      ? "/maintenance/new"
      : `/maintenance/edit?id=${encodeURIComponent(target)}`;
  const idPart =
    target === undefined
      ? field({
          label: "Id",
          name: "id",
          type: "text",
          autocomplete: "off",
          value: input.id,
          error: errors.id,
        })
      : `<input type="hidden" name="target" value="${escapeHtml(target)}">\n<p>Id <span class="mono">${escapeHtml(target)}</span></p>`;
  const notice =
    view.notice === undefined
      ? ""
      : callout({ kind: "error", body: paragraph(view.notice), role: "alert" });
  const note = field({
    label: "Note",
    name: "note",
    type: "text",
    autocomplete: "off",
    value: input.note,
    error: errors.note,
  });
  return `${notice}${summaryOf(errors)}<form method="post" action="${escapeHtml(action)}" class="panel maintenance-form">
${csrfField(view.csrf)}
${formTokenField(view.formToken)}
<input type="hidden" name="revision" value="${escapeHtml(view.revision)}">
<div class="panel-body">
${idPart}
${checkChoices(view.config, input.checks, errors.check)}
${componentChoices(view.config, input.components, errors.component)}
${timeField("start", "Start", input.start, errors.start)}
${timeField("end", "End", input.end, errors.end)}
${note}
</div>
<div class="panel-foot"><a class="button ghost cancel" href="/maintenance">Cancel</a> ${submitButton({ label: "Save window", busyLabel: "Saving…" })}</div>
</form>
`;
}

/** The posted input as text, for pages that show it without a form. */
export function maintenanceKeptHtml(input: MaintenanceInput): string {
  const entries: [string, string][] = [
    ["Id", input.id],
    ["Checks", input.checks.join(", ")],
    ["Components", input.components.join(", ")],
    ["Start (UTC)", input.start],
    ["End (UTC)", input.end],
    ["Note", input.note],
  ];
  const shown = entries.filter(([, value]) => value !== "");
  if (shown.length === 0) return "";
  const items = shown.map(
    ([name, value]) =>
      `<dt>${escapeHtml(name)}</dt><dd class="incident-message">${escapeHtml(value)}</dd>`,
  );
  return `<h2>Your input</h2>\n<dl class="settings">\n${items.join("\n")}\n</dl>\n`;
}
