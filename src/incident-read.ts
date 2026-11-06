import {
  type AdminConfigResponse,
  type Incident,
  type IncidentsResponse,
  isPublicManualIncident,
  type ManualIncident,
  publicManualIncident,
  type ResultsResponse,
  type Validation,
  validateIncidentsResponse,
  validateManualIncident,
  validateManualIncidentsResponse,
  validateResultsResponse,
} from "@lorenzh/pulse-contract";
import type { ApiCall } from "./api-failure.ts";
import { apiIdSegment } from "./api-path.ts";
import {
  type ApiReadDeps,
  isReadWireAbsent,
  type ReadOutcome,
  readApi,
  readFailureOf,
} from "./api-read.ts";
import { type CheckReadProblem, readCheckConfig } from "./check-read.ts";
import { AUTOMATIC_READ_LIMIT, INCIDENT_WINDOW_MS } from "./incident-list.ts";

/** The data of the incident list: public manual items, automatic items and the config. */
export type IncidentListRead =
  | CheckReadProblem
  | {
      kind: "ok";
      manual: ManualIncident[];
      automatic: IncidentsResponse;
      config: AdminConfigResponse;
    };

/** One public manual incident; `config` is absent when the route does not read it. */
export type ManualIncidentRead =
  | CheckReadProblem
  | { kind: "not-found" }
  | { kind: "ok"; incident: ManualIncident; config: AdminConfigResponse | undefined };

/** The results of an automatic incident's check (section 8). */
export type IncidentResultsRead =
  | { kind: "ok"; value: ResultsResponse }
  | { kind: "check-gone" }
  | { kind: "unaddressable" }
  | CheckReadProblem;

export type AutomaticIncidentRead =
  | CheckReadProblem
  | { kind: "not-found" }
  | {
      kind: "ok";
      incident: Incident;
      config: AdminConfigResponse;
      results: IncidentResultsRead;
    };

/** The composer's reads: the config and, with `from`, the automatic incident or none. */
export type ComposerRead =
  | CheckReadProblem
  | { kind: "ok"; config: AdminConfigResponse; from: Incident | undefined };

type Step<T> = { kind: "ok"; value: T } | { kind: "absent" } | CheckReadProblem;

// A public read, mapped to a value, a tolerated 404, or a problem; each failure logs once.
function stepOf<T>(
  call: ApiCall,
  outcome: ReadOutcome<T>,
  origin: string,
  deps: ApiReadDeps,
): Step<T> {
  const failure = readFailureOf(call, outcome, origin, deps);
  if (failure?.kind === "http" && failure.status === 404) return { kind: "absent" };
  if (failure !== undefined) return { kind: "failed", failure };
  if (isReadWireAbsent(call, outcome, deps)) {
    return { kind: "failed", failure: { kind: "missing-header" } };
  }
  return outcome.result.ok
    ? { kind: "ok", value: outcome.result.value }
    : { kind: "failed", failure: { kind: "invalid" } };
}

// Drops every non-public item before validation, so a private draft never fails the page.
function validatePublicList(raw: unknown): Validation<ManualIncident[]> {
  const items = Array.isArray(raw) ? raw.filter((item) => isPublicManualIncident(item)) : raw;
  const result = validateManualIncidentsResponse(items);
  return result.ok ? { ok: true, value: result.value.map(publicManualIncident) } : result;
}

type PublicOne = { kind: "public"; incident: ManualIncident } | { kind: "private" };

function validatePublicOne(raw: unknown): Validation<PublicOne> {
  if (!isPublicManualIncident(raw)) return { ok: true, value: { kind: "private" } };
  const result = validateManualIncident(raw);
  return result.ok
    ? { ok: true, value: { kind: "public", incident: publicManualIncident(result.value) } }
    : result;
}

function readAutomatic(apiUrl: string, deps: ApiReadDeps, now: number) {
  const since = now - INCIDENT_WINDOW_MS;
  return readApi(
    `${apiUrl}/incidents?since=${since}&limit=${AUTOMATIC_READ_LIMIT}`,
    (raw) => validateIncidentsResponse(raw),
    deps,
    undefined,
  );
}

// An absent automatic list is not a tolerated state: only the manual list may answer 404.
function strictStep<T>(step: Step<T>): { kind: "ok"; value: T } | CheckReadProblem {
  if (step.kind === "absent") {
    return { kind: "failed", failure: { kind: "http", call: "incidents", status: 404 } };
  }
  return step;
}

/** Section 4: manual list (404 is empty), automatic list and config; the first failure wins. */
export async function readIncidentList(
  apiUrl: string,
  deps: ApiReadDeps,
  now: number,
): Promise<IncidentListRead> {
  if (deps.token === undefined) return { kind: "no-token" };
  const origin = new URL(apiUrl).origin;
  const [manualOutcome, automaticOutcome, config] = await Promise.all([
    readApi(`${apiUrl}/manual-incidents?status=all`, validatePublicList, deps, undefined),
    readAutomatic(apiUrl, deps, now),
    readCheckConfig(apiUrl, deps),
  ]);
  const manual = stepOf("manual-incidents", manualOutcome, origin, deps);
  const automatic = strictStep(stepOf("incidents", automaticOutcome, origin, deps));
  if (manual.kind !== "ok" && manual.kind !== "absent") return manual;
  if (automatic.kind !== "ok") return automatic;
  if (config.kind !== "ok") return config;
  return {
    kind: "ok",
    manual: manual.kind === "ok" ? manual.value : [],
    automatic: automatic.value,
    config: config.config,
  };
}

/** Sections 7 and 9: one public manual incident, with the config when `withConfig`. */
export async function readManualIncident(
  apiUrl: string,
  deps: ApiReadDeps,
  id: number,
  withConfig: boolean,
): Promise<ManualIncidentRead> {
  if (deps.token === undefined) return { kind: "no-token" };
  const origin = new URL(apiUrl).origin;
  const [outcome, config] = await Promise.all([
    readApi(`${apiUrl}/manual-incidents/${id}`, validatePublicOne, deps, undefined),
    withConfig ? readCheckConfig(apiUrl, deps) : Promise.resolve(undefined),
  ]);
  const step = stepOf("manual-incident", outcome, origin, deps);
  if (step.kind === "absent") return { kind: "not-found" };
  if (step.kind !== "ok") return step;
  if (config !== undefined && config.kind !== "ok") return config;
  if (step.value.kind === "private") return { kind: "not-found" };
  return { kind: "ok", incident: step.value.incident, config: config?.config };
}

async function readResults(
  apiUrl: string,
  deps: ApiReadDeps,
  incident: Incident,
): Promise<IncidentResultsRead> {
  const segment = apiIdSegment(incident.checkId);
  if (segment === undefined) return { kind: "unaddressable" };
  const before = incident.resolvedAt === null ? "" : `&before=${incident.resolvedAt + 1}`;
  const outcome = await readApi(
    `${apiUrl}/checks/${segment}/results?limit=20${before}`,
    (raw) => validateResultsResponse(raw),
    deps,
    undefined,
  );
  const step = stepOf("results", outcome, new URL(apiUrl).origin, deps);
  return step.kind === "absent" ? { kind: "check-gone" } : step;
}

/** Section 8: the automatic list and config, then the check's results when addressable. */
export async function readAutomaticIncident(
  apiUrl: string,
  deps: ApiReadDeps,
  id: number,
  now: number,
): Promise<AutomaticIncidentRead> {
  if (deps.token === undefined) return { kind: "no-token" };
  const origin = new URL(apiUrl).origin;
  const [outcome, config] = await Promise.all([
    readAutomatic(apiUrl, deps, now),
    readCheckConfig(apiUrl, deps),
  ]);
  const automatic = strictStep(stepOf("incidents", outcome, origin, deps));
  if (automatic.kind !== "ok") return automatic;
  if (config.kind !== "ok") return config;
  const incident = automatic.value.find((item) => item.id === id);
  if (incident === undefined) return { kind: "not-found" };
  const results = await readResults(apiUrl, deps, incident);
  return { kind: "ok", incident, config: config.config, results };
}

/** Section 9: with `from`, the automatic list first, then the config; else the config alone. */
export async function readComposer(
  apiUrl: string,
  deps: ApiReadDeps,
  from: number | undefined,
  now: number,
): Promise<ComposerRead> {
  if (deps.token === undefined) return { kind: "no-token" };
  let found: Incident | undefined;
  if (from !== undefined) {
    const outcome = await readAutomatic(apiUrl, deps, now);
    const automatic = strictStep(stepOf("incidents", outcome, new URL(apiUrl).origin, deps));
    if (automatic.kind !== "ok") return automatic;
    found = automatic.value.find((item) => item.id === from);
  }
  const config = await readCheckConfig(apiUrl, deps);
  if (config.kind !== "ok") return config;
  return { kind: "ok", config: config.config, from: found };
}
