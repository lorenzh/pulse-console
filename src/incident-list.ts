import type { Incident, ManualIncident } from "@lorenzh/pulse-contract";

/** The automatic read covers 14 days. */
export const INCIDENT_WINDOW_MS = 1_209_600_000;
/** The `limit` of the automatic read; a full page may be truncated. */
export const AUTOMATIC_READ_LIMIT = 1000;
/** Most rows the list renders. */
export const MAX_INCIDENT_ROWS = 200;
/** pulse-api returns at most this many resolved manual incidents. */
const MANUAL_SAMPLE_MAX = 50;

/** Duration text of section 6: minutes rounded half up. */
export function durationText(ms: number): string {
  const m = Math.round(Math.max(0, ms) / 60000);
  if (m === 0) return "under 1 min";
  if (m < 60) return `${m} min`;
  if (m < 1440) {
    const rest = m % 60;
    return rest === 0 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 60)} h ${rest} min`;
  }
  const h = Math.floor(m / 60);
  const rest = h % 24;
  return rest === 0 ? `${Math.floor(h / 24)} d` : `${Math.floor(h / 24)} d ${rest} h`;
}

/** One MTTR statistic: its value text and its sample text. */
export type MttrStat = { label: string; value: string; sample: string };

const NO_SAMPLE = "No incident resolved in the last 14 days.";

function meanText(durations: readonly number[]): string {
  const sum = durations.reduce((a, b) => a + b, 0);
  return durationText(sum / durations.length);
}

/** Mean time to resolve of the manual read (pulse-api already chose the sample). */
export function manualMttr(items: readonly ManualIncident[]): MttrStat {
  const label = "Mean time to resolve, manual incidents";
  const durations: number[] = [];
  for (const item of items) {
    if (item.resolvedAt !== null) durations.push(Math.max(0, item.resolvedAt - item.createdAt));
  }
  if (durations.length === 0) return { label, value: "—", sample: NO_SAMPLE };
  const recent = durations.length === MANUAL_SAMPLE_MAX ? ", the 50 most recent" : "";
  return {
    label,
    value: meanText(durations),
    sample: `${durations.length} resolved in the last 14 days (pulse-api returns at most 50${recent})`,
  };
}

/** Mean time to resolve of the automatic read, never of a truncated page. */
export function automaticMttr(items: readonly Incident[], now: number): MttrStat {
  const label = "Mean time to resolve, automatic incidents";
  if (items.length >= AUTOMATIC_READ_LIMIT) {
    return {
      label,
      value: "—",
      sample: "Not computed: more than 1000 automatic incidents in 14 days.",
    };
  }
  const durations: number[] = [];
  for (const item of items) {
    if (item.resolvedAt !== null && item.resolvedAt >= now - INCIDENT_WINDOW_MS) {
      durations.push(Math.max(0, item.resolvedAt - item.openedAt));
    }
  }
  if (durations.length === 0) return { label, value: "—", sample: NO_SAMPLE };
  return {
    label,
    value: meanText(durations),
    sample: `${durations.length} resolved in the last 14 days`,
  };
}

export type IncidentKind = "manual" | "automatic";
export type IncidentStateFilter = "open" | "resolved" | "all";
export type IncidentKindFilter = IncidentKind | "all";
export type IncidentFilters = {
  state: IncidentStateFilter;
  kind: IncidentKindFilter;
  hasIgnored: boolean;
};

const STATES: readonly string[] = ["open", "resolved", "all"];
const KINDS: readonly string[] = ["manual", "automatic", "all"];

function filterValue(params: URLSearchParams, name: string, allowed: readonly string[]) {
  const values = params.getAll(name);
  if (values.length === 0) return { value: "all", isIgnored: false };
  const only = values[0];
  if (values.length > 1 || only === undefined || !allowed.includes(only)) {
    return { value: "all", isIgnored: true };
  }
  return { value: only, isIgnored: false };
}

/** Parses `state` and `kind`; a repeated, empty or unknown value counts as absent. */
export function parseIncidentFilters(query: string): IncidentFilters {
  const params = new URLSearchParams(query);
  const state = filterValue(params, "state", STATES);
  const kind = filterValue(params, "kind", KINDS);
  return {
    state: state.value as IncidentStateFilter,
    kind: kind.value as IncidentKindFilter,
    hasIgnored: state.isIgnored || kind.isIgnored,
  };
}

/** One list row, before rendering. */
export type IncidentRow = {
  kind: IncidentKind;
  id: number;
  start: number;
  resolvedAt: number | null;
  manual?: ManualIncident;
  automatic?: Incident;
};

/** All rows of both reads. */
export function incidentRows(
  manual: readonly ManualIncident[],
  automatic: readonly Incident[],
): IncidentRow[] {
  return [
    ...manual.map(
      (m): IncidentRow => ({
        kind: "manual",
        id: m.id,
        start: m.createdAt,
        resolvedAt: m.resolvedAt,
        manual: m,
      }),
    ),
    ...automatic.map(
      (a): IncidentRow => ({
        kind: "automatic",
        id: a.id,
        start: a.openedAt,
        resolvedAt: a.resolvedAt,
        automatic: a,
      }),
    ),
  ];
}

function isShown(row: IncidentRow, filters: IncidentFilters): boolean {
  if (filters.kind !== "all" && row.kind !== filters.kind) return false;
  if (filters.state === "open") return row.resolvedAt === null;
  if (filters.state === "resolved") return row.resolvedAt !== null;
  return true;
}

function sortKey(row: IncidentRow): number {
  return row.resolvedAt === null ? row.start : row.resolvedAt;
}

function compareRows(a: IncidentRow, b: IncidentRow): number {
  const aOpen = a.resolvedAt === null;
  const bOpen = b.resolvedAt === null;
  if (aOpen !== bOpen) return aOpen ? -1 : 1;
  const time = sortKey(b) - sortKey(a);
  if (time !== 0) return time;
  if (a.kind !== b.kind) return a.kind === "manual" ? -1 : 1;
  return b.id - a.id;
}

/** The filtered rows in list order, bounded to MAX_INCIDENT_ROWS, with the matching total. */
export function listedRows(
  rows: readonly IncidentRow[],
  filters: IncidentFilters,
): { rows: IncidentRow[]; total: number } {
  const matching = rows.filter((r) => isShown(r, filters)).sort(compareRows);
  return { rows: matching.slice(0, MAX_INCIDENT_ROWS), total: matching.length };
}
