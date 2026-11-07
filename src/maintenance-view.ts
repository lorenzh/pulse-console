import type { AdminMaintenanceList, AdminMaintenanceWindow } from "@lorenzh/pulse-contract";
import { isAllowed } from "./permissions.ts";
import type { ConsoleRole } from "./roles.ts";

export const MAX_PAST_ROWS = 50;
export const SHADOWED_TEXT =
  "The checks file defines a window with this id; the file window stays in force.";

export type MaintenanceAction = "edit" | "delete" | "delete-copy";
export type SectionKey = "current" | "planned" | "past" | "shadowed";

export type MaintenanceRow = {
  identity: string;
  /** The database id, used in action links; undefined for a file window. */
  id: string | undefined;
  source: string;
  checks: string[];
  start: number;
  end: number;
  note: string;
  actions: MaintenanceAction[];
  isShadowed: boolean;
};

export type MaintenanceSection = {
  key: SectionKey;
  title: string;
  total: number;
  rows: MaintenanceRow[];
  /** `Showing 50 of <n> past windows.` when the past section is cut. */
  limitText: string | undefined;
};

const TITLES: Readonly<Record<SectionKey, string>> = {
  current: "Current",
  planned: "Planned",
  past: "Past",
  shadowed: "Shadowed by the checks file",
};

function tieOrder(a: AdminMaintenanceWindow, b: AdminMaintenanceWindow): number {
  if (a.source !== b.source) return a.source === "file" ? -1 : 1;
  if (a.source === "file") return (a.index ?? 0) - (b.index ?? 0);
  const left = a.id ?? "";
  const right = b.id ?? "";
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sorted(
  windows: readonly AdminMaintenanceWindow[],
  key: (w: AdminMaintenanceWindow) => number,
  direction: 1 | -1,
): AdminMaintenanceWindow[] {
  return [...windows].sort((a, b) => (key(a) - key(b)) * direction || tieOrder(a, b));
}

/** A check id as listed: its name, or a note that it does not apply now. */
export function checkLabel(id: string, names: ReadonlyMap<string, string>): string {
  const name = names.get(id);
  return name === undefined ? `${id} (not configured; does not apply now)` : name;
}

function actionsOf(
  window: AdminMaintenanceWindow,
  isShadowed: boolean,
  role: ConsoleRole,
): MaintenanceAction[] {
  if (window.source === "file") return [];
  if (isShadowed) return isAllowed(role, "maintenance.delete") ? ["delete-copy"] : [];
  const actions: MaintenanceAction[] = [];
  if (isAllowed(role, "maintenance.edit")) actions.push("edit");
  if (isAllowed(role, "maintenance.delete")) actions.push("delete");
  return actions;
}

function rowOf(
  window: AdminMaintenanceWindow,
  isShadowed: boolean,
  names: ReadonlyMap<string, string>,
  role: ConsoleRole,
): MaintenanceRow {
  const isFile = window.source === "file";
  return {
    identity: window.id ?? `File window #${window.index ?? 0}`,
    id: isFile ? undefined : (window.id ?? undefined),
    source: isFile ? "From the checks file, read-only" : "Database",
    checks: window.checkIds.map((id) => checkLabel(id, names)),
    start: window.start,
    end: window.end,
    note: window.note,
    actions: actionsOf(window, isShadowed, role),
    isShadowed,
  };
}

/** The four sections of the Maintenance list, by the api's phase, in their display order. */
export function maintenanceSections(
  list: AdminMaintenanceList,
  names: ReadonlyMap<string, string>,
  role: ConsoleRole,
): MaintenanceSection[] {
  const of = (phase: AdminMaintenanceWindow["phase"]): AdminMaintenanceWindow[] =>
    list.windows.filter((w) => w.phase === phase);
  const past = sorted(of("past"), (w) => w.end, -1);
  const groups: [SectionKey, AdminMaintenanceWindow[], boolean][] = [
    ["current", sorted(of("current"), (w) => w.end, 1), false],
    ["planned", sorted(of("planned"), (w) => w.start, 1), false],
    ["past", past.slice(0, MAX_PAST_ROWS), false],
    ["shadowed", [...list.shadowed], true],
  ];
  return groups.map(([key, windows, isShadowed]) => ({
    key,
    title: TITLES[key],
    total: key === "past" ? past.length : windows.length,
    rows: windows.map((w) => rowOf(w, isShadowed, names, role)),
    limitText:
      key === "past" && past.length > MAX_PAST_ROWS
        ? `Showing ${MAX_PAST_ROWS} of ${past.length} past windows.`
        : undefined,
  }));
}

/** Where an id stands in the list: an editable database row, a shadowed or file row, or gone. */
export type WindowPlace =
  | { kind: "database"; window: AdminMaintenanceWindow }
  | { kind: "shadowed"; window: AdminMaintenanceWindow }
  | { kind: "file" }
  | { kind: "missing" };

export function windowPlace(list: AdminMaintenanceList, id: string): WindowPlace {
  const database = list.windows.find((w) => w.source === "database" && w.id === id);
  if (database !== undefined) return { kind: "database", window: database };
  const shadowed = list.shadowed.find((w) => w.id === id);
  if (shadowed !== undefined) return { kind: "shadowed", window: shadowed };
  if (list.windows.some((w) => w.source === "file" && w.id === id)) return { kind: "file" };
  return { kind: "missing" };
}
