import {
  type ChecksResponse,
  validateAdminConfigSummary,
  validateChecksResponse,
} from "@lorenzh/pulse-contract";
import type { ApiFailure } from "./api-failure.ts";
import { type ApiReadDeps, isReadWireAbsent, readApi, readFailureOf } from "./api-read.ts";

export type OverviewReadDeps = ApiReadDeps;

/** What the Overview shows: no token, a rejected token, a failure, or the checks. */
export type OverviewRead =
  | { kind: "no-token" }
  | { kind: "token-rejected" }
  | { kind: "failed"; failure: ApiFailure }
  | { kind: "ok"; checks: ChecksResponse };

/**
 * Reads `GET /admin/config` (with the token) and `GET /checks` (without it) at the same time.
 * `apiUrl` is the saved instance URL without a trailing `/`. Precedence: no token, config
 * failure, checks failure, a missing wire header on either, success.
 */
export async function readOverview(apiUrl: string, deps: OverviewReadDeps): Promise<OverviewRead> {
  if (deps.token === undefined) {
    return { kind: "no-token" };
  }
  const origin = new URL(apiUrl).origin;
  const [config, checks] = await Promise.all([
    readApi(
      `${apiUrl}/admin/config`,
      (raw) => validateAdminConfigSummary(raw),
      deps,
      `Bearer ${deps.token}`,
    ),
    readApi(`${apiUrl}/checks`, (raw) => validateChecksResponse(raw), deps, undefined),
  ]);
  const configFailure = readFailureOf("config", config, origin, deps);
  const checksFailure = readFailureOf("checks", checks, origin, deps);
  // Log every failed read before any return, so each failure gets its one warning.
  const isConfigAbsent = isReadWireAbsent("config", config, deps);
  const isChecksAbsent = isReadWireAbsent("checks", checks, deps);
  if (configFailure?.kind === "http" && configFailure.status === 401) {
    return { kind: "token-rejected" };
  }
  const failure = configFailure ?? checksFailure;
  if (failure !== undefined) {
    return { kind: "failed", failure };
  }
  if (isConfigAbsent || isChecksAbsent || !checks.result.ok) {
    return { kind: "failed", failure: { kind: "missing-header" } };
  }
  return { kind: "ok", checks: checks.result.value };
}
