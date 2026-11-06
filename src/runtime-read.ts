import {
  type AdminNotifyChannelsView,
  type AdminNotifyFailedView,
  type AdminStatusSettingsView,
  type FetchJsonResult,
  type ResendCommand,
  validateAdminNotifyChannelsView,
  validateAdminNotifyFailedView,
  validateAdminStatusSettingsView,
  validateResendCommand,
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
export type NotifyChannelsRead = RuntimeReadProblem | { kind: "ok"; view: AdminNotifyChannelsView };
export type NotifyFailedRead = RuntimeReadProblem | { kind: "ok"; view: AdminNotifyFailedView };
/** A resend command read; `not-found` is a `404` for an unknown or expired command id. */
export type ResendCommandRead =
  | Exclude<RuntimeReadProblem, { kind: "old-api" }>
  | { kind: "not-found" }
  | { kind: "ok"; command: ResendCommand };

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

async function readRuntime<T>(
  call: ApiCall,
  url: string,
  validate: (raw: unknown) => { ok: true; value: T } | { ok: false; error: string },
  apiUrl: string,
  deps: ApiReadDeps,
): Promise<RuntimeReadProblem | { kind: "ok"; value: T }> {
  if (deps.token === undefined) return { kind: "no-token" };
  const outcome = await readApi(url, validate, deps, `Bearer ${deps.token}`);
  const problem = problemOf(call, outcome, apiUrl, deps);
  if (problem !== undefined) return problem;
  if (!outcome.result.ok) return { kind: "failed", failure: { kind: "invalid" } };
  return { kind: "ok", value: outcome.result.value };
}

/**
 * R2: `GET /admin/notify/channels`. Every database channel passes the admin record validator
 * (`validateAdminNotifyChannelsView`), not only the service envelope. A `404` is an older api.
 */
export async function readNotifyChannels(
  apiUrl: string,
  deps: ApiReadDeps,
): Promise<NotifyChannelsRead> {
  const read = await readRuntime(
    "notify-channels",
    `${apiUrl}/admin/notify/channels`,
    (raw) => validateAdminNotifyChannelsView(raw),
    apiUrl,
    deps,
  );
  return read.kind === "ok" ? { kind: "ok", view: read.value } : read;
}

/** R2: `GET /admin/notify/failed`, the failed list of the last report without the rest of it. */
export async function readNotifyFailed(
  apiUrl: string,
  deps: ApiReadDeps,
): Promise<NotifyFailedRead> {
  const read = await readRuntime(
    "notify-failed",
    `${apiUrl}/admin/notify/failed`,
    (raw) => validateAdminNotifyFailedView(raw),
    apiUrl,
    deps,
  );
  return read.kind === "ok" ? { kind: "ok", view: read.value } : read;
}

/** R2: `GET /admin/notify/resends/:id`; `commandId` must already match the command id rule. */
export async function readResendCommand(
  apiUrl: string,
  commandId: string,
  deps: ApiReadDeps,
): Promise<ResendCommandRead> {
  const read = await readRuntime(
    "notify-resend",
    `${apiUrl}/admin/notify/resends/${encodeURIComponent(commandId)}`,
    (raw) => validateResendCommand(raw),
    apiUrl,
    deps,
  );
  if (read.kind === "old-api") return { kind: "not-found" };
  return read.kind === "ok" ? { kind: "ok", command: read.value } : read;
}
