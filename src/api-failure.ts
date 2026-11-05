import { type FetchJsonError, WIRE_VERSION, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";

/** Which pulse-api read failed. */
export type ApiCall = "config" | "checks";

/** A failed pulse-api read, without any upstream body, exception text or token. */
export type ApiFailure =
  | { kind: "timeout" }
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

/** Maps a contract `fetchJson` error to an `ApiFailure`. `origin` is the saved API origin. */
export function apiFailureOf(
  error: FetchJsonError,
  context: { call: ApiCall; origin: string; wireHeader: string | null },
): ApiFailure {
  switch (error.kind) {
    case "timeout":
      return { kind: "timeout" };
    case "aborted":
    case "network":
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
  if (status === 403 && call === "config") {
    return "The console token lacks the read or checks scope.";
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

/** The heading of a failure: unreachable, or an answer the console cannot use. */
export function apiFailureHeading(failure: ApiFailure): string {
  return failure.kind === "wire-mismatch" ||
    failure.kind === "missing-header" ||
    failure.kind === "invalid"
    ? "pulse-api sent an answer the console cannot use"
    : "pulse-api cannot be reached";
}
