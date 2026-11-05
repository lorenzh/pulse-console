import { expect, test } from "bun:test";
import type { FetchJsonError } from "@lorenzh/pulse-contract";
import { type ApiCall, apiFailureHeading, apiFailureOf, apiFailureText } from "./api-failure.ts";

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
