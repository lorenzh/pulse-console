import type {
  AdminCheckView,
  CheckLatency,
  CheckLocationUptime,
  CheckWithState,
  Result,
  ResultsResponse,
  Slo,
  UptimeResponse,
} from "@lorenzh/pulse-contract";
import { escapeHtml } from "@lorenzh/pulse-kit";
import { apiIdSegment } from "./api-path.ts";
import { budgetText, formatPercent, utcTime } from "./check-format.ts";
import {
  type CheckView,
  checkProblemView,
  idQuery,
  link,
  SHADOWED_TEXT,
  STATE_LABELS,
  TYPE_LABELS,
  UNADDRESSABLE,
} from "./check-pages.ts";
import type { CheckDetail, CheckDetailRead, CheckReadProblem, PanelRead } from "./check-read.ts";
import { paragraph } from "./html.ts";
import { isAllowed } from "./permissions.ts";
import type { ConsoleRole } from "./roles.ts";
import { type HostBinding, heartbeatLine, hostBindingLine } from "./shell-line.ts";
import { apiUnavailableState } from "./states.ts";

/** Decision 14: the panel text for an id that no api path can carry. */
export function unaddressableText(id: string): string {
  return `pulse-api cannot address the id "${id}" in a URL path, so its results, per-location uptime and latency cannot be read. Rename the check to use them.`;
}

/** Decision 14: the heartbeat usage text for such an id. */
export function unaddressableHeartbeatText(id: string): string {
  return `pulse-api cannot address the id "${id}" in a URL path, so pulse-api cannot receive pings for it. Rename the check.`;
}

export const LOCATION_UPTIME_OLD_TEXT = "Location uptime needs a newer pulse-api.";
export const PROBE_RULE_TEXT =
  "Every probe runs this check. It is down when at least two locations report down; with one reporting location, that location decides.";
export const HEARTBEAT_RULE_TEXT =
  "Heartbeat checks are not run by probes; your job pings pulse-api.";
export const SHADOWED_PAGE_TEXT =
  "Shadowed by checks.json: the check from checks.json runs instead. This definition is kept in the database.";
const HEARTBEAT_NOTE =
  "Use the address under which your job reaches pulse-api. The secret is not shown again.";
const LATENCY_VISIBLE_DAYS = 14;
const RESULTS_PAGE_ROWS = 20;

function section(heading: string, inner: string): string {
  return `<section class="panel">
<h2>${escapeHtml(heading)}</h2>
${inner}</section>
`;
}

function tableHtml(heads: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const head = heads.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join("");
  const cellsOf = (row: readonly string[]): string =>
    row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("");
  const body = rows.map((row) => `<tr>${cellsOf(row)}</tr>`).join("\n");
  return `<div class="table-wrap table-scroll">
<table>
<thead><tr>${head}</tr></thead>
<tbody>
${body}
</tbody>
</table>
</div>
`;
}

function definitionList(entries: ReadonlyArray<readonly [string, string]>): string {
  const items = entries
    .map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("\n");
  return `<dl class="settings">
${items}
</dl>
`;
}

// Fields shown elsewhere, or write-only markers that get their own `set` rows.
const SKIPPED_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "type",
  "source",
  "headers",
  "body",
  "hasSecret",
  "secret",
]);

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => valueText(item)).join(", ");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

function headerText(value: unknown): string {
  if (typeof value === "object" && value !== null && Object.hasOwn(value, "env")) {
    const env: unknown = Object.getOwnPropertyDescriptor(value, "env")?.value;
    if (typeof env === "string") return `Secret from the probe environment: ${env}`;
  }
  // A literal value is never served (keep marker); it is shown only as `set`.
  return "set";
}

/** R2 settings: every stored field of the view, never a write-only value. */
function settingsEntries(view: AdminCheckView): Array<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [
    ["Name", view.name],
    ["Id", view.id],
    ["Type", TYPE_LABELS[view.type ?? "http"]],
    ["Source", view.source === "file" ? "checks.json (read-only)" : "Console"],
  ];
  for (const [key, value] of Object.entries(view)) {
    if (!SKIPPED_FIELDS.has(key)) entries.push([key, valueText(value)]);
  }
  if ("headers" in view && view.headers !== undefined) {
    for (const [name, value] of Object.entries(view.headers)) {
      entries.push([`Header ${name}`, headerText(value)]);
    }
  }
  if ("body" in view && view.body !== undefined) entries.push(["Body", "set"]);
  if ("hasSecret" in view && view.hasSecret === true) entries.push(["Secret", "set"]);
  return entries;
}

function settingsSection(view: AdminCheckView): string {
  return section("Settings", definitionList(settingsEntries(view)));
}

/** Env headers of an HTTP check with the host of its URL, in header order. */
function hostBindingsOf(view: AdminCheckView): HostBinding[] {
  if (!("url" in view) || view.headers === undefined) return [];
  let host: string;
  try {
    host = new URL(view.url).hostname;
  } catch {
    // The contract validated the URL; a parse failure means no line can be built.
    return [];
  }
  const bindings: HostBinding[] = [];
  for (const [, value] of Object.entries(view.headers)) {
    if (typeof value === "object" && "env" in value) bindings.push({ variable: value.env, host });
  }
  return bindings;
}

function copyBlock(elementId: string, line: string): string {
  return `<pre id="${elementId}">${escapeHtml(line)}</pre>
<button type="button" data-copy="${elementId}" hidden>Copy</button>
`;
}

function hostBindingSection(view: AdminCheckView): string {
  const bindings = hostBindingsOf(view);
  if (bindings.length === 0) return "";
  return section(
    "Probe host binding",
    `${paragraph("Set this on every probe so the env header values are sent only to this host.")}${copyBlock("host-binding-line", hostBindingLine(bindings))}`,
  );
}

function heartbeatSection(view: AdminCheckView, apiUrl: string): string {
  if (view.type !== "heartbeat") return "";
  const segment = apiIdSegment(view.id);
  if (segment === undefined) {
    return section("Heartbeat usage", paragraph(unaddressableHeartbeatText(view.id)));
  }
  const line = heartbeatLine(`${apiUrl}/heartbeat/${segment}`);
  return section(
    "Heartbeat usage",
    `${copyBlock("heartbeat-line", line)}${paragraph(HEARTBEAT_NOTE)}`,
  );
}

function panelProblem<T>(read: PanelRead<T>, id: string, retryHref: string): string | undefined {
  switch (read.kind) {
    case "ok":
    case "absent":
      return undefined;
    case "failed":
      return apiUnavailableState(read.failure, retryHref);
    case "unaddressable":
      return paragraph(unaddressableText(id));
    case "needs-newer":
      return paragraph(LOCATION_UPTIME_OLD_TEXT);
    default: {
      const never: never = read;
      return never;
    }
  }
}

function stateEntries(view: AdminCheckView, state: CheckWithState | undefined) {
  const entries: Array<readonly [string, string]> = [
    ["State", STATE_LABELS[state?.state ?? "unknown"]],
    ["Consecutive down", String(state?.consecutiveDown ?? 0)],
    ["Last result", utcTime(state?.lastResultAt ?? null)],
    ["Last reason", state?.lastReason ?? "None"],
  ];
  const window = state?.maintenance;
  if (window !== undefined) {
    entries.push([
      "Maintenance",
      `${utcTime(window.start)} to ${utcTime(window.end)}: ${window.note}`,
    ]);
  }
  const isCertType = view.type === "tls" || view.type === "domain";
  const days = state?.certDaysLeft;
  if (isCertType) {
    entries.push([
      "Certificate days left",
      days === undefined || days === null ? "Unknown" : String(days),
    ]);
  }
  return entries;
}

function sloText(slo: Slo | undefined): string {
  if (slo === undefined) return "No availability objective";
  if (slo.availability === null || slo.budgetRemaining === null) {
    return `Objective ${slo.target} %: no results in the last 30 days`;
  }
  return `Availability ${formatPercent(slo.availability)} over 30 days, objective ${slo.target} %. ${budgetText(slo.budgetRemaining)}`;
}

function stateSection(view: AdminCheckView, state: CheckWithState | undefined): string {
  return section(
    "State",
    `${definitionList(stateEntries(view, state))}${paragraph(sloText(state?.slo))}`,
  );
}

type LocationRow = {
  name: string;
  latest: { result: Result; stale: boolean } | undefined;
  uptime: CheckLocationUptime["locations"][number] | undefined;
};

// UTF-16 code-unit order, as the api sorts location names; localeCompare would differ.
function codeUnitOrder(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Locations of `/checks` and of the location uptime, joined by name, in code-unit order. */
function locationRows(
  state: CheckWithState | undefined,
  uptime: CheckLocationUptime | undefined,
): LocationRow[] {
  const names = new Set<string>();
  for (const entry of state?.locations ?? []) names.add(entry.location);
  for (const entry of uptime?.locations ?? []) names.add(entry.location);
  return [...names].sort(codeUnitOrder).map((name) => ({
    name,
    latest: state?.locations.find((entry) => entry.location === name),
    uptime: uptime?.locations.find((entry) => entry.location === name),
  }));
}

function locationUptimeText(row: LocationRow, isRead: boolean): string {
  if (!isRead) return "Not available";
  if (row.uptime === undefined || row.uptime.results === 0) return "No results in 90 days";
  return `${formatPercent(row.uptime.uptime)} with ${row.uptime.good} of ${row.uptime.results} results`;
}

function locationCells(row: LocationRow, isHeartbeat: boolean, isRead: boolean): string[] {
  const name = isHeartbeat && row.name === "heartbeat" ? "Heartbeat pings" : row.name;
  const result = row.latest?.result;
  if (result === undefined) {
    return [name, "No current result", "", "", "", "", "", locationUptimeText(row, isRead)];
  }
  return [
    name,
    STATE_LABELS[result.status],
    utcTime(result.timestamp),
    isHeartbeat ? "Not applicable" : `${result.latencyMs} ms`,
    String(result.attempts),
    result.reason ?? "",
    row.latest?.stale === true ? "Stale" : "",
    locationUptimeText(row, isRead),
  ];
}

function locationsSection(detail: CheckDetail, retryHref: string): string {
  const isHeartbeat = detail.view.type === "heartbeat";
  const read = detail.locationUptime;
  const uptime = read.kind === "ok" ? read.value : undefined;
  const rule = paragraph(isHeartbeat ? HEARTBEAT_RULE_TEXT : PROBE_RULE_TEXT);
  const problem = panelProblem(read, detail.view.id, retryHref) ?? "";
  const rows = locationRows(detail.state, uptime);
  const heads = [
    "Location",
    "Status",
    "Time",
    "Latency",
    "Attempts",
    "Reason",
    "Fresh",
    "Uptime 90 days",
  ];
  const table =
    rows.length === 0
      ? paragraph("No location has reported yet.")
      : tableHtml(
          heads,
          rows.map((row) => locationCells(row, isHeartbeat, uptime !== undefined)),
        );
  return section("Locations", `${rule}${problem}${table}`);
}

function uptimeSection(read: PanelRead<UptimeResponse>, id: string, retryHref: string): string {
  const problem = panelProblem(read, id, retryHref);
  if (problem !== undefined) return section("Uptime", problem);
  const entry = read.kind === "ok" ? read.value.find((u) => u.checkId === id) : undefined;
  if (entry === undefined) return section("Uptime", paragraph("No results"));
  const rows = entry.days.map((day) => [
    day.date,
    day.uptime === null ? "No results" : formatPercent(day.uptime),
    String(day.results),
  ]);
  const aggregate = `${formatPercent(entry.uptime)} over 90 days`;
  return section(
    "Uptime",
    `${paragraph(aggregate)}<details>
<summary>Every day</summary>
${tableHtml(["Date", "Uptime", "Results"], rows)}</details>
`,
  );
}

function latencySection(read: PanelRead<CheckLatency>, id: string, retryHref: string): string {
  if (read.kind === "absent") return "";
  const problem = panelProblem(read, id, retryHref);
  if (problem !== undefined || read.kind !== "ok") return section("Latency", problem ?? "");
  const heads = ["Date", "p50", "p95", "Count"];
  const rows = [...read.value.days]
    .reverse()
    .map((day) =>
      day.count === 0 || day.p50Ms === null || day.p95Ms === null
        ? [day.date, "No results", "No results", "0"]
        : [day.date, `${day.p50Ms} ms`, `${day.p95Ms} ms`, String(day.count)],
    );
  const recent = tableHtml(heads, rows.slice(0, LATENCY_VISIBLE_DAYS));
  const older = rows.slice(LATENCY_VISIBLE_DAYS);
  const rest =
    older.length === 0
      ? ""
      : `<details>
<summary>Older days</summary>
${tableHtml(heads, older)}</details>
`;
  return section("Latency", `${recent}${rest}`);
}

function resultCells(result: Result): string[] {
  return [
    utcTime(result.timestamp),
    result.location,
    STATE_LABELS[result.status],
    result.statusCode === null ? "" : String(result.statusCode),
    `${result.latencyMs} ms`,
    String(result.attempts),
    result.reason ?? "",
  ];
}

function pagingLinks(results: ResultsResponse, id: string, before: string | undefined): string {
  const links: string[] = [];
  const last = results.at(-1);
  if (before !== undefined) links.push(link(`/checks/check${idQuery(id)}`, "Newest results"));
  if (results.length >= RESULTS_PAGE_ROWS && last !== undefined) {
    links.push(link(`/checks/check${idQuery(id)}&before=${last.timestamp}`, "Older results"));
  }
  return links.length === 0 ? "" : `<p class="actions">${links.join(" ")}</p>\n`;
}

function resultsSection(
  detail: CheckDetail,
  retryHref: string,
  before: string | undefined,
): string {
  const read = detail.results;
  const problem = panelProblem(read, detail.view.id, retryHref);
  if (problem !== undefined || read.kind !== "ok") return section("Recent results", problem ?? "");
  const heads = ["Time", "Location", "Status", "Status code", "Latency", "Attempts", "Reason"];
  const table =
    read.value.length === 0
      ? paragraph("No results yet")
      : tableHtml(heads, read.value.map(resultCells));
  return section("Recent results", `${table}${pagingLinks(read.value, detail.view.id, before)}`);
}

function actions(view: AdminCheckView, role: ConsoleRole, isShadowed: boolean): string {
  const id = idQuery(view.id);
  const shadowedQuery = isShadowed ? "&shadowed=1" : "";
  const isAddressable = !UNADDRESSABLE.has(view.id);
  const isDatabase = view.source === "database";
  const list: string[] = [link("/checks", "All checks")];
  if (isShadowed) list.push(link(`/checks/check${id}`, "View the check from checks.json"));
  if (isAllowed(role, "check.write") && isDatabase && !isShadowed && isAddressable) {
    list.push(link(`/checks/edit${id}`, "Edit"));
  }
  if (isAllowed(role, "check.write")) {
    list.push(link(`/checks/export${id}${shadowedQuery}`, "Export"));
  }
  if (isAllowed(role, "check.delete") && (isDatabase || isShadowed) && isAddressable) {
    list.push(link(`/checks/delete${id}${shadowedQuery}`, "Delete"));
  }
  return `<p class="actions">${list.join(" ")}</p>\n`;
}

/** What the detail page needs besides the read. */
export type DetailContext = {
  id: string;
  before: string | undefined;
  role: ConsoleRole;
  apiUrl: string;
};

/** A detail or shadowed view, or the 404 for an unknown id. */
export type DetailPage = { kind: "not-found" } | { kind: "view"; title: string; view: CheckView };

/** R2: the detail page of an effective check. */
export function checkDetailPage(read: CheckDetailRead, context: DetailContext): DetailPage {
  const retryHref = `/checks/check${idQuery(context.id)}`;
  if (read.kind === "not-found") return { kind: "not-found" };
  if (read.kind !== "ok") {
    return { kind: "view", title: "Check", view: checkProblemView(read, retryHref) };
  }
  const { detail } = read;
  const { view } = detail;
  const body = [
    actions(view, context.role, false),
    stateSection(view, detail.state),
    settingsSection(view),
    hostBindingSection(view),
    heartbeatSection(view, context.apiUrl),
    locationsSection(detail, retryHref),
    uptimeSection(detail.uptime, view.id, retryHref),
    latencySection(detail.latency, view.id, retryHref),
    resultsSection(detail, retryHref, context.before),
  ].join("");
  return { kind: "view", title: view.name, view: { banner: "", body } };
}

/** R3: the stored definition that `checks.json` shadows. No runtime data. */
export function shadowedPage(
  read: CheckReadProblem | { kind: "ok"; view: AdminCheckView | undefined },
  id: string,
  role: ConsoleRole,
): DetailPage {
  if (read.kind !== "ok") {
    return {
      kind: "view",
      title: SHADOWED_TEXT,
      view: checkProblemView(read, `/checks/shadowed${idQuery(id)}`),
    };
  }
  if (read.view === undefined) return { kind: "not-found" };
  const body = `${paragraph(SHADOWED_PAGE_TEXT, ' role="status"')}${actions(read.view, role, true)}${settingsSection(read.view)}`;
  return { kind: "view", title: read.view.name, view: { banner: "", body } };
}
