import {
  type FetchJsonOptions,
  type FetchJsonResult,
  fetchJson,
  WIRE_VERSION_HEADER,
} from "@lorenzh/pulse-contract";
import { type ApiCall, type ApiFailure, apiFailureOf } from "./api-failure.ts";

export type FetchLike = FetchJsonOptions<unknown>["fetch"];

/** What a pulse-api read needs. Shared by the Overview and the Checks pages. */
export type ApiReadDeps = {
  fetch: FetchLike;
  /** The admin token from the settings; `undefined` when none is configured. */
  token: string | undefined;
  /** Timer injection, passed to `fetchJson`. Defaults to `setTimeout`. */
  schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
  /** Logs one `api read failed` line per failed read. */
  warn: (message: string, fields: Record<string, unknown>) => void;
};

const TIMEOUT_MS = 5000;

/** One finished read with the wire header it carried. */
export type ReadOutcome<T> = { result: FetchJsonResult<T>; wire: string | null };

/** One GET with a 5000 ms timeout, no followed redirect and the wire header recorded. */
export async function readApi<T>(
  url: string,
  validate: FetchJsonOptions<T>["validate"],
  deps: ApiReadDeps,
  authorization: string | undefined,
): Promise<ReadOutcome<T>> {
  // Each read keeps its own header, because reads run at the same time.
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

/** The failure of a read, logged once; `undefined` when it succeeded. */
export function readFailureOf<T>(
  call: ApiCall,
  outcome: ReadOutcome<T>,
  origin: string,
  deps: ApiReadDeps,
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

/** Whether a successful read came without the wire header; logs it once. */
export function isReadWireAbsent<T>(
  call: ApiCall,
  outcome: ReadOutcome<T>,
  deps: ApiReadDeps,
): boolean {
  if (outcome.result.ok && outcome.result.wire === "absent") {
    deps.warn("api read failed", { call, kind: "missing-header" });
    return true;
  }
  return false;
}
