import type { AdminCheckView, CheckState } from "@lorenzh/pulse-contract";
import { targetText } from "./check-format.ts";

export const CHECK_TYPES = ["http", "tls", "tcp", "dns", "domain", "heartbeat"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];
export const CHECK_STATES = ["up", "degraded", "down", "unknown", "maintenance"] as const;
export const CHECK_SOURCE_FILTERS = ["file", "database", "shadowed"] as const;
export type CheckSourceFilter = (typeof CHECK_SOURCE_FILTERS)[number];

/** Longest `q` after `trim()`; a longer one is ignored. */
export const MAX_QUERY_LENGTH = 200;
export const FILTERS_IGNORED_NOTICE = "Some filter values were not understood and were ignored.";

export type CheckFilters = {
  q?: string;
  type?: CheckType;
  state?: CheckState;
  source?: CheckSourceFilter;
};

export type ParsedCheckFilters = { filters: CheckFilters; hasIgnoredValues: boolean };

/** One list row: an effective check with its state, or a shadowed database definition. */
export type CheckRow =
  | { kind: "effective"; check: AdminCheckView; state: CheckState }
  | { kind: "shadowed"; check: AdminCheckView };

type Single = { kind: "absent" } | { kind: "ignored" } | { kind: "value"; value: string };

function single(query: URLSearchParams, name: string): Single {
  const values = query.getAll(name);
  if (values.length === 0) return { kind: "absent" };
  const [value] = values;
  if (values.length > 1 || value === undefined || value === "") return { kind: "ignored" };
  return { kind: "value", value };
}

function oneOf<T extends string>(allowed: readonly T[], value: string): T | undefined {
  return allowed.find((entry) => entry === value);
}

/**
 * The filters of the list query. A parameter that is repeated, empty or outside its set (and a
 * `q` over 200 characters) counts as absent and sets `hasIgnoredValues`.
 */
export function parseCheckFilters(query: URLSearchParams): ParsedCheckFilters {
  const filters: CheckFilters = {};
  let hasIgnoredValues = false;
  const pick = <T extends string>(
    name: string,
    parse: (value: string) => T | undefined,
  ): T | undefined => {
    const found = single(query, name);
    if (found.kind === "absent") return undefined;
    const value = found.kind === "value" ? parse(found.value) : undefined;
    if (value === undefined) hasIgnoredValues = true;
    return value;
  };
  const q = pick("q", (value) => {
    const trimmed = value.trim();
    return trimmed !== "" && trimmed.length <= MAX_QUERY_LENGTH ? trimmed : undefined;
  });
  const type = pick("type", (value) => oneOf(CHECK_TYPES, value));
  const state = pick("state", (value) => oneOf(CHECK_STATES, value));
  const source = pick("source", (value) => oneOf(CHECK_SOURCE_FILTERS, value));
  if (q !== undefined) filters.q = q;
  if (type !== undefined) filters.type = type;
  if (state !== undefined) filters.state = state;
  if (source !== undefined) filters.source = source;
  return { filters, hasIgnoredValues };
}

function rowSource(row: CheckRow): CheckSourceFilter {
  return row.kind === "shadowed" ? "shadowed" : row.check.source;
}

function matchesQuery(check: AdminCheckView, q: string): boolean {
  const needle = q.toLowerCase();
  return [check.id, check.name, targetText(check)].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

/** Whether a row passes every set filter (AND). `state` never matches a shadowed row. */
export function isCheckRowMatched(row: CheckRow, filters: CheckFilters): boolean {
  if (filters.q !== undefined && !matchesQuery(row.check, filters.q)) return false;
  if (filters.type !== undefined && (row.check.type ?? "http") !== filters.type) return false;
  if (filters.state !== undefined && (row.kind === "shadowed" || row.state !== filters.state)) {
    return false;
  }
  return filters.source === undefined || rowSource(row) === filters.source;
}

/** The filters as a query string for links, without a leading `?`; empty when none is set. */
export function checkFiltersQuery(filters: CheckFilters): string {
  const query = new URLSearchParams();
  for (const name of ["q", "type", "state", "source"] as const) {
    const value = filters[name];
    if (value !== undefined) query.set(name, value);
  }
  return query.toString();
}
