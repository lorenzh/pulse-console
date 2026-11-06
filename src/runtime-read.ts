import {
  type AdminStatusSettingsView,
  type FetchJsonResult,
  validateAdminStatusSettingsView,
} from "@lorenzh/pulse-contract";
import type { ApiCall, ApiFailure } from "./api-failure.ts";
import { type ApiReadDeps, isReadWireAbsent, readApi, readFailureOf } from "./api-read.ts";

/** R3: the text of the runtime pages for a pulse-api without the admin settings routes. */
export const RUNTIME_OLD_API_TEXT =
  "This pulse-api is too old for this page. It needs the status and notify settings routes (pulse-api with #570).";

/** A runtime read that the page cannot use, or nothing configured to read with. */
export type RuntimeReadProblem =
  | { kind: "no-token" }
  | { kind: "token-rejected" }
  | { kind: "old-api" }
  | { kind: "failed"; failure: ApiFailure };

export type StatusSettingsRead = RuntimeReadProblem | { kind: "ok"; view: AdminStatusSettingsView };

function problemOf<T>(
  call: ApiCall,
  outcome: { result: FetchJsonResult<T>; wire: string | null },
  apiUrl: string,
  deps: ApiReadDeps,
): RuntimeReadProblem | undefined {
  const failure = readFailureOf(call, outcome, new URL(apiUrl).origin, deps);
  if (failure?.kind === "http" && failure.status === 401) return { kind: "token-rejected" };
  if (failure?.kind === "http" && failure.status === 404) return { kind: "old-api" };
  if (failure !== undefined) return { kind: "failed", failure };
  if (isReadWireAbsent(call, outcome, deps)) {
    return { kind: "failed", failure: { kind: "missing-header" } };
  }
  return undefined;
}

/**
 * R2: `GET /admin/status/settings` with the admin token, one 5000 ms request without a followed
 * redirect, bounded by the contract's default read limit (5 MiB). A `404` is an older api.
 */
export async function readStatusSettings(
  apiUrl: string,
  deps: ApiReadDeps,
): Promise<StatusSettingsRead> {
  if (deps.token === undefined) return { kind: "no-token" };
  const outcome = await readApi(
    `${apiUrl}/admin/status/settings`,
    (raw) => validateAdminStatusSettingsView(raw),
    deps,
    `Bearer ${deps.token}`,
  );
  const problem = problemOf("status-settings", outcome, apiUrl, deps);
  if (problem !== undefined) return problem;
  if (!outcome.result.ok) return { kind: "failed", failure: { kind: "invalid" } };
  return { kind: "ok", view: outcome.result.value };
}
