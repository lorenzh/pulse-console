import {
  type ChecksResponse,
  type FetchJsonOptions,
  type FetchJsonResult,
  fetchJson,
  validateAdminConfigSummary,
  validateChecksResponse,
  WIRE_VERSION_HEADER,
} from "@lorenzh/pulse-contract";
import { type ApiCall, type ApiFailure, apiFailureOf } from "./api-failure.ts";

type FetchLike = FetchJsonOptions<unknown>["fetch"];

export type OverviewReadDeps = {
  fetch: FetchLike;
  /** The admin token from the settings; `undefined` when none is configured. */
  token: string | undefined;
  /** Timer injection, passed to `fetchJson`. Defaults to `setTimeout`. */
  schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
  /** Logs one `api read failed` line per failed read. */
  warn: (message: string, fields: Record<string, unknown>) => void;
};

/** What the Overview shows: no token, a rejected token, a failure, or the checks. */
export type OverviewRead =
  | { kind: "no-token" }
  | { kind: "token-rejected" }
  | { kind: "failed"; failure: ApiFailure }
  | { kind: "ok"; checks: ChecksResponse };

const TIMEOUT_MS = 5000;

type ReadOutcome<T> = { result: FetchJsonResult<T>; wire: string | null };

async function read<T>(
  url: string,
  validate: FetchJsonOptions<T>["validate"],
  deps: OverviewReadDeps,
  authorization: string | undefined,
): Promise<ReadOutcome<T>> {
  // Each read keeps its own header, because the two reads run at the same time.
  let wire: string | null = null;
  const manualFetch: FetchLike = async (input, init) => {
    const response = await deps.fetch(input, { ...init, redirect: "manual" });
    wire = response.headers.get(WIRE_VERSION_HEADER);
    return response;
  };
  const options: FetchJsonOptions<T> = { fetch: manualFetch, validate, timeoutMs: TIMEOUT_MS };
  if (authorization !== undefined) {
    options.headers = { authorization };
  }
  if (deps.schedule !== undefined) {
    options.schedule = deps.schedule;
  }
  const result = await fetchJson(url, options);
  return { result, wire };
}

function failureOf<T>(
  call: ApiCall,
  outcome: ReadOutcome<T>,
  origin: string,
  deps: OverviewReadDeps,
): ApiFailure | undefined {
  const { result } = outcome;
  if (result.ok) {
    return undefined;
  }
  const fields: Record<string, unknown> = { call, kind: result.error.kind };
  if (result.error.kind === "http") {
    fields.status = result.error.status;
  }
  deps.warn("api read failed", fields);
  return apiFailureOf(result.error, { call, origin, wireHeader: outcome.wire });
}

function isWireAbsent<T>(call: ApiCall, outcome: ReadOutcome<T>, deps: OverviewReadDeps): boolean {
  if (outcome.result.ok && outcome.result.wire === "absent") {
    deps.warn("api read failed", { call, kind: "missing-header" });
    return true;
  }
  return false;
}

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
    read(
      `${apiUrl}/admin/config`,
      (raw) => validateAdminConfigSummary(raw),
      deps,
      `Bearer ${deps.token}`,
    ),
    read(`${apiUrl}/checks`, (raw) => validateChecksResponse(raw), deps, undefined),
  ]);
  const configFailure = failureOf("config", config, origin, deps);
  const checksFailure = failureOf("checks", checks, origin, deps);
  if (configFailure?.kind === "http" && configFailure.status === 401) {
    return { kind: "token-rejected" };
  }
  const failure = configFailure ?? checksFailure;
  if (failure !== undefined) {
    return { kind: "failed", failure };
  }
  const isConfigAbsent = isWireAbsent("config", config, deps);
  const isChecksAbsent = isWireAbsent("checks", checks, deps);
  if (isConfigAbsent || isChecksAbsent || !checks.result.ok) {
    return { kind: "failed", failure: { kind: "missing-header" } };
  }
  return { kind: "ok", checks: checks.result.value };
}
