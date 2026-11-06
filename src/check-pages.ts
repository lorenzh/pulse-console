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
import { apiUnavailableState, callout, emptyState, tokenRejectedBanner } from "./states.ts";

/** A Checks page body and the banner for the shell slot (empty when none). */
export type CheckView = { banner: string; body: string };

/** The shadowed-row text of the list and the shadowed page. */
export const SHADOWED_TEXT = "Shadowed by checks.json";

export const STATE_LABELS: Record<CheckState, string> = {
  up: "Up",
  degraded: "Degraded",
  down: "Down",
  unknown: "Unknown",
  maintenance: "Maintenance",
};

export const TYPE_LABELS: Record<(typeof CHECK_TYPES)[number], string> = {
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
  return callout({ kind: "error", title: heading, body: paragraph(text), role: "alert" });
}

/** R7: a check state with its dot and the unchanged label; `dense` is the table form. */
export function checkStateHtml(state: CheckState | "shadowed", isDense: boolean): string {
  const label = state === "shadowed" ? SHADOWED_TEXT : STATE_LABELS[state];
  const dense = isDense ? " dense" : "";
  return `<span class="check-state check-state-${state}${dense}"><span class="dot" aria-hidden="true"></span><span>${escapeHtml(label)}</span></span>`;
}

/** R7: a tag of one kind around unchanged text. */
export function tagHtml(kind: "neutral" | "info" | "error", text: string): string {
  return `<span class="tag tag-${kind}">${escapeHtml(text)}</span>`;
}

/** R7: the source tag of a check: checks.json neutral, Console info. */
export function sourceTag(source: "file" | "database"): string {
  return source === "file"
    ? tagHtml("neutral", "checks.json (read-only)")
    : tagHtml("info", "Console");
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
  const lastValid = `<p>The last valid version from <span class="mono">${escapeHtml(utcTime(file.lastAppliedAt))}</span> stays in use.</p>`;
  return callout({
    kind: "info",
    title: FILE_HEADINGS[file.state],
    body: `${paragraph(file.message ?? undefined)}${lastValid}${paragraph("Console checks can still be changed.")}`,
    role: "alert",
  });
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
export function idQuery(id: string): string {
  return `?id=${encodeURIComponent(id)}`;
}

export function link(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

export const UNADDRESSABLE: ReadonlySet<string> = new Set([".", ".."]);

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
  const state = row.kind === "shadowed" ? "shadowed" : row.state;
  const cells = [
    `<td>${escapeHtml(check.name)}</td>`,
    `<td class="mono">${escapeHtml(check.id)}</td>`,
    `<td>${escapeHtml(TYPE_LABELS[check.type ?? "http"])}</td>`,
    `<td>${escapeHtml(targetText(check))}</td>`,
    `<td>${sourceTag(check.source)}</td>`,
    `<td>${checkStateHtml(state, true)}</td>`,
    `<td class="mono">${escapeHtml(lastResultAt(row, results))}</td>`,
  ];
  return `<tr>${cells.join("")}<td class="actions-cell">${rowActions(row, role)}</td></tr>`;
}

function table(
  rows: readonly CheckRow[],
  role: ConsoleRole,
  results: ReadonlyMap<string, number | null>,
): string {
  const heads = ["Name", "Id", "Type", "Target", "Source", "State", "Last result", "Actions"]
    .map((head) => `<th scope="col">${head}</th>`)
    .join("");
  return `<p class="table-scroll-hint">Scroll sideways to see all columns.</p>
<div class="table-scroll" tabindex="0" role="region" aria-label="Checks table">
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
  return paragraph(`${checks}${shadowed}`, ' class="counts mono"');
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
    : emptyState({ title: "No checks yet", text: "A member can add checks." });
}

function listBody(
  config: AdminConfigResponse,
  rows: readonly CheckRow[],
  parsed: ParsedCheckFilters,
  role: ConsoleRole,
  results: ReadonlyMap<string, number | null>,
): string {
  const notice = parsed.hasIgnoredValues
    ? callout({ kind: "info", body: paragraph(FILTERS_IGNORED_NOTICE), role: "status" })
    : "";
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
