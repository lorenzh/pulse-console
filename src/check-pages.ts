import type { AdminConfigResponse, AdminFileStatus, CheckState } from "@lorenzh/pulse-contract";
import { escapeHtml } from "@lorenzh/pulse-kit";
import { EXPORT_NOTE } from "./check-export.ts";
import {
  type CHECK_SOURCE_FILTERS,
  type CHECK_TYPES,
  type CheckFilters,
  type CheckRow,
  FILTERS_IGNORED_NOTICE,
  isCheckRowMatched,
  type ParsedCheckFilters,
} from "./check-filters.ts";
import { targetText, utcTime } from "./check-format.ts";
import type { CheckListRead, CheckReadProblem } from "./check-read.ts";
import { OLD_API_TEXT } from "./check-read.ts";
import { NO_TOKEN_TEXT } from "./connection-test.ts";
import { paragraph } from "./html.ts";
import { isAllowed } from "./permissions.ts";
import type { ConsoleRole } from "./roles.ts";
import { apiUnavailableState, emptyState, tokenRejectedBanner } from "./states.ts";

/** A Checks page body and the banner for the shell slot (empty when none). */
export type CheckView = { banner: string; body: string };

/** The shadowed-row text of the list and the shadowed page. */
export const SHADOWED_TEXT = "Shadowed by checks.json";

const STATE_LABELS: Record<CheckState, string> = {
  up: "Up",
  degraded: "Degraded",
  down: "Down",
  unknown: "Unknown",
  maintenance: "Maintenance",
};

const TYPE_LABELS: Record<(typeof CHECK_TYPES)[number], string> = {
  http: "HTTP",
  tls: "TLS",
  tcp: "TCP",
  dns: "DNS",
  domain: "Domain",
  heartbeat: "Heartbeat",
};

const SOURCE_LABELS: Record<(typeof CHECK_SOURCE_FILTERS)[number], string> = {
  file: "checks.json",
  database: "Console",
  shadowed: "Shadowed",
};

function errorSection(heading: string, text: string): string {
  return `<section class="state state-error" role="alert">
<h2>${escapeHtml(heading)}</h2>
${paragraph(text)}</section>
`;
}

/** The view of a read the Checks pages cannot use. `retryHref` is the page itself. */
export function checkProblemView(problem: CheckReadProblem, retryHref: string): CheckView {
  switch (problem.kind) {
    case "no-token":
      return { banner: "", body: errorSection("pulse-api is not available", NO_TOKEN_TEXT) };
    case "token-rejected":
      return { banner: tokenRejectedBanner(), body: "" };
    case "failed":
      return { banner: "", body: apiUnavailableState(problem.failure, retryHref) };
    case "old-api":
      return { banner: "", body: errorSection("pulse-api is too old", OLD_API_TEXT) };
    default: {
      const never: never = problem;
      return never;
    }
  }
}

const FILE_HEADINGS: Record<Exclude<AdminFileStatus["state"], "ok">, string> = {
  invalid: "checks.json is invalid",
  unreadable: "checks.json cannot be read",
  "written-not-applied": "checks.json was written but not applied",
};

/** R1: the banner of a file status other than `ok`. */
function fileBanner(file: AdminFileStatus): string {
  if (file.state === "ok") return "";
  return `<section class="state state-error" role="alert">
<h2>${escapeHtml(FILE_HEADINGS[file.state])}</h2>
${paragraph(file.message ?? undefined)}${paragraph(`The last valid version from ${utcTime(file.lastAppliedAt)} stays in use.`)}${paragraph("Console checks can still be changed.")}</section>
`;
}

/** List rows: the effective checks in api order, then the shadowed definitions. */
function rowsOf(config: AdminConfigResponse, states: ReadonlyMap<string, CheckState>): CheckRow[] {
  return [
    ...config.checks.map(
      (check): CheckRow => ({
        kind: "effective",
        check,
        state: states.get(check.id) ?? "unknown",
      }),
    ),
    ...config.shadowed.map((check): CheckRow => ({ kind: "shadowed", check })),
  ];
}

/** `?id=` with the encoded id, the only way an id enters a Console link. */
function idQuery(id: string): string {
  return `?id=${encodeURIComponent(id)}`;
}

function link(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

const UNADDRESSABLE: ReadonlySet<string> = new Set([".", ".."]);

function rowActions(row: CheckRow, role: ConsoleRole): string {
  const id = idQuery(row.check.id);
  const isShadowed = row.kind === "shadowed";
  const shadowedQuery = isShadowed ? "&shadowed=1" : "";
  const isAddressable = !UNADDRESSABLE.has(row.check.id);
  const isDatabase = row.check.source === "database";
  const actions = [link(isShadowed ? `/checks/shadowed${id}` : `/checks/check${id}`, "View")];
  if (isAllowed(role, "check.write") && isDatabase && !isShadowed && isAddressable) {
    actions.push(link(`/checks/edit${id}`, "Edit"));
  }
  if (isAllowed(role, "check.write")) {
    actions.push(link(`/checks/export${id}${shadowedQuery}`, "Export"));
  }
  if (isAllowed(role, "check.delete") && (isDatabase || isShadowed) && isAddressable) {
    actions.push(link(`/checks/delete${id}${shadowedQuery}`, "Delete"));
  }
  return actions.join(" ");
}

function lastResultAt(row: CheckRow, results: ReadonlyMap<string, number | null>): string {
  return row.kind === "shadowed" ? "" : utcTime(results.get(row.check.id) ?? null);
}

function rowHtml(
  row: CheckRow,
  role: ConsoleRole,
  results: ReadonlyMap<string, number | null>,
): string {
  const { check } = row;
  const source = check.source === "file" ? "checks.json (read-only)" : "Console";
  const state = row.kind === "shadowed" ? SHADOWED_TEXT : STATE_LABELS[row.state];
  const cells = [
    check.name,
    check.id,
    TYPE_LABELS[check.type ?? "http"],
    targetText(check),
    source,
    state,
    lastResultAt(row, results),
  ].map((text) => `<td>${escapeHtml(text)}</td>`);
  return `<tr>${cells.join("")}<td>${rowActions(row, role)}</td></tr>`;
}

function table(
  rows: readonly CheckRow[],
  role: ConsoleRole,
  results: ReadonlyMap<string, number | null>,
): string {
  const heads = ["Name", "Id", "Type", "Target", "Source", "State", "Last result", "Actions"]
    .map((head) => `<th scope="col">${head}</th>`)
    .join("");
  return `<div class="table-wrap table-scroll">
<table class="checks">
<thead><tr>${heads}</tr></thead>
<tbody>
${rows.map((row) => rowHtml(row, role, results)).join("\n")}
</tbody>
</table>
</div>
`;
}

function option(value: string, label: string, selected: string | undefined): string {
  const isSelected = value === selected ? " selected" : "";
  return `<option value="${escapeHtml(value)}"${isSelected}>${escapeHtml(label)}</option>`;
}

function select(
  name: string,
  label: string,
  entries: ReadonlyArray<[string, string]>,
  selected: string | undefined,
): string {
  const options = [option("", "Any", selected), ...entries.map(([v, l]) => option(v, l, selected))];
  return `<label for="filter-${name}">${escapeHtml(label)}
<select id="filter-${name}" name="${name}">${options.join("")}</select>
</label>`;
}

function filterForm(filters: CheckFilters): string {
  const q = filters.q === undefined ? "" : ` value="${escapeHtml(filters.q)}"`;
  return `<form class="filters" method="get" action="/checks" role="search">
<label for="filter-q">Search
<input id="filter-q" name="q" type="search" maxlength="200"${q}>
</label>
${select("type", "Type", Object.entries(TYPE_LABELS), filters.type)}
${select("state", "State", Object.entries(STATE_LABELS), filters.state)}
${select("source", "Source", Object.entries(SOURCE_LABELS), filters.source)}
<button type="submit">Filter</button>
<a href="/checks">Reset filters</a>
</form>
`;
}

function counts(config: AdminConfigResponse): string {
  const n = config.checks.length;
  const m = config.shadowed.length;
  const checks = `${n} ${n === 1 ? "check" : "checks"}`;
  const definitions = m === 1 ? "definition" : "definitions";
  const shadowed = m > 0 ? `, ${m} shadowed ${definitions}` : "";
  return paragraph(`${checks}${shadowed}`, ' class="counts"');
}

function memberLinks(role: ConsoleRole): string {
  if (!isAllowed(role, "check.write")) return "";
  return `<p class="actions">${link("/checks/new", "Add a check")} ${link("/checks/export", "Export as checks.json")}</p>
${paragraph(EXPORT_NOTE)}`;
}

function emptyInstallation(role: ConsoleRole): string {
  return isAllowed(role, "check.write")
    ? emptyState({
        title: "No checks yet",
        text: "pulse-api has no checks.",
        action: { href: "/checks/new", label: "Add a check" },
      })
    : `<section class="state state-empty">
<h2>No checks yet</h2>
${paragraph("A member can add checks.")}</section>
`;
}

function listBody(
  config: AdminConfigResponse,
  rows: readonly CheckRow[],
  parsed: ParsedCheckFilters,
  role: ConsoleRole,
  results: ReadonlyMap<string, number | null>,
): string {
  const notice = parsed.hasIgnoredValues ? paragraph(FILTERS_IGNORED_NOTICE, ' role="status"') : "";
  if (rows.length === 0) return `${memberLinks(role)}${notice}${emptyInstallation(role)}`;
  const matched = rows.filter((row) => isCheckRowMatched(row, parsed.filters));
  const content =
    matched.length === 0
      ? emptyState({
          title: "No checks match these filters",
          text: "Change the filters or show every check.",
          action: { href: "/checks", label: "Reset filters" },
        })
      : table(matched, role, results);
  return `${counts(config)}${memberLinks(role)}${filterForm(parsed.filters)}${notice}${content}`;
}

/** R1: the Checks list for one read, the parsed filters and the server's role of the user. */
export function checkListView(
  read: CheckListRead,
  parsed: ParsedCheckFilters,
  role: ConsoleRole,
): CheckView {
  if (read.kind !== "ok") return checkProblemView(read, "/checks");
  const states = new Map(read.checks.map((check) => [check.id, check.state]));
  const results = new Map(read.checks.map((check) => [check.id, check.lastResultAt]));
  const rows = rowsOf(read.config, states);
  return {
    banner: fileBanner(read.config.file),
    body: listBody(read.config, rows, parsed, role, results),
  };
}
