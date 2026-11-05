import { expect, test } from "bun:test";
import type { FetchJsonError } from "@lorenzh/pulse-contract";
import {
  type ApiCall,
  type ApiFailure,
  apiFailureHeading,
  apiFailureKind,
  apiFailureOf,
  apiFailureText,
} from "./api-failure.ts";

const UNREACHABLE = "pulse-api cannot be reached";
const UNUSABLE = "pulse-api sent an answer the console cannot use";
const ORIGIN = "http://127.0.0.1:3000";

const cases: Array<[string, FetchJsonError, ApiCall, string | null, string, string]> = [
  [
    "timeout",
    { kind: "timeout", timeoutMs: 5000 },
    "config",
    null,
    "pulse-api did not answer within 5 seconds.",
    UNREACHABLE,
  ],
  [
    "network",
    { kind: "network", cause: new Error("secret-cause") },
    "checks",
    null,
    `pulse-api cannot be reached at ${ORIGIN}.`,
    UNREACHABLE,
  ],
  [
    "aborted",
    { kind: "aborted", reason: "x" },
    "checks",
    null,
    `pulse-api cannot be reached at ${ORIGIN}.`,
    UNREACHABLE,
  ],
  [
    "302",
    { kind: "http", status: 302, wire: { status: "absent" } },
    "config",
    null,
    "pulse-api answered with a redirect (302); redirects are not followed.",
    UNREACHABLE,
  ],
  [
    "403 config",
    { kind: "http", status: 403, wire: { status: "ok" } },
    "config",
    null,
    "The console token lacks the read or checks scope.",
    UNREACHABLE,
  ],
  [
    "403 export",
    { kind: "http", status: 403, wire: { status: "ok" } },
    "export",
    null,
    "The console token lacks the read or checks scope.",
    UNREACHABLE,
  ],
  [
    "403 checks",
    { kind: "http", status: 403, wire: { status: "ok" } },
    "checks",
    null,
    "pulse-api answered 403.",
    UNREACHABLE,
  ],
  [
    "429",
    { kind: "http", status: 429, wire: { status: "ok" } },
    "checks",
    null,
    "pulse-api is throttling the console. Try again in a minute.",
    UNREACHABLE,
  ],
  [
    "503",
    { kind: "http", status: 503, wire: { status: "ok" } },
    "checks",
    null,
    "pulse-api answered 503.",
    UNREACHABLE,
  ],
  [
    "wire",
    { kind: "wire-mismatch", message: "m" },
    "config",
    "2",
    "pulse-api speaks wire version 2; this console needs 1.",
    UNUSABLE,
  ],
  [
    "wire unsafe",
    { kind: "wire-mismatch", message: "m" },
    "config",
    "<script>",
    "pulse-api speaks wire version an unknown version; this console needs 1.",
    UNUSABLE,
  ],
  [
    "too large",
    { kind: "too-large", maxBytes: 1 },
    "checks",
    null,
    "pulse-api sent an invalid answer.",
    UNUSABLE,
  ],
  [
    "invalid json",
    { kind: "invalid-json", message: "upstream-body-sentinel" },
    "checks",
    null,
    "pulse-api sent an invalid answer.",
    UNUSABLE,
  ],
  [
    "validation",
    { kind: "validation", message: "upstream-body-sentinel" },
    "checks",
    null,
    "pulse-api sent an invalid answer.",
    UNUSABLE,
  ],
];

test.each(cases)("%s", (_name, error, call, wireHeader, text, heading) => {
  const failure = apiFailureOf(error, { call, origin: ORIGIN, wireHeader });
  expect(apiFailureText(failure)).toBe(text);
  expect(apiFailureHeading(failure)).toBe(heading);
});

test("missing header", () => {
  expect(apiFailureText({ kind: "missing-header" })).toBe(
    "pulse-api sent no x-pulse-contract header.",
  );
  expect(apiFailureHeading({ kind: "missing-header" })).toBe(UNUSABLE);
});

const REFUSED_TEXT = `The connection to ${ORIGIN} was refused. Check that pulse-api is running at this address.`;
const NETWORK_TEXT = `pulse-api cannot be reached at ${ORIGIN}.`;

function withCodeGetter(calls: { count: number }): object {
  const cause = new TypeError("getter-sentinel");
  Object.defineProperty(cause, "code", {
    get: () => {
      calls.count += 1;
      return "ConnectionRefused";
    },
  });
  return cause;
}

const throwingProxy = new Proxy(
  {},
  {
    getOwnPropertyDescriptor: () => {
      throw new Error("proxy-sentinel");
    },
    get: () => {
      throw new Error("proxy-sentinel");
    },
  },
);

const refusedCauses: Array<[string, unknown, "connection refused" | "network error"]> = [
  [
    "own code ConnectionRefused",
    Object.assign(new TypeError("x"), { code: "ConnectionRefused" }),
    "connection refused",
  ],
  ["own code ECONNREFUSED", { code: "ECONNREFUSED" }, "connection refused"],
  [
    "one nested cause.code",
    new TypeError("x", { cause: { code: "ECONNREFUSED" } }),
    "connection refused",
  ],
  [
    "two nested causes",
    new TypeError("x", { cause: { cause: { code: "ECONNREFUSED" } } }),
    "network error",
  ],
  ["message only", new TypeError("ECONNREFUSED connection refused sentinel"), "network error"],
  ["inherited code", Object.create({ code: "ECONNREFUSED" }), "network error"],
  ["unmatched code", { code: "ENOTFOUND" }, "network error"],
  ["code in another case", { code: "econnrefused" }, "network error"],
  ["throwing Proxy", throwingProxy, "network error"],
  ["nested throwing Proxy", { cause: throwingProxy }, "network error"],
  ["string cause", "ECONNREFUSED", "network error"],
  ["undefined cause", undefined, "network error"],
];

test.each(refusedCauses)("network cause: %s", (_name, cause, kind) => {
  const failure = apiFailureOf(
    { kind: "network", cause },
    { call: "checks", origin: ORIGIN, wireHeader: null },
  );
  expect(apiFailureKind(failure)).toBe(kind);
  expect(apiFailureText(failure)).toBe(kind === "connection refused" ? REFUSED_TEXT : NETWORK_TEXT);
  expect(apiFailureHeading(failure)).toBe(UNREACHABLE);
});

test("a code getter runs 0 times and gives a network error", () => {
  const calls = { count: 0 };
  for (const cause of [withCodeGetter(calls), { cause: withCodeGetter(calls) }]) {
    const failure = apiFailureOf(
      { kind: "network", cause },
      { call: "checks", origin: ORIGIN, wireHeader: null },
    );
    expect(apiFailureKind(failure)).toBe("network error");
  }
  expect(calls.count).toBe(0);
});

const kinds: Array<[ApiFailure, string | undefined]> = [
  [{ kind: "timeout" }, "timeout"],
  [{ kind: "refused", origin: ORIGIN }, "connection refused"],
  [{ kind: "network", origin: ORIGIN }, "network error"],
  [{ kind: "http", call: "checks", status: 503 }, "status 503"],
  [{ kind: "http", call: "config", status: 302 }, "status 302"],
  [{ kind: "wire-mismatch", label: "2" }, undefined],
  [{ kind: "missing-header" }, undefined],
  [{ kind: "invalid" }, undefined],
];

test.each(kinds)("kind label of %o", (failure, label) => {
  expect(apiFailureKind(failure)).toBe(label);
});

test("aborted is a network error, not refused", () => {
  const failure = apiFailureOf(
    { kind: "aborted", reason: { code: "ECONNREFUSED" } },
    { call: "checks", origin: ORIGIN, wireHeader: null },
  );
  expect(apiFailureKind(failure)).toBe("network error");
});
