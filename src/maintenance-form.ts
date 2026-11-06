import {
  type AdminMaintenanceWindowInput,
  MAX_MAINTENANCE_CHECKS,
  validateAdminMaintenanceWindowInput,
} from "@lorenzh/pulse-contract";

/** Field errors by field name. */
export type MaintenanceErrors = Partial<
  Record<"id" | "check" | "component" | "start" | "end" | "note", string>
>;

/** The posted maintenance input, kept as typed. */
export type MaintenanceInput = {
  id: string;
  checks: readonly string[];
  components: readonly string[];
  start: string;
  end: string;
  note: string;
};

/** A component as the form needs it: its id and member checks in component order. */
export type ComponentMembers = { id: string; checkIds: readonly string[] };

/** The stored epochs of the edited database window. */
export type StoredTimes = { start: number; end: number };

export type MaintenanceResult =
  | { ok: true; body: AdminMaintenanceWindowInput }
  | { ok: false; errors: MaintenanceErrors };

const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const TIME_ERROR = "Enter a date and time as YYYY-MM-DDTHH:MM, read as UTC.";
export const SPAN_ERROR = "End must be after start.";

/** Epoch ms of a `datetime-local` text read as UTC, or undefined when it does not round-trip. */
export function parseUtcTime(text: string): number | undefined {
  const match = TIME.exec(text);
  if (match === null) return undefined;
  const [y, mo, d, h, mi, s] = match.slice(1).map((part) => Number(part ?? "0"));
  if (y === undefined || mo === undefined || d === undefined) return undefined;
  if (h === undefined || mi === undefined || s === undefined) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, 0);
  const isRoundTrip =
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === s;
  return isRoundTrip ? date.getTime() : undefined;
}

/** The edit prefill: `YYYY-MM-DDTHH:MM:SS` in UTC, milliseconds dropped. */
export function utcInputValue(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 19);
}

/** The stored epoch when the posted second equals the stored second, else the parsed one. */
export function keptTime(parsed: number, stored: number | undefined): number {
  if (stored === undefined) return parsed;
  return parsed === stored - (stored % 1000) ? stored : parsed;
}

/** Posted checks in order, then each component's checks in component order, without repeats. */
export function selectedCheckIds(
  checks: readonly string[],
  components: readonly string[],
  known: readonly ComponentMembers[],
): { ok: true; checkIds: string[] } | { ok: false; missing: string } {
  const ids = [...checks];
  for (const componentId of components) {
    const component = known.find((c) => c.id === componentId);
    if (component === undefined) return { ok: false, missing: componentId };
    for (const id of component.checkIds) if (!ids.includes(id)) ids.push(id);
  }
  return { ok: true, checkIds: ids };
}

function contractErrors(error: string): MaintenanceErrors {
  const colon = error.indexOf(": ");
  const path = colon < 0 ? "" : error.slice(0, colon);
  const text = colon < 0 ? error : error.slice(colon + 2);
  const field = (path.split(".")[1] ?? "").split("[")[0] ?? "";
  if (field === "id" || field === "note") return { [field]: text };
  if (field === "start" || field === "end") return { [field]: text };
  if (field === "checkIds") return { check: text };
  return { note: error };
}

function timesOf(
  input: MaintenanceInput,
  stored: StoredTimes | undefined,
): { ok: true; start: number; end: number } | { ok: false; errors: MaintenanceErrors } {
  const start = parseUtcTime(input.start);
  const end = parseUtcTime(input.end);
  const errors: MaintenanceErrors = {};
  if (start === undefined) errors.start = TIME_ERROR;
  if (end === undefined) errors.end = TIME_ERROR;
  if (start === undefined || end === undefined) return { ok: false, errors };
  return { ok: true, start: keptTime(start, stored?.start), end: keptTime(end, stored?.end) };
}

/**
 * Builds and validates a database window. `stored` holds the edited window's epochs from the
 * POST's own `GET /admin/maintenance` read; it is undefined for a create.
 */
export function maintenanceBody(
  input: MaintenanceInput,
  known: readonly ComponentMembers[],
  stored: StoredTimes | undefined,
): MaintenanceResult {
  const selection = selectedCheckIds(input.checks, input.components, known);
  if (!selection.ok) {
    return {
      ok: false,
      errors: { component: `Component ${selection.missing} is not configured any more.` },
    };
  }
  const count = selection.checkIds.length;
  if (count === 0 || count > MAX_MAINTENANCE_CHECKS) {
    return {
      ok: false,
      errors: {
        check: `Select 1 to ${MAX_MAINTENANCE_CHECKS} checks; this selection has ${count}.`,
      },
    };
  }
  const times = timesOf(input, stored);
  if (!times.ok) return times;
  if (times.end <= times.start) {
    return { ok: false, errors: { end: SPAN_ERROR } };
  }
  const body = {
    id: input.id,
    checkIds: selection.checkIds,
    start: times.start,
    end: times.end,
    note: input.note,
  };
  const verdict = validateAdminMaintenanceWindowInput(body);
  return verdict.ok
    ? { ok: true, body: verdict.value }
    : { ok: false, errors: contractErrors(verdict.error) };
}
