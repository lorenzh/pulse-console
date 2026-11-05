import { type FetchJsonError, WIRE_VERSION, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";

/** Which pulse-api read failed. */
export type ApiCall =
  | "config"
  | "checks"
  | "export"
  | "uptime"
  | "results"
  | "latency"
  | "location-uptime"
  | "tokens"
  | "self"
  | "token"
  | "locations";

/** A failed pulse-api read, without any upstream body, exception text or token. */
export type ApiFailure =
  | { kind: "timeout" }
  | { kind: "refused"; origin: string }
  | { kind: "network"; origin: string }
  | { kind: "http"; call: ApiCall; status: number }
  | { kind: "wire-mismatch"; label: string }
  | { kind: "missing-header" }
  | { kind: "invalid" };

/** The wire version from a header, or a fixed text when it is missing or unsafe to show. */
export function wireLabel(header: string | null): string {
  const text = (header ?? "").trim();
  return text.length > 0 && text.length <= 16 && /^[0-9A-Za-z.-]+$/.test(text)
    ? text
    : "an unknown version";
}

const REFUSED_CODES: ReadonlySet<unknown> = new Set(["ConnectionRefused", "ECONNREFUSED"]);

// Reads an own data property only, so no getter or inherited value of the untrusted cause runs.
function ownValue(target: unknown, key: string): unknown {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * Whether a `fetch` rejection is a refused connection: `cause` or `cause.cause` has an own data
 * property `code` of `ConnectionRefused` (Bun) or `ECONNREFUSED` (Node style). Never the message.
 */
export function isConnectionRefused(cause: unknown): boolean {
  try {
    return (
      REFUSED_CODES.has(ownValue(cause, "code")) ||
      REFUSED_CODES.has(ownValue(ownValue(cause, "cause"), "code"))
    );
  } catch {
    // A Proxy trap may throw; such a cause is an ordinary network error.
    return false;
  }
}

/** Maps a contract `fetchJson` error to an `ApiFailure`. `origin` is the saved API origin. */
export function apiFailureOf(
  error: FetchJsonError,
  context: { call: ApiCall; origin: string; wireHeader: string | null },
): ApiFailure {
  switch (error.kind) {
    case "timeout":
      return { kind: "timeout" };
    case "network":
      return isConnectionRefused(error.cause)
        ? { kind: "refused", origin: context.origin }
        : { kind: "network", origin: context.origin };
    case "aborted":
      return { kind: "network", origin: context.origin };
    case "http":
      return { kind: "http", call: context.call, status: error.status };
    case "wire-mismatch":
      return { kind: "wire-mismatch", label: wireLabel(context.wireHeader) };
    case "too-large":
    case "invalid-json":
    case "validation":
      return { kind: "invalid" };
    default: {
      const never: never = error;
      return never;
    }
  }
}

function httpText(call: ApiCall, status: number): string {
  if (status >= 300 && status < 400) {
    return `pulse-api answered with a redirect (${status}); redirects are not followed.`;
  }
  if (status === 403 && (call === "config" || call === "export")) {
    return "The console token lacks the read or checks scope.";
  }
  if (status === 403 && (call === "tokens" || call === "self" || call === "token")) {
    return "The console token lacks the admin scope.";
  }
  if (status === 429) {
    return "pulse-api is throttling the console. Try again in a minute.";
  }
  return `pulse-api answered ${status}.`;
}

/** The fixed detail text of a failure. */
export function apiFailureText(failure: ApiFailure): string {
  switch (failure.kind) {
    case "timeout":
      return "pulse-api did not answer within 5 seconds.";
    case "refused":
      return `The connection to ${failure.origin} was refused. Check that pulse-api is running at this address.`;
    case "network":
      return `pulse-api cannot be reached at ${failure.origin}.`;
    case "http":
      return httpText(failure.call, failure.status);
    case "wire-mismatch":
      return `pulse-api speaks wire version ${failure.label}; this console needs ${WIRE_VERSION}.`;
    case "missing-header":
      return `pulse-api sent no ${WIRE_VERSION_HEADER} header.`;
    case "invalid":
      return "pulse-api sent an invalid answer.";
    default: {
      const never: never = failure;
      return never;
    }
  }
}

/** The kind label of an unreachable failure; `undefined` for an answer the console cannot use. */
export function apiFailureKind(failure: ApiFailure): string | undefined {
  switch (failure.kind) {
    case "timeout":
      return "timeout";
    case "refused":
      return "connection refused";
    case "network":
      return "network error";
    case "http":
      return `status ${failure.status}`;
    case "wire-mismatch":
    case "missing-header":
    case "invalid":
      return undefined;
    default: {
      const never: never = failure;
      return never;
    }
  }
}

/** The heading of a failure: unreachable, or an answer the console cannot use. */
export function apiFailureHeading(failure: ApiFailure): string {
  return failure.kind === "wire-mismatch" ||
    failure.kind === "missing-header" ||
    failure.kind === "invalid"
    ? "pulse-api sent an answer the console cannot use"
    : "pulse-api cannot be reached";
}
