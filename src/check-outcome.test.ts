import { describe, expect, test } from "bun:test";
import type { RequestJsonResult } from "@lorenzh/pulse-contract";
import { type CheckOutcome, checkOutcome, revisionOfEtag } from "./check-outcome.ts";

const REV = "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ETAG = '"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"';
const OK = { status: "ok" } as const;
const ABSENT = { status: "absent" } as const;
const MISMATCH = { status: "mismatch", error: "wire version 2" } as const;

function failed(
  error: Extract<RequestJsonResult<unknown>, { ok: false }>["error"],
  response: Extract<RequestJsonResult<unknown>, { ok: false }>["response"],
): RequestJsonResult<unknown> {
  return { ok: false, error, response };
}

const rows: Array<[string, RequestJsonResult<unknown>, CheckOutcome]> = [
  [
    "ok 201 with wire and etag",
    { ok: true, status: 201, value: undefined, etag: ETAG, wire: "ok" },
    { class: "saved", revision: REV },
  ],
  [
    "ok 204 with wire and no etag",
    { ok: true, status: 204, value: undefined, etag: null, wire: "ok" },
    { class: "saved", revision: null },
  ],
  [
    "ok 200 with a weak etag",
    { ok: true, status: 200, value: {}, etag: 'W/"x"', wire: "ok" },
    { class: "saved", revision: null },
  ],
  [
    "200 too-large body with wire and etag",
    failed({ kind: "too-large", maxBytes: 5242880 }, { status: 200, etag: ETAG, wire: OK }),
    { class: "saved", revision: REV, unreadable: "too-large" },
  ],
  [
    "201 invalid json with wire",
    failed({ kind: "invalid-json", message: "x" }, { status: 201, etag: null, wire: OK }),
    { class: "saved", revision: null, unreadable: "invalid-json" },
  ],
  [
    "200 failed validation with wire",
    failed({ kind: "validation", message: "x" }, { status: 200, etag: ETAG, wire: OK }),
    { class: "saved", revision: REV, unreadable: "validation" },
  ],
  [
    "204 body timeout with wire",
    failed({ kind: "timeout", timeoutMs: 5000 }, { status: 204, etag: null, wire: OK }),
    { class: "saved", revision: null, unreadable: "timeout" },
  ],
  [
    "401 with wire",
    failed({ kind: "http", status: 401, wire: OK }, { status: 401, etag: null, wire: OK }),
    { class: "refused", status: 401 },
  ],
  [
    "403 with wire",
    failed({ kind: "http", status: 403, wire: OK }, { status: 403, etag: null, wire: OK }),
    { class: "refused", status: 403 },
  ],
  [
    "404 with wire",
    failed({ kind: "http", status: 404, wire: OK }, { status: 404, etag: null, wire: OK }),
    { class: "refused", status: 404 },
  ],
  [
    "409 with wire and a message",
    failed(
      { kind: "http", status: 409, wire: OK, message: "check exists" },
      { status: 409, etag: null, wire: OK },
    ),
    { class: "refused", status: 409, message: "check exists" },
  ],
  [
    "412 with wire",
    failed({ kind: "http", status: 412, wire: OK }, { status: 412, etag: null, wire: OK }),
    { class: "refused", status: 412 },
  ],
  [
    "413 with wire",
    failed({ kind: "http", status: 413, wire: OK }, { status: 413, etag: null, wire: OK }),
    { class: "refused", status: 413 },
  ],
  [
    "422 with wire and no message (oversized error body)",
    failed({ kind: "http", status: 422, wire: OK }, { status: 422, etag: null, wire: OK }),
    { class: "refused", status: 422 },
  ],
  [
    "429 with wire",
    failed({ kind: "http", status: 429, wire: OK }, { status: 429, etag: null, wire: OK }),
    { class: "refused", status: 429 },
  ],
  [
    "400 with wire",
    failed({ kind: "http", status: 400, wire: OK }, { status: 400, etag: null, wire: OK }),
    { class: "refused", status: 400 },
  ],
  [
    "428 with wire and a message",
    failed(
      { kind: "http", status: 428, wire: OK, message: "If-Match is required" },
      { status: 428, etag: null, wire: OK },
    ),
    { class: "refused", status: 428, message: "If-Match is required" },
  ],
  [
    "500 with wire",
    failed({ kind: "http", status: 500, wire: OK }, { status: 500, etag: null, wire: OK }),
    { class: "refused", status: 500 },
  ],
  [
    "502 with wire",
    failed({ kind: "http", status: 502, wire: OK }, { status: 502, etag: null, wire: OK }),
    { class: "refused", status: 502 },
  ],
  [
    "599 with wire",
    failed({ kind: "http", status: 599, wire: OK }, { status: 599, etag: null, wire: OK }),
    { class: "refused", status: 599 },
  ],
  [
    "302 with wire",
    failed({ kind: "http", status: 302, wire: OK }, { status: 302, etag: null, wire: OK }),
    { class: "unknown", status: 302, isRedirect: true },
  ],
  [
    "302 without wire is a redirect, not a wire case",
    failed({ kind: "http", status: 302, wire: ABSENT }, { status: 302, etag: null, wire: ABSENT }),
    { class: "unknown", status: 302, isRedirect: true },
  ],
  [
    "502 without wire (proxy page)",
    failed({ kind: "http", status: 502, wire: ABSENT }, { status: 502, etag: null, wire: ABSENT }),
    { class: "unknown", status: 502, isRedirect: false },
  ],
  [
    "422 with wire 2",
    failed(
      { kind: "http", status: 422, wire: MISMATCH },
      { status: 422, etag: null, wire: MISMATCH },
    ),
    { class: "unknown", status: 422, isRedirect: false },
  ],
  [
    "200 with wire 2",
    failed({ kind: "wire-mismatch", message: "x" }, { status: 200, etag: ETAG, wire: MISMATCH }),
    { class: "unknown", status: 200, isRedirect: false },
  ],
  [
    "ok 200 without wire",
    { ok: true, status: 200, value: {}, etag: ETAG, wire: "absent" },
    { class: "unknown", status: 200, isRedirect: false },
  ],
  [
    "ok 202 with wire",
    { ok: true, status: 202, value: undefined, etag: ETAG, wire: "ok" },
    { class: "unknown", status: 202, isRedirect: false },
  ],
  [
    "101 with wire",
    failed({ kind: "http", status: 101, wire: OK }, { status: 101, etag: null, wire: OK }),
    { class: "unknown", status: 101, isRedirect: false },
  ],
  [
    "timeout before the headers",
    failed({ kind: "timeout", timeoutMs: 5000 }, null),
    { class: "unknown", status: null, isRedirect: false },
  ],
  [
    "network error",
    failed({ kind: "network", cause: new Error("x") }, null),
    { class: "unknown", status: null, isRedirect: false },
  ],
  [
    "aborted",
    failed({ kind: "aborted", reason: "x" }, null),
    { class: "unknown", status: null, isRedirect: false },
  ],
];

describe("checkOutcome", () => {
  for (const [name, input, expected] of rows) {
    test(name, () => {
      expect(checkOutcome(input)).toEqual(expected);
    });
  }
});

describe("revisionOfEtag", () => {
  const cases: Array<[string | null, string | null]> = [
    [ETAG, REV],
    ['W/"x"', null],
    ['"x"', null],
    [REV, null],
    ['"', null],
    [null, null],
  ];
  for (const [etag, expected] of cases) {
    test(`${JSON.stringify(etag)} is ${JSON.stringify(expected)}`, () => {
      expect(revisionOfEtag(etag)).toBe(expected);
    });
  }
});
