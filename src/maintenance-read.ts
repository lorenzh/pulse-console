import {
  type AdminConfigResponse,
  type AdminMaintenanceList,
  validateAdminMaintenanceList,
} from "@lorenzh/pulse-contract";
import {
  type ApiReadDeps,
  isReadWireAbsent,
  type ReadOutcome,
  readApi,
  readFailureOf,
} from "./api-read.ts";
import { type CheckReadProblem, readCheckConfig } from "./check-read.ts";

export const OLD_MAINTENANCE_API_TEXT =
  "This pulse-api is too old for the Maintenance page. It needs database maintenance windows (pulse-api with #765).";

/** A failed maintenance read, or an api without database windows (404 or 405). */
export type MaintenanceReadProblem = CheckReadProblem | { kind: "old-maintenance" };

export type MaintenanceListRead =
  | MaintenanceReadProblem
  | { kind: "ok"; list: AdminMaintenanceList };

/** Both reads of the list, form and edit POST; `isCoherent` when their revisions agree. */
export type MaintenanceBothRead =
  | MaintenanceReadProblem
  | {
      kind: "ok";
      list: AdminMaintenanceList;
      config: AdminConfigResponse;
      isCoherent: boolean;
    };

function problemOf(
  outcome: ReadOutcome<AdminMaintenanceList>,
  origin: string,
  deps: ApiReadDeps,
): MaintenanceReadProblem | undefined {
  const failure = readFailureOf("maintenance", outcome, origin, deps);
  if (failure?.kind === "http") {
    if (failure.status === 404 || failure.status === 405) return { kind: "old-maintenance" };
    if (failure.status === 401) return { kind: "token-rejected" };
  }
  if (failure !== undefined) return { kind: "failed", failure };
  if (isReadWireAbsent("maintenance", outcome, deps)) {
    return { kind: "failed", failure: { kind: "missing-header" } };
  }
  return undefined;
}

/** `GET /admin/maintenance` with the admin token. */
export async function readMaintenance(
  apiUrl: string,
  deps: ApiReadDeps,
): Promise<MaintenanceListRead> {
  if (deps.token === undefined) return { kind: "no-token" };
  const outcome = await readApi(
    `${apiUrl}/admin/maintenance`,
    (raw) => validateAdminMaintenanceList(raw),
    deps,
    `Bearer ${deps.token}`,
  );
  const problem = problemOf(outcome, new URL(apiUrl).origin, deps);
  if (problem !== undefined) return problem;
  if (!outcome.result.ok) return { kind: "failed", failure: { kind: "invalid" } };
  return { kind: "ok", list: outcome.result.value };
}

/** `GET /admin/maintenance`, then `GET /admin/config`; a failed first read stops before the second. */
export async function readMaintenanceAndConfig(
  apiUrl: string,
  deps: ApiReadDeps,
): Promise<MaintenanceBothRead> {
  const list = await readMaintenance(apiUrl, deps);
  if (list.kind !== "ok") return list;
  const config = await readCheckConfig(apiUrl, deps);
  if (config.kind !== "ok") return config;
  return {
    kind: "ok",
    list: list.list,
    config: config.config,
    isCoherent: list.list.revision === config.config.revision,
  };
}

/** Section 13 GET: both reads, and both once more when their revisions differ (at most 4). */
export async function readMaintenanceForm(
  apiUrl: string,
  deps: ApiReadDeps,
): Promise<MaintenanceBothRead> {
  const first = await readMaintenanceAndConfig(apiUrl, deps);
  if (first.kind !== "ok" || first.isCoherent) return first;
  return readMaintenanceAndConfig(apiUrl, deps);
}
