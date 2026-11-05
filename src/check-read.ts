import {
  type AdminCheckView,
  type AdminConfigExport,
  type AdminConfigResponse,
  type CheckLatency,
  type CheckLocationUptime,
  type ChecksResponse,
  type CheckWithState,
  type ResultsResponse,
  type UptimeResponse,
  type Validation,
  validateAdminConfigExport,
  validateAdminConfigResponse,
  validateAdminConfigSummary,
  validateCheckLatency,
  validateCheckLocationUptime,
  validateChecksResponse,
  validateResultsResponse,
  validateUptimeResponse,
} from "@lorenzh/pulse-contract";
import type { ApiCall, ApiFailure } from "./api-failure.ts";
import { apiIdSegment } from "./api-path.ts";
import {
  type ApiReadDeps,
  isReadWireAbsent,
  type ReadOutcome,
  readApi,
  readFailureOf,
} from "./api-read.ts";

/** Decision 11: the text of the Checks pages for an api without check sources. */
export const OLD_API_TEXT =
  "This pulse-api is too old for the Checks pages. It needs check sources (pulse-api with #565).";

/** A read that the Checks pages cannot use, or nothing configured to read with. */
export type CheckReadProblem =
  | { kind: "no-token" }
  | { kind: "token-rejected" }
  | { kind: "failed"; failure: ApiFailure }
  | { kind: "old-api" };

export type CheckListRead =
  | CheckReadProblem
  | { kind: "ok"; config: AdminConfigResponse; checks: ChecksResponse };

export type CheckConfigRead = CheckReadProblem | { kind: "ok"; config: AdminConfigResponse };

export type CheckExportRead = CheckReadProblem | { kind: "ok"; document: AdminConfigExport };

type ConfigShape = { kind: "full"; config: AdminConfigResponse } | { kind: "old" };

// A summary-valid answer without sources is an old api, not an invalid one (Decision 11).
function validateConfig(raw: unknown): Validation<ConfigShape> {
  const full = validateAdminConfigResponse(raw);
  if (full.ok) return { ok: true, value: { kind: "full", config: full.value } };
  return validateAdminConfigSummary(raw).ok
    ? { ok: true, value: { kind: "old" } }
    : { ok: false, error: full.error };
}

function readConfig(apiUrl: string, deps: ApiReadDeps, token: string) {
  return readApi(`${apiUrl}/admin/config`, validateConfig, deps, `Bearer ${token}`);
}

/**
 * The problem of a set of reads, after every failure has logged its one warning. A `401` on the
 * token read wins, then the first failure, then a missing wire header.
 */
function problemOf(
  outcomes: ReadonlyArray<[call: ApiCall, ReadOutcome<unknown>]>,
  origin: string,
  deps: ApiReadDeps,
): CheckReadProblem | undefined {
  const failures = outcomes.map(([call, outcome]) => readFailureOf(call, outcome, origin, deps));
  const absent = outcomes.map(([call, outcome]) => isReadWireAbsent(call, outcome, deps));
  const [first] = failures;
  if (first?.kind === "http" && first.status === 401) return { kind: "token-rejected" };
  const failure = failures.find((entry) => entry !== undefined);
  if (failure !== undefined) return { kind: "failed", failure };
  if (absent.includes(true)) return { kind: "failed", failure: { kind: "missing-header" } };
  return undefined;
}

/** R1: `GET /admin/config` with the token and `GET /checks` without it, at the same time. */
export async function readCheckList(apiUrl: string, deps: ApiReadDeps): Promise<CheckListRead> {
  if (deps.token === undefined) return { kind: "no-token" };
  const [config, checks] = await Promise.all([
    readConfig(apiUrl, deps, deps.token),
    readApi(`${apiUrl}/checks`, (raw) => validateChecksResponse(raw), deps, undefined),
  ]);
  const problem = problemOf(
    [
      ["config", config],
      ["checks", checks],
    ],
    new URL(apiUrl).origin,
    deps,
  );
  if (problem !== undefined) return problem;
  if (!config.result.ok || !checks.result.ok) {
    return { kind: "failed", failure: { kind: "invalid" } };
  }
  if (config.result.value.kind === "old") return { kind: "old-api" };
  return { kind: "ok", config: config.result.value.config, checks: checks.result.value };
}

/** `GET /admin/config` alone, for the shadowed export. */
export async function readCheckConfig(apiUrl: string, deps: ApiReadDeps): Promise<CheckConfigRead> {
  if (deps.token === undefined) return { kind: "no-token" };
  const config = await readConfig(apiUrl, deps, deps.token);
  const problem = problemOf([["config", config]], new URL(apiUrl).origin, deps);
  if (problem !== undefined) return problem;
  if (!config.result.ok) return { kind: "failed", failure: { kind: "invalid" } };
  if (config.result.value.kind === "old") return { kind: "old-api" };
  return { kind: "ok", config: config.result.value.config };
}

/** R7: `GET /admin/config/export` with the token, validated as an export document. */
export async function readCheckExport(apiUrl: string, deps: ApiReadDeps): Promise<CheckExportRead> {
  if (deps.token === undefined) return { kind: "no-token" };
  const read = await readApi(
    `${apiUrl}/admin/config/export`,
    (raw) => validateAdminConfigExport(raw),
    deps,
    `Bearer ${deps.token}`,
  );
  const problem = problemOf([["export", read]], new URL(apiUrl).origin, deps);
  if (problem !== undefined) return problem;
  if (!read.result.ok) return { kind: "failed", failure: { kind: "invalid" } };
  return { kind: "ok", document: read.result.value };
}

/** One round-2 panel of the detail page (R2). Each fails on its own. */
export type PanelRead<T> =
  | { kind: "ok"; value: T }
  | { kind: "failed"; failure: ApiFailure }
  /** Decision 14: the id `.` or `..` cannot be put in an api path. */
  | { kind: "unaddressable" }
  /** Decision 11: the api has no location-uptime route. */
  | { kind: "needs-newer" }
  /** Not read for this check type (latency of a non-HTTP check). */
  | { kind: "absent" };

export type CheckDetail = {
  config: AdminConfigResponse;
  view: AdminCheckView;
  /** The `/checks` entry; `undefined` when `/checks` does not list the check. */
  state: CheckWithState | undefined;
  uptime: PanelRead<UptimeResponse>;
  results: PanelRead<ResultsResponse>;
  locationUptime: PanelRead<CheckLocationUptime>;
  latency: PanelRead<CheckLatency>;
};

export type CheckDetailRead =
  | CheckReadProblem
  | { kind: "not-found" }
  | { kind: "ok"; detail: CheckDetail };

function panelOf<T>(
  call: ApiCall,
  outcome: ReadOutcome<T>,
  origin: string,
  deps: ApiReadDeps,
): PanelRead<T> {
  const failure = readFailureOf(call, outcome, origin, deps);
  if (failure !== undefined) {
    const isOldRoute =
      call === "location-uptime" && failure.kind === "http" && failure.status === 404;
    return isOldRoute ? { kind: "needs-newer" } : { kind: "failed", failure };
  }
  if (isReadWireAbsent(call, outcome, deps)) {
    return { kind: "failed", failure: { kind: "missing-header" } };
  }
  const { result } = outcome;
  return result.ok
    ? { kind: "ok", value: result.value }
    : { kind: "failed", failure: { kind: "invalid" } };
}

type PanelReader<T> = (() => Promise<PanelRead<T>>) | PanelRead<T>;

function runPanel<T>(reader: PanelReader<T>): Promise<PanelRead<T>> {
  return typeof reader === "function" ? reader() : Promise.resolve(reader);
}

/** A `before` of the results page: digits only, else the first page (R2). */
export function resultsBeforeOf(query: URLSearchParams): string | undefined {
  const values = query.getAll("before");
  const [before] = values;
  return values.length === 1 && before !== undefined && /^\d{1,16}$/.test(before)
    ? before
    : undefined;
}

function publicPanel<T>(
  call: ApiCall,
  url: string,
  validate: (raw: unknown) => Validation<T>,
  origin: string,
  deps: ApiReadDeps,
): () => Promise<PanelRead<T>> {
  return async () => panelOf(call, await readApi(url, validate, deps, undefined), origin, deps);
}

/**
 * R2: round 1 reads `/admin/config` and `/checks`; round 2 reads `/uptime`, the results, the
 * location uptime and, for HTTP only, the latency at the same time. No per-id read is made for
 * the ids `.` and `..` (Decision 14).
 */
export async function readCheckDetail(
  apiUrl: string,
  deps: ApiReadDeps,
  id: string,
  before: string | undefined,
): Promise<CheckDetailRead> {
  const list = await readCheckList(apiUrl, deps);
  if (list.kind !== "ok") return list;
  const view = list.config.checks.find((check) => check.id === id);
  if (view === undefined) return { kind: "not-found" };
  const origin = new URL(apiUrl).origin;
  const segment = apiIdSegment(id);
  const base = `${apiUrl}/checks/${segment ?? ""}`;
  const unaddressable = { kind: "unaddressable" } as const;
  const isHttp = view.type === undefined || view.type === "http";
  const beforeQuery = before === undefined ? "" : `&before=${before}`;
  const resultsQuery = `?limit=20${beforeQuery}`;
  let latencyReader: PanelReader<CheckLatency> = unaddressable;
  if (!isHttp) latencyReader = { kind: "absent" };
  else if (segment !== undefined) {
    latencyReader = publicPanel("latency", `${base}/latency`, validateCheckLatency, origin, deps);
  }
  const [uptime, results, locationUptime, latency] = await Promise.all([
    runPanel(publicPanel("uptime", `${apiUrl}/uptime`, validateUptimeResponse, origin, deps)),
    runPanel(
      segment === undefined
        ? unaddressable
        : publicPanel(
            "results",
            `${base}/results${resultsQuery}`,
            validateResultsResponse,
            origin,
            deps,
          ),
    ),
    runPanel(
      segment === undefined
        ? unaddressable
        : publicPanel(
            "location-uptime",
            `${base}/location-uptime`,
            validateCheckLocationUptime,
            origin,
            deps,
          ),
    ),
    runPanel(latencyReader),
  ]);
  const state = list.checks.find((check) => check.id === id);
  return {
    kind: "ok",
    detail: { config: list.config, view, state, uptime, results, locationUptime, latency },
  };
}
