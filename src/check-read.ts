import {
  type AdminConfigExport,
  type AdminConfigResponse,
  type ChecksResponse,
  type Validation,
  validateAdminConfigExport,
  validateAdminConfigResponse,
  validateAdminConfigSummary,
  validateChecksResponse,
} from "@lorenzh/pulse-contract";
import type { ApiFailure } from "./api-failure.ts";
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
  outcomes: ReadonlyArray<[call: "config" | "checks" | "export", ReadOutcome<unknown>]>,
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
