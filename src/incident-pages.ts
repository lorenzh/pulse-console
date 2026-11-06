import type {
  AdminComponent,
  AdminConfigResponse,
  Incident,
  ManualIncident,
  ResultsResponse,
} from "@lorenzh/pulse-contract";
import { escapeHtml } from "@lorenzh/pulse-kit";
import { unaddressableText } from "./check-detail-pages.ts";
import { reasonText, utcTime, utcTimeMs } from "./check-format.ts";
import { idQuery, link } from "./check-pages.ts";
import {
  csrfField,
  field,
  formErrorSummary,
  formTokenField,
  paragraph,
  submitButton,
  textareaField,
} from "./html.ts";
import type { ComposerInput, FieldErrors } from "./incident-form.ts";
import { incidentTitleText } from "./incident-form.ts";
import {
  automaticMttr,
  durationText,
  type IncidentFilters,
  type IncidentRow,
  incidentRows,
  listedRows,
  MAX_INCIDENT_ROWS,
  type MttrStat,
  manualMttr,
} from "./incident-list.ts";
import { type PreviewParts, previewSection } from "./incident-preview.ts";
import type { IncidentResultsRead } from "./incident-read.ts";
import { isAllowed } from "./permissions.ts";
import type { ConsoleRole } from "./roles.ts";
import { alertCallout, callout, emptyState } from "./states.ts";

export const INCIDENT_DELETED_TEXT = "Incident deleted.";
export const INCIDENT_PUBLISHED_TEXT = "Incident published.";
export const UPDATE_POSTED_TEXT = "Update posted.";
export const INCIDENT_RESOLVED_TEXT = "Incident resolved.";
export const ALREADY_RESOLVED_TEXT = "This incident is already resolved.";
export const AUTOMATIC_GONE_TEXT =
  "This automatic incident is not among the incidents of the last 14 days.";
export const CHECK_GONE_TEXT = "The check no longer exists; no results.";
export const AUTOMATIC_TEXT =
  "Automatic incidents are opened and resolved by pulse-api from check results. They cannot be edited here.";
export const PUBLISH_WARNING_TEXT =
  "Publishing posts this incident to the status page at once and sends notifications. Sent notifications cannot be recalled.";
export const RESOLVE_WARNING_TEXT =
  "Resolving ends the incident on the status page and discards any unpublished draft update of it. A resolved incident cannot be reopened.";
export const NO_COMPONENTS_TEXT = "No components are configured; the incident names no component.";
export const FILTERS_IGNORED_TEXT = "Some filters were ignored.";

const IMPACTS = ["none", "minor", "major", "critical"] as const;
const OPEN_STATUSES = ["investigating", "identified", "monitoring"] as const;

function timeHtml(epochMs: number): string {
  return `<time datetime="${new Date(epochMs).toISOString()}">${escapeHtml(utcTime(epochMs))}</time>`;
}

function success(text: string): string {
  return callout({ kind: "success", body: paragraph(text), role: "status" });
}

function durationOf(start: number, resolvedAt: number | null, now: number): string {
  return resolvedAt === null
    ? `open for ${durationText(now - start)}`
    : durationText(resolvedAt - start);
}

function checkName(config: AdminConfigResponse, checkId: string): string {
  return config.checks.find((check) => check.id === checkId)?.name ?? checkId;
}

function componentName(components: readonly AdminComponent[], id: string): string {
  return components.find((c) => c.id === id)?.name ?? id;
}

// --- List ---------------------------------------------------------------------------------

/** What the list page shows besides the reads. */
export type IncidentListModel = {
  manual: readonly ManualIncident[];
  automatic: readonly Incident[];
  config: AdminConfigResponse;
  filters: IncidentFilters;
  role: ConsoleRole;
  now: number;
  /** The success callout of a redirect, if any. */
  notice?: string | undefined;
};

function mttrHtml(stat: MttrStat): string {
  return `<div class="mttr"><dt>${escapeHtml(stat.label)}</dt><dd><span class="mttr-value">${escapeHtml(stat.value)}</span> <span class="cell-sub">${escapeHtml(stat.sample)}</span></dd></div>`;
}

function rowTitle(row: IncidentRow, config: AdminConfigResponse): string {
  if (row.manual !== undefined) {
    const href = `/incidents/manual?id=${row.id}`;
    return link(href, incidentTitleText(row.id, row.manual.title));
  }
  const automatic = row.automatic;
  const name = automatic === undefined ? "" : checkName(config, automatic.checkId);
  const reason = automatic?.reason ?? null;
  const label = `${name} — ${reason === null ? "no reason" : reasonText(reason)}`;
  return link(`/incidents/automatic?id=${row.id}`, label);
}

function rowState(row: IncidentRow): string {
  if (row.manual !== undefined) return row.manual.status;
  return row.resolvedAt === null ? "open" : "resolved";
}

function rowHtml(row: IncidentRow, config: AdminConfigResponse, now: number): string {
  const kind = row.kind === "manual" ? "Manual" : "Automatic";
  const impact =
    row.manual === undefined
      ? ""
      : `<span class="cell-sub">Impact: ${escapeHtml(row.manual.impact)}</span>`;
  const cells = [
    `<td><span class="cell-sub">${kind}</span><span class="cell-title incident-title">${rowTitle(row, config)}</span>${impact}</td>`,
    `<td>${escapeHtml(rowState(row))}</td>`,
    `<td class="mono">${timeHtml(row.start)}</td>`,
    `<td>${escapeHtml(durationOf(row.start, row.resolvedAt, now))}</td>`,
  ];
  return `<tr>${cells.join("")}</tr>`;
}

function rowsTable(rows: readonly IncidentRow[], config: AdminConfigResponse, now: number): string {
  const heads = ["Incident", "State", "Started", "Duration"]
    .map((head) => `<th scope="col">${head}</th>`)
    .join("");
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="Incidents table">
<table class="incidents">
<thead><tr>${heads}</tr></thead>
<tbody>
${rows.map((row) => rowHtml(row, config, now)).join("\n")}
</tbody>
</table>
</div>
`;
}

function filterLink(filters: IncidentFilters, state: string, kind: string, label: string): string {
  const isCurrent = filters.state === state && filters.kind === kind;
  const href = `/incidents?state=${state}&kind=${kind}`;
  const current = isCurrent ? ' aria-current="page"' : "";
  return `<a href="${escapeHtml(href)}"${current}>${escapeHtml(label)}</a>`;
}

function filterLinks(filters: IncidentFilters): string {
  const states = ["all", "open", "resolved"].map((s) =>
    filterLink(filters, s, filters.kind, `State: ${s}`),
  );
  const kinds = ["all", "manual", "automatic"].map((k) =>
    filterLink(filters, filters.state, k, `Kind: ${k}`),
  );
  return `<nav class="filters" aria-label="Incident filters"><p class="actions">${states.join(" ")}</p><p class="actions">${kinds.join(" ")}</p></nav>\n`;
}

function declareLink(role: ConsoleRole): string {
  return isAllowed(role, "incident.write")
    ? `<p class="actions"><a class="button" href="/incidents/new">Declare incident</a></p>\n`
    : "";
}

function listContent(model: IncidentListModel): string {
  const all = incidentRows(model.manual, model.automatic);
  if (all.length === 0) {
    return emptyState({ title: "No incidents", text: "No incidents in the last 14 days." });
  }
  const listed = listedRows(all, model.filters);
  if (listed.total === 0) {
    return emptyState({
      title: "No matching incidents",
      text: "No incidents match these filters.",
      action: { href: "/incidents", label: "Clear filters" },
    });
  }
  const bound =
    listed.total > MAX_INCIDENT_ROWS
      ? paragraph(
          `Showing the first ${MAX_INCIDENT_ROWS} of ${listed.total} incidents. Narrow the filters.`,
        )
      : "";
  return rowsTable(listed.rows, model.config, model.now) + bound;
}

/** Section 4 and 5: MTTR, filters and rows of a successful read. */
export function incidentListBody(model: IncidentListModel): string {
  const notice = model.notice === undefined ? "" : success(model.notice);
  const ignored = model.filters.hasIgnored
    ? callout({ kind: "info", body: paragraph(FILTERS_IGNORED_TEXT), role: "status" })
    : "";
  const mttr = `<dl class="settings mttr-list">${mttrHtml(manualMttr(model.manual))}${mttrHtml(automaticMttr(model.automatic, model.now))}</dl>\n`;
  return `${notice}${declareLink(model.role)}${mttr}${filterLinks(model.filters)}${ignored}${listContent(model)}`;
}

// --- Forms --------------------------------------------------------------------------------

function radioGroup(
  name: string,
  legend: string,
  values: readonly string[],
  checked: string,
  error: string | undefined,
): string {
  const errorHtml =
    error === undefined
      ? ""
      : `<span class="error" id="field-${name}-error">${escapeHtml(error)}</span>`;
  const radios = values
    .map((value, index) => {
      const id = index === 0 ? ` id="field-${name}"` : "";
      const isChecked = value === checked ? " checked" : "";
      return `<label class="choice"><input type="radio"${id} name="${name}" value="${escapeHtml(value)}"${isChecked}> ${escapeHtml(value)}</label>`;
    })
    .join("\n");
  return `<fieldset class="choices"><legend>${escapeHtml(legend)}</legend>\n${radios}${errorHtml}</fieldset>`;
}

function componentChoices(
  components: readonly AdminComponent[],
  selected: readonly string[],
  error: string | undefined,
): string {
  const errorHtml =
    error === undefined
      ? ""
      : `<span class="error" id="field-component-error">${escapeHtml(error)}</span>`;
  // A selected id that is no longer configured stays as a checked box, so the
  // re-rendered form keeps every input and the refusal names it.
  const known = new Set(components.map((c) => c.id));
  const removed = selected
    .filter((id) => !known.has(id))
    .map((id) => ({ id, name: id, checkIds: [] }));
  const shown: readonly AdminComponent[] = [...components, ...removed];
  if (shown.length === 0) return `${paragraph(NO_COMPONENTS_TEXT)}${errorHtml}`;
  const boxes = shown
    .map((c, index) => {
      const id = index === 0 ? ` id="field-component"` : "";
      const isChecked = selected.includes(c.id) ? " checked" : "";
      return `<label class="choice"><input type="checkbox"${id} name="component" value="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}"${isChecked}> ${escapeHtml(c.name)}</label>`;
    })
    .join("\n");
  return `<fieldset class="choices"><legend>Affected components</legend>\n${boxes}${errorHtml}</fieldset>`;
}

const FIELD_ORDER = ["title", "impact", "status", "component", "message"] as const;

function summaryOf(errors: FieldErrors): string {
  const list = FIELD_ORDER.flatMap((name) => {
    const text = errors[name];
    return text === undefined ? [] : [{ name, text }];
  });
  return formErrorSummary(list);
}

function formButtons(publishLabel: string, busyLabel: string, cancelHref?: string): string {
  const preview = submitButton({
    label: "Update preview",
    busyLabel: "Updating…",
    name: "action",
    value: "preview",
    variant: "secondary",
  });
  const publish = submitButton({
    label: publishLabel,
    busyLabel,
    name: "action",
    value: "publish",
  });
  const cancel =
    cancelHref === undefined
      ? ""
      : `<a class="button ghost cancel" href="${escapeHtml(cancelHref)}">Cancel</a> `;
  return `<div class="panel-foot">${cancel}${preview} ${publish}</div>`;
}

/** The common parts of every incident form. */
type FormBase = {
  csrf: string;
  formToken: string;
  errors: FieldErrors;
  preview: PreviewParts;
  /** A callout above the form: a refusal, a write answer or the composer's `from` text. */
  notice?: string | undefined;
  noticeKind?: "info" | "error" | undefined;
};

function noticeHtml(base: FormBase): string {
  if (base.notice === undefined) return "";
  return base.noticeKind === "info"
    ? callout({ kind: "info", body: paragraph(base.notice), role: "status" })
    : alertCallout(base.notice);
}

function formHead(action: string, base: FormBase): string {
  return `<form method="post" action="${escapeHtml(action)}" class="panel incident-form" data-preview-form>
${csrfField(base.csrf)}
${formTokenField(base.formToken)}`;
}

/** The composer: title, impact, status, components, message and the preview (section 9). */
export function composerHtml(
  view: FormBase & { input: ComposerInput; components: readonly AdminComponent[] },
): string {
  const { input, errors } = view;
  const title = field({
    label: "Title",
    name: "title",
    type: "text",
    autocomplete: "off",
    value: input.title,
    error: errors.title,
  });
  return `${noticeHtml(view)}${summaryOf(errors)}${formHead("/incidents/new", view)}
<div class="panel-body">
${title}
${radioGroup("impact", "Impact", IMPACTS, input.impact, errors.impact)}
${radioGroup("status", "Status", OPEN_STATUSES, input.status, errors.status)}
${componentChoices(view.components, input.components, errors.component)}
${textareaField({ label: "Message", name: "message", value: input.message, error: errors.message })}
${paragraph(PUBLISH_WARNING_TEXT)}</div>
${formButtons("Publish incident", "Publishing…", "/incidents")}
</form>
${previewSection(view.preview)}`;
}

function incidentHidden(id: number): string {
  return `<input type="hidden" name="incident" value="${id}">`;
}

/** The post-update form of an open incident's detail page. */
export function updateFormHtml(
  view: FormBase & { id: number; status: string; message: string },
): string {
  return `<section class="panel" aria-labelledby="update-heading">
<div class="panel-head"><h2 class="eyebrow" id="update-heading">Post update</h2></div>
${noticeHtml(view)}${summaryOf(view.errors)}${formHead("/incidents/update", view)}
${incidentHidden(view.id)}
<div class="panel-body">
${radioGroup("status", "Status", OPEN_STATUSES, view.status, view.errors.status)}
${textareaField({ label: "Message", name: "message", value: view.message, error: view.errors.message })}
${paragraph(PUBLISH_WARNING_TEXT)}</div>
${formButtons("Post update", "Posting…")}
</form>
${previewSection(view.preview)}</section>
`;
}

/** The resolve page: message, preview and two named buttons; not `plainConfirmPage`. */
export function resolveFormHtml(view: FormBase & { id: number; message: string }): string {
  const detail = `/incidents/manual?id=${view.id}`;
  const head = formHead(`/incidents/resolve?id=${view.id}`, view);
  return `${noticeHtml(view)}${summaryOf(view.errors)}${head}
${incidentHidden(view.id)}
<div class="panel-body">
${paragraph(RESOLVE_WARNING_TEXT, ' class="confirm-title"')}${textareaField({ label: "Message", name: "message", value: view.message, error: view.errors.message })}
</div>
${formButtons("Resolve incident", "Resolving…", detail)}
</form>
${previewSection(view.preview)}`;
}

// --- Details ------------------------------------------------------------------------------

function settingsList(entries: ReadonlyArray<readonly [string, string]>): string {
  const items = entries.map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${value}</dd>`);
  return `<dl class="settings">\n${items.join("\n")}\n</dl>\n`;
}

function timelineHtml(incident: ManualIncident): string {
  const items = incident.updates.map(
    (update, index) =>
      `<li id="update-${index}"><p><span class="mono">#${index}</span> <strong>${escapeHtml(update.status)}</strong> ${timeHtml(update.at)}</p><p class="incident-message">${escapeHtml(update.message)}</p></li>`,
  );
  return `<section class="panel" aria-labelledby="timeline-heading">
<div class="panel-head"><h2 class="eyebrow" id="timeline-heading">Timeline</h2></div>
<div class="panel-body"><ol class="timeline">
${items.join("\n")}
</ol></div>
</section>
`;
}

function manualActions(incident: ManualIncident, role: ConsoleRole): string {
  const list = [link("/incidents", "All incidents")];
  if (incident.resolvedAt === null && isAllowed(role, "incident.write")) {
    list.push(link(`/incidents/resolve?id=${incident.id}`, "Resolve"));
  }
  if (isAllowed(role, "incident.delete")) {
    list.push(link(`/incidents/delete?id=${incident.id}`, "Delete"));
  }
  return `<p class="actions">${list.join(" ")}</p>\n`;
}

/** What the manual detail page needs besides the incident. */
export type ManualDetailModel = {
  incident: ManualIncident;
  components: readonly AdminComponent[];
  role: ConsoleRole;
  now: number;
  notice?: string | undefined;
  /** The post-update form HTML, for an open incident and Member+; else empty. */
  updateForm: string;
};

/** Section 7: header, timeline, the update form and the actions. */
export function manualDetailBody(model: ManualDetailModel): string {
  const { incident } = model;
  const components =
    incident.componentIds.length === 0
      ? "No component"
      : incident.componentIds.map((id) => componentName(model.components, id)).join(", ");
  const resolved = incident.resolvedAt === null ? "open" : timeHtml(incident.resolvedAt);
  const header = settingsList([
    ["Impact", `Impact: ${escapeHtml(incident.impact)}`],
    ["Status", `Status: ${escapeHtml(incident.status)}`],
    ["Components", escapeHtml(components)],
    ["Started", timeHtml(incident.createdAt)],
    ["Resolved", resolved],
    ["Duration", escapeHtml(durationOf(incident.createdAt, incident.resolvedAt, model.now))],
  ]);
  const notice = model.notice === undefined ? "" : success(model.notice);
  return `${notice}${manualActions(incident, model.role)}<h2 class="incident-title">${escapeHtml(incidentTitleText(incident.id, incident.title))}</h2>
${header}${timelineHtml(incident)}${model.updateForm}`;
}

function resultsHtml(results: ResultsResponse): string {
  if (results.length === 0) return paragraph("No results yet");
  const rows = results.map(
    (r) =>
      `<tr><td class="mono">${escapeHtml(utcTimeMs(r.timestamp))}</td><td>${escapeHtml(r.location)}</td><td>${escapeHtml(r.status)}</td><td>${r.statusCode === null ? "" : r.statusCode}</td><td>${r.latencyMs} ms</td><td>${r.reason === null ? "" : escapeHtml(reasonText(r.reason))}</td></tr>`,
  );
  const heads = ["Time", "Location", "Status", "Status code", "Latency", "Reason"]
    .map((head) => `<th scope="col">${head}</th>`)
    .join("");
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="Results table">
<table class="results"><thead><tr>${heads}</tr></thead>
<tbody>
${rows.join("\n")}
</tbody></table></div>
`;
}

/** The results panel; a failed results read shows `problem`. */
function resultsPanel(read: IncidentResultsRead, checkId: string, problem: string): string {
  let inner = problem;
  if (read.kind === "ok") inner = resultsHtml(read.value);
  else if (read.kind === "check-gone") inner = paragraph(CHECK_GONE_TEXT);
  else if (read.kind === "unaddressable") inner = paragraph(unaddressableText(checkId));
  return `<section class="panel" aria-labelledby="results-heading">
<div class="panel-head"><h2 class="eyebrow" id="results-heading">Check results</h2></div>
<div class="panel-body">
${inner}</div>
</section>
`;
}

/** What the automatic detail page needs. */
export type AutomaticDetailModel = {
  incident: Incident;
  config: AdminConfigResponse;
  results: IncidentResultsRead;
  /** The failure state of a failed results read. */
  resultsProblem: string;
  role: ConsoleRole;
  now: number;
};

/** Section 8: read-only automatic detail and the check's results. */
export function automaticDetailBody(model: AutomaticDetailModel): string {
  const { incident } = model;
  const name = checkName(model.config, incident.checkId);
  const checkHref = `/checks/check${idQuery(incident.checkId)}`;
  const checkLink = `${link(checkHref, name)} <code>${escapeHtml(incident.checkId)}</code>`;
  const resolved = incident.resolvedAt === null ? "open" : timeHtml(incident.resolvedAt);
  const reason = incident.reason === null ? "no reason" : reasonText(incident.reason);
  const header = settingsList([
    ["Check", checkLink],
    ["Reason", escapeHtml(reason)],
    ["Opened", timeHtml(incident.openedAt)],
    ["Resolved", resolved],
    ["Duration", escapeHtml(durationOf(incident.openedAt, incident.resolvedAt, model.now))],
  ]);
  const actions = [link("/incidents", "All incidents")];
  if (isAllowed(model.role, "incident.write")) {
    actions.push(link(`/incidents/new?from=${incident.id}`, "Post a public update"));
  }
  return `<p class="actions">${actions.join(" ")}</p>
${paragraph(AUTOMATIC_TEXT)}${header}${resultsPanel(model.results, incident.checkId, model.resultsProblem)}`;
}

/** The kept input as text, without a form (section 10, unknown and refused answers). */
export function keptInputHtml(entries: ReadonlyArray<readonly [string, string]>): string {
  const shown = entries.filter(([, value]) => value !== "");
  if (shown.length === 0) return "";
  const items = shown.map(
    ([name, value]) =>
      `<dt>${escapeHtml(name)}</dt><dd class="incident-message">${escapeHtml(value)}</dd>`,
  );
  return `<h2>Your input</h2>\n<dl class="settings">\n${items.join("\n")}\n</dl>\n`;
}
