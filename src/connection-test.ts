import {
  type FetchJsonError,
  type FetchJsonOptions,
  type FetchJsonResult,
  fetchJson,
  validateAdminConfigResponse,
  validateTokensResponse,
  WIRE_VERSION,
  WIRE_VERSION_HEADER,
} from "@lorenzh/pulse-contract";

export type FetchLike = FetchJsonOptions<unknown>["fetch"];

export type ConnectionTestDeps = {
  fetch: FetchLike;
  /** The admin token from the settings; `undefined` when none is configured. */
  token: string | undefined;
  /** Timer injection, passed to `fetchJson`. Defaults to `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => () => void;
};

export type ConnectionResult =
  | {
      isOk: true;
      wireVersion: number;
      checkCount: number;
      adminScope: "confirmed" | "not-checked";
    }
  | { isOk: false; text: string };

export const NO_TOKEN_TEXT =
  "The console has no pulse-api token. Set PULSE_CONSOLE_ADMIN_TOKEN_FILE and restart the console.";

const TIMEOUT_MS = 5000;

type Call = "config" | "tokens";

const failed = (text: string): ConnectionResult => ({ isOk: false, text });

function wireLabel(header: string | null): string {
  const text = (header ?? "").trim();
  return text.length > 0 && text.length <= 16 && /^[0-9A-Za-z.-]+$/.test(text)
    ? text
    : "an unknown version";
}

function statusText(call: Call, status: number): string {
  if (status >= 300 && status < 400) {
    return `pulse-api answered with a redirect (${status}); redirects are not followed.`;
  }
  switch (status) {
    case 401:
      return "pulse-api rejected the console token.";
    case 403:
      return call === "config"
        ? "The console token lacks the read or checks scope."
        : "The console token lacks the admin scope.";
    case 404:
      return "The admin routes of pulse-api are off. Enable its admin token import.";
    case 429:
      return "pulse-api is throttling the console. Try again in a minute.";
    default:
      return `pulse-api answered ${status}.`;
  }
}

function errorText(call: Call, error: FetchJsonError, origin: string, wire: string | null): string {
  switch (error.kind) {
    case "timeout":
      return "pulse-api did not answer within 5 seconds.";
    case "aborted":
    case "network":
      return `pulse-api cannot be reached at ${origin}.`;
    case "http":
      return statusText(call, error.status);
    case "wire-mismatch":
      return `pulse-api speaks wire version ${wireLabel(wire)}; this console needs ${WIRE_VERSION}.`;
    case "too-large":
    case "invalid-json":
    case "validation":
      return "pulse-api sent an invalid answer.";
    default: {
      const never: never = error;
      return never;
    }
  }
}

/**
 * Tests the pulse-api at `apiUrl` (no trailing `/`) with `GET /admin/config`, then
 * `GET /admin/tokens`. Failure texts hold no upstream body and no token. The token list is dropped.
 */
export async function testConnection(
  apiUrl: string,
  deps: ConnectionTestDeps,
): Promise<ConnectionResult> {
  if (deps.token === undefined) {
    return failed(NO_TOKEN_TEXT);
  }
  const origin = new URL(apiUrl).origin;
  let wire: string | null = null;
  const manualFetch: FetchLike = async (input, init) => {
    const response = await deps.fetch(input, { ...init, redirect: "manual" });
    wire = response.headers.get(WIRE_VERSION_HEADER);
    return response;
  };
  const get = <T>(path: string, validate: FetchJsonOptions<T>["validate"]) => {
    wire = null;
    const options: FetchJsonOptions<T> = {
      fetch: manualFetch,
      validate,
      timeoutMs: TIMEOUT_MS,
      headers: { authorization: `Bearer ${deps.token}` },
    };
    if (deps.schedule !== undefined) {
      options.schedule = deps.schedule;
    }
    return fetchJson(`${apiUrl}${path}`, options);
  };
  const check = <T>(call: Call, result: FetchJsonResult<T>): string | undefined => {
    if (!result.ok) {
      return errorText(call, result.error, origin, wire);
    }
    return result.wire === "absent"
      ? `pulse-api sent no ${WIRE_VERSION_HEADER} header.`
      : undefined;
  };

  const config = await get("/admin/config", (raw) => validateAdminConfigResponse(raw));
  const configFailure = check("config", config);
  if (configFailure !== undefined || !config.ok) {
    return failed(configFailure ?? "pulse-api sent an invalid answer.");
  }
  const checkCount = config.value.checks.length;

  const tokens = await get("/admin/tokens", (raw) => validateTokensResponse(raw));
  if (!tokens.ok && tokens.error.kind === "http" && tokens.error.status === 404) {
    return { isOk: true, wireVersion: WIRE_VERSION, checkCount, adminScope: "not-checked" };
  }
  const tokensFailure = check("tokens", tokens);
  if (tokensFailure !== undefined) {
    return failed(tokensFailure);
  }
  return { isOk: true, wireVersion: WIRE_VERSION, checkCount, adminScope: "confirmed" };
}
