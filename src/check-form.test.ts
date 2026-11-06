import { describe, expect, test } from "bun:test";
import type { AdminCheckView } from "@lorenzh/pulse-contract";
import { editInputOf } from "./check-editor-page.ts";
import { type CheckFormResult, parseCreateForm, parseEditForm } from "./check-form.ts";

type Fields = Record<string, string>;

const DUPLICATE = "This header is already set in another row (names are compared without case).";
const PROTO = "__proto__ is not an allowed header name.";

function inputOf(result: CheckFormResult): unknown {
  if (!result.isOk) throw new Error(`expected a built input, got ${JSON.stringify(result.errors)}`);
  return result.input;
}

/** The message on `field`; the result must hold no built input. */
function errorOn(result: CheckFormResult, field: string): string | undefined {
  expect(result.isOk).toBe(false);
  if (result.isOk) return undefined;
  return result.errors.find((error) => error.field === field)?.message;
}

const http: Fields = {
  type: "http",
  id: "web",
  name: "Web",
  url: "https://example.com/",
  interval_ms: "1500",
};
const tls: Fields = {
  type: "tls",
  id: "cert",
  name: "Cert",
  host: "example.com",
  interval_ms: "60000",
};
const tcp: Fields = {
  type: "tcp",
  id: "db",
  name: "DB",
  host: "db.internal",
  port: "5432",
  interval_ms: "30000",
};
const dns: Fields = {
  type: "dns",
  id: "mx",
  name: "MX",
  dns_name: "example.com",
  record_type: "MX",
  interval_ms: "60000",
};
const domain: Fields = { type: "domain", id: "dom", name: "Domain", domain: "example.com" };
const heartbeat: Fields = {
  type: "heartbeat",
  id: "nightly-backup",
  name: "Nightly backup",
  period_ms: "86400000",
  secret: "abcdefghijklmnop",
};

// Fields of every other type, posted with each form: they must never reach the input.
const foreign: Fields = {
  url: "https://other.example/",
  method: "POST",
  host: "other.example",
  port: "1",
  warn_days: "1",
  dns_name: "other.example",
  record_type: "A",
  domain: "other.example",
  period_ms: "5000",
  grace_ms: "5",
  secret: "zzzzzzzzzzzzzzzzzzzz",
  keyword: "x",
  body: "b",
  header_0_name: "X-A",
  header_0_value: "1",
  assert_0_mode: "exists",
};

describe("parseCreateForm builds a literal input per type", () => {
  const cases: [string, Fields, unknown][] = [
    [
      "http",
      http,
      { id: "web", name: "Web", url: "https://example.com/", method: "GET", intervalMs: 1500 },
    ],
    [
      "tls",
      tls,
      {
        id: "cert",
        name: "Cert",
        type: "tls",
        host: "example.com",
        port: 443,
        warnDays: 14,
        intervalMs: 60000,
      },
    ],
    [
      "tcp",
      tcp,
      { id: "db", name: "DB", type: "tcp", host: "db.internal", port: 5432, intervalMs: 30000 },
    ],
    [
      "dns",
      dns,
      {
        id: "mx",
        name: "MX",
        type: "dns",
        dnsName: "example.com",
        recordType: "MX",
        intervalMs: 60000,
      },
    ],
    [
      "domain",
      domain,
      {
        id: "dom",
        name: "Domain",
        type: "domain",
        domain: "example.com",
        warnDays: 30,
        intervalMs: 86400000,
      },
    ],
    [
      "heartbeat",
      { ...heartbeat, grace_ms: "" },
      {
        id: "nightly-backup",
        name: "Nightly backup",
        type: "heartbeat",
        period: 86400000,
        grace: 0,
        secret: "abcdefghijklmnop",
      },
    ],
  ];
  for (const [name, fields, expected] of cases) {
    test(`${name} with defaults`, () => {
      expect(inputOf(parseCreateForm(fields))).toEqual(expected);
    });
  }

  test("fields of other types are ignored", () => {
    expect(inputOf(parseCreateForm({ ...foreign, ...heartbeat, grace_ms: "" }))).toEqual({
      id: "nightly-backup",
      name: "Nightly backup",
      type: "heartbeat",
      period: 86400000,
      grace: 0,
      secret: "abcdefghijklmnop",
    });
    const notTls: Fields = { ...foreign, host: "example.com", port: "", warn_days: "" };
    expect(inputOf(parseCreateForm({ ...notTls, ...tls }))).toEqual({
      id: "cert",
      name: "Cert",
      type: "tls",
      host: "example.com",
      port: 443,
      warnDays: 14,
      intervalMs: 60000,
    });
  });

  test("tcp and dns take every optional field", () => {
    expect(
      inputOf(
        parseCreateForm({
          ...tcp,
          url: "https://x/",
          timeout_ms: "1500",
          retries: "2",
          retry_delay_ms: "0",
          availability_target: "99.999",
        }),
      ),
    ).toEqual({
      id: "db",
      name: "DB",
      type: "tcp",
      host: "db.internal",
      port: 5432,
      intervalMs: 30000,
      timeoutMs: 1500,
      retries: 2,
      retryDelayMs: 0,
      availabilityTarget: 99.999,
    });
    expect(
      inputOf(
        parseCreateForm({
          ...dns,
          expected: "10 mx.example.com\r\n\r\n 20 mx2.example.com \n",
          resolver: "::1",
        }),
      ),
    ).toEqual({
      id: "mx",
      name: "MX",
      type: "dns",
      dnsName: "example.com",
      recordType: "MX",
      expected: ["10 mx.example.com", "20 mx2.example.com"],
      resolver: "::1",
      intervalMs: 60000,
    });
  });

  test("a full http check", () => {
    const fields: Fields = {
      ...http,
      name: "  Shop API  ",
      method: "POST",
      timeout_ms: "5000",
      retries: "3",
      retry_delay_ms: "60000",
      latency_objective_ms: "800",
      expected_status: "200 , 204, 300-399",
      keyword: "ok",
      body: '{"a":1}',
      header_0_name: "X-Api-Key",
      header_0_kind: "plain",
      header_0_value: "plain new",
      header_1_name: "Authorization",
      header_1_kind: "env",
      header_1_value: "PULSE_HEADER_TOKEN",
      assert_0_pointer: "/status",
      assert_0_mode: "equals",
      assert_0_equals: '"ok"',
      assert_1_pointer: "",
      assert_1_mode: "exists",
      assert_2_pointer: "/ignored",
      assert_2_mode: "none",
      assert_2_equals: "not json",
      tcp_ignored: "x",
      host: "ignored.example",
      secret: "zzzzzzzzzzzzzzzzzzzz",
    };
    expect(inputOf(parseCreateForm(fields))).toEqual({
      id: "web",
      name: "Shop API",
      url: "https://example.com/",
      method: "POST",
      intervalMs: 1500,
      timeoutMs: 5000,
      retries: 3,
      retryDelayMs: 60000,
      latencyObjectiveMs: 800,
      expectedStatus: [200, 204, "300-399"],
      keyword: "ok",
      headers: { "X-Api-Key": "plain new", Authorization: { env: "PULSE_HEADER_TOKEN" } },
      body: '{"a":1}',
      jsonAssert: [
        { pointer: "/status", equals: "ok" },
        { pointer: "", exists: true },
      ],
    });
  });
});

describe("field rules", () => {
  test("expected_status", () => {
    const parsed = inputOf(parseCreateForm({ ...http, expected_status: "200 , 204" }));
    expect(parsed).toMatchObject({ expectedStatus: [200, 204] });
    for (const value of ["2xx", "299-200", "99", "600", "200,,204"]) {
      expect(errorOn(parseCreateForm({ ...http, expected_status: value }), "expected_status")).toBe(
        "Enter up to 20 status codes or ranges, separated by commas, such as 200, 204 or 200-299.",
      );
    }
    const many = Array.from({ length: 21 }, () => "200").join(",");
    expect(
      errorOn(parseCreateForm({ ...http, expected_status: many }), "expected_status"),
    ).toBeDefined();
  });

  test("availability_target", () => {
    expect(inputOf(parseCreateForm({ ...http, availability_target: "99.999" }))).toMatchObject({
      availabilityTarget: 99.999,
    });
    expect(inputOf(parseCreateForm({ ...http, availability_target: "90" }))).toMatchObject({
      availabilityTarget: 90,
    });
    for (const value of ["100", "89.999", "1e2", "99.9999", "-95", "95."]) {
      expect(
        errorOn(parseCreateForm({ ...http, availability_target: value }), "availability_target"),
      ).toBe(
        "Enter a percentage from 90 up to but not including 100, with at most three decimals.",
      );
    }
  });

  test("durations, retries and ports", () => {
    const cases: [Fields, string, string][] = [
      [
        { ...domain, interval_ms: "3599999" },
        "interval_ms",
        "Enter a whole number from 3600000 to 2147483647 ms.",
      ],
      [
        { ...http, interval_ms: "" },
        "interval_ms",
        "Enter a whole number from 1 to 2147483647 ms.",
      ],
      [
        { ...http, interval_ms: "0" },
        "interval_ms",
        "Enter a whole number from 1 to 2147483647 ms.",
      ],
      [
        { ...http, interval_ms: "1.5" },
        "interval_ms",
        "Enter a whole number from 1 to 2147483647 ms.",
      ],
      [
        { ...http, interval_ms: "2147483648" },
        "interval_ms",
        "Enter a whole number from 1 to 2147483647 ms.",
      ],
      [{ ...http, timeout_ms: "0" }, "timeout_ms", "Enter a whole number from 1 to 2147483647 ms."],
      [{ ...http, retries: "11" }, "retries", "Enter a whole number from 0 to 10."],
      [
        { ...tcp, retry_delay_ms: "60001" },
        "retry_delay_ms",
        "Enter a whole number from 0 to 60000 ms.",
      ],
      [{ ...tcp, port: "" }, "port", "Enter a whole number from 1 to 65535."],
      [{ ...tls, port: "65536" }, "port", "Enter a whole number from 1 to 65535."],
      [{ ...tls, warn_days: "3651" }, "warn_days", "Enter a whole number from 0 to 3650."],
      [
        { ...heartbeat, period_ms: "999" },
        "period_ms",
        "Enter a whole number from 1000 to 86400000 ms.",
      ],
      [
        { ...heartbeat, grace_ms: "86400001" },
        "grace_ms",
        "Enter a whole number from 0 to 86400000 ms.",
      ],
    ];
    for (const [fields, field, message] of cases) {
      expect(errorOn(parseCreateForm(fields), field)).toBe(message);
    }
    expect(inputOf(parseCreateForm({ ...domain, interval_ms: "3600000" }))).toMatchObject({
      intervalMs: 3600000,
    });
  });

  test("ids, names and keyword", () => {
    const idText =
      "Use 1 to 100 letters, digits, dots, underscores or hyphens, starting with a letter or digit.";
    for (const id of ["my check", "a/b", "", ".", "..", "-a", "a".repeat(101)]) {
      expect(errorOn(parseCreateForm({ ...http, id }), "id")).toBe(idText);
    }
    expect(inputOf(parseCreateForm({ ...http, id: "a.b_c-1" }))).toMatchObject({ id: "a.b_c-1" });
    const nameText = "Enter a name of 1 to 200 characters without control characters.";
    for (const name of ["", "   ", "a\u0007b", "a".repeat(201)]) {
      expect(errorOn(parseCreateForm({ ...http, name }), "name")).toBe(nameText);
    }
    expect(inputOf(parseCreateForm({ ...http, keyword: "" }))).toEqual({
      id: "web",
      name: "Web",
      url: "https://example.com/",
      method: "GET",
      intervalMs: 1500,
    });
  });

  test("method, body and assertions", () => {
    expect(
      errorOn(
        parseCreateForm({
          ...http,
          method: "HEAD",
          assert_0_mode: "exists",
          assert_0_pointer: "/a",
        }),
        "method",
      ),
    ).toBe("HEAD reads no body, so it allows no keyword and no JSON assertion.");
    expect(
      errorOn(parseCreateForm({ ...http, method: "HEAD", keyword: "ok" }), "method"),
    ).toBeDefined();
    expect(errorOn(parseCreateForm({ ...http, method: "GET", body: "x" }), "body")).toBe(
      "A body needs POST, PUT, PATCH, DELETE or OPTIONS.",
    );
    expect(errorOn(parseCreateForm({ ...http, method: "TRACE" }), "method")).toBe(
      "Choose a method.",
    );
    expect(
      errorOn(
        parseCreateForm({ ...http, assert_3_mode: "equals", assert_3_equals: "ok" }),
        "assert_3_equals",
      ),
    ).toBe('Enter a JSON value, for example "ok", 200 or true.');
    expect(
      errorOn(
        parseCreateForm({ ...http, assert_0_mode: "exists", assert_0_pointer: "status" }),
        "assert_0_pointer",
      ),
    ).toBe("Enter a JSON pointer such as /status, or leave it empty for the whole body.");
    expect(errorOn(parseCreateForm({ ...http, assert_0_mode: "maybe" }), "assert_0_mode")).toBe(
      "Choose No check, Exists or Equals.",
    );
    expect(
      inputOf(
        parseCreateForm({
          ...http,
          assert_9_mode: "equals",
          assert_9_equals: '{"n":[1,true,null]}',
        }),
      ),
    ).toMatchObject({
      jsonAssert: [{ pointer: "", equals: { n: [1, true, null] } }],
    });
    expect(errorOn(parseCreateForm({ ...http, url: "ftp://example.com/" }), "url")).toBe(
      "Enter an http:// or https:// URL without a user name or password.",
    );
    expect(
      errorOn(parseCreateForm({ ...http, url: "https://u:p@example.com/" }), "url"),
    ).toBeDefined();
    expect(errorOn(parseCreateForm({ ...http, type: "ping" }), "type")).toBe("Choose a type.");
  });

  test("dns record, expected and resolver", () => {
    expect(errorOn(parseCreateForm({ ...dns, record_type: "SRV" }), "record_type")).toBe(
      "Choose a record type.",
    );
    expect(errorOn(parseCreateForm({ ...dns, record_type: "" }), "record_type")).toBe(
      "Choose a record type.",
    );
    const lines = Array.from({ length: 21 }, (_, i) => `v${i}`).join("\n");
    expect(errorOn(parseCreateForm({ ...dns, expected: lines }), "expected")).toBe(
      "Enter at most 20 values.",
    );
    expect(errorOn(parseCreateForm({ ...dns, resolver: "1.2.3.4:53" }), "resolver")).toBe(
      "pulse-api does not accept this value: it must be an IPv4 or IPv6 address without port.",
    );
    expect(inputOf(parseCreateForm({ ...dns, resolver: "127.0.0.53" }))).toMatchObject({
      resolver: "127.0.0.53",
    });
    expect(errorOn(parseCreateForm({ ...dns, dns_name: "a b" }), "dns_name")).toBe(
      "pulse-api does not accept this value: it must be a hostname without scheme, port or path.",
    );
  });

  test("heartbeat secret", () => {
    const secretText =
      "Enter 16 to 128 letters, digits or the characters . _ ~ -, not starting with replace-with-.";
    expect(errorOn(parseCreateForm({ ...heartbeat, secret: "" }), "secret")).toBe(
      "Enter a secret.",
    );
    for (const secret of [
      "a".repeat(15),
      "a".repeat(129),
      "abcdefghijklmnop!",
      "replace-with-abcdefghij",
    ]) {
      expect(errorOn(parseCreateForm({ ...heartbeat, secret }), "secret")).toBe(secretText);
    }
    for (const secret of ["a".repeat(16), "a".repeat(128), "A-z0.9_~-aaaaaaaaaaa"]) {
      expect(inputOf(parseCreateForm({ ...heartbeat, secret }))).toMatchObject({ secret });
    }
  });
});

describe("header rows", () => {
  test("a free row named exactly __proto__ is a field error; __Proto__ and X-Proto are own keys", () => {
    expect(
      errorOn(
        parseCreateForm({ ...http, header_2_name: "__proto__", header_2_value: "x" }),
        "header_2_name",
      ),
    ).toBe(PROTO);
    const input = inputOf(
      parseCreateForm({
        ...http,
        header_0_name: "__Proto__",
        header_0_value: "x",
        header_1_name: "X-Proto",
        header_1_value: "y",
      }),
    );
    expect(JSON.stringify(input)).toBe(
      '{"id":"web","name":"Web","url":"https://example.com/","method":"GET","intervalMs":1500,"headers":{"__Proto__":"x","X-Proto":"y"}}',
    );
  });

  test("the __proto__ rule runs before the duplicate rule", () => {
    const result = parseCreateForm({
      ...http,
      header_0_name: "__proto__",
      header_0_value: "x",
      header_1_name: "__proto__",
      header_1_value: "y",
    });
    expect(errorOn(result, "header_0_name")).toBe(PROTO);
    expect(errorOn(result, "header_1_name")).toBe(PROTO);
  });

  test("free rows Accept and ACCEPT are a duplicate on the later row", () => {
    const result = parseCreateForm({
      ...http,
      header_0_name: "Accept",
      header_0_value: "a",
      header_1_name: "ACCEPT",
      header_1_value: "b",
    });
    expect(errorOn(result, "header_1_name")).toBe(DUPLICATE);
    expect(errorOn(result, "header_0_name")).toBeUndefined();
  });

  test("other row checks", () => {
    const cases: [Fields, string, string][] = [
      [{ header_0_value: "x" }, "header_0_name", "Enter a header name."],
      [
        { header_0_name: "Bad Name", header_0_value: "x" },
        "header_0_name",
        "Enter a header name of 1 to 256 letters, digits or the characters !#$%&'*+.^_`|~-.",
      ],
      [
        { header_0_name: "Host", header_0_value: "x" },
        "header_0_name",
        "The probe sets this header itself.",
      ],
      [
        { header_0_name: "X-A", header_0_value: "a\nb" },
        "header_0_value",
        "Enter at most 4096 visible ASCII characters or spaces.",
      ],
      [
        { header_0_name: "X-A", header_0_kind: "env", header_0_value: "TOKEN" },
        "header_0_value",
        "Enter a variable name that starts with PULSE_HEADER_, then letters, digits or _.",
      ],
      [
        { header_0_name: "X-A", header_0_kind: "file", header_0_value: "x" },
        "header_0_kind",
        "Choose Plain value or Secret from the probe environment.",
      ],
    ];
    for (const [rows, field, message] of cases) {
      expect(errorOn(parseCreateForm({ ...http, ...rows }), field)).toBe(message);
    }
    expect(
      inputOf(parseCreateForm({ ...http, header_19_name: "", header_19_value: "" })),
    ).not.toHaveProperty("headers");
  });
});

const view: AdminCheckView = {
  id: "web",
  name: "Web",
  source: "database",
  url: "https://example.com/",
  method: "POST",
  intervalMs: 1500,
  retries: 0,
  retryDelayMs: 1000,
  headers: { "X-Api-Key": { keep: true }, Authorization: { env: "PULSE_HEADER_TOKEN" } },
  body: { keep: true },
};

// The edit form as the page renders it: stored literal row 0, env row filled in as free row 1.
const editFields: Fields = {
  name: "Web renamed",
  url: "https://example.com/",
  method: "POST",
  interval_ms: "1500",
  retries: "0",
  retry_delay_ms: "1000",
  header_1_name: "Authorization",
  header_1_kind: "env",
  header_1_value: "PULSE_HEADER_TOKEN",
};

const keptInput = {
  id: "web",
  name: "Web renamed",
  url: "https://example.com/",
  method: "POST",
  intervalMs: 1500,
  retries: 0,
  retryDelayMs: 1000,
  headers: { "X-Api-Key": { keep: true }, Authorization: { env: "PULSE_HEADER_TOKEN" } },
  body: { keep: true },
};

describe("parseEditForm with a trusted view", () => {
  test("an edit of the name keeps the stored literal header and body", () => {
    expect(inputOf(parseEditForm(editFields, view))).toEqual(keptInput);
  });

  test("forged type, id, stored row name and kind are ignored", () => {
    const forged = {
      ...editFields,
      type: "tcp",
      id: "other",
      host: "evil.example",
      port: "1",
      header_0_name: "X-Evil",
      header_0_kind: "env",
      header_0_intent: "keep",
    };
    const input = inputOf(parseEditForm(forged, view));
    expect(input).toEqual(keptInput);
    expect(JSON.stringify(input)).not.toContain("X-Evil");
  });

  test("intents of a stored header", () => {
    expect(
      inputOf(
        parseEditForm({ ...editFields, header_0_intent: "replace", header_0_value: "v2" }, view),
      ),
    ).toEqual({
      ...keptInput,
      headers: { "X-Api-Key": "v2", Authorization: { env: "PULSE_HEADER_TOKEN" } },
    });
    expect(inputOf(parseEditForm({ ...editFields, header_0_intent: "remove" }, view))).toEqual({
      ...keptInput,
      headers: { Authorization: { env: "PULSE_HEADER_TOKEN" } },
    });
    expect(
      errorOn(parseEditForm({ ...editFields, header_0_intent: "replace" }, view), "header_0_value"),
    ).toBe("Enter the new value, or choose Remove.");
    expect(
      errorOn(parseEditForm({ ...editFields, header_0_value: "typed" }, view), "header_0_value"),
    ).toBe("Choose Replace to use the new value.");
    expect(
      errorOn(parseEditForm({ ...editFields, header_0_intent: "drop" }, view), "header_0_intent"),
    ).toBe("Choose Keep, Replace or Remove.");
  });

  test("intents of a stored body", () => {
    expect(
      inputOf(parseEditForm({ ...editFields, body_intent: "replace", body: "new" }, view)),
    ).toEqual({
      ...keptInput,
      body: "new",
    });
    const withoutBody: Record<string, unknown> = { ...keptInput };
    delete withoutBody.body;
    expect(inputOf(parseEditForm({ ...editFields, body_intent: "remove" }, view))).toEqual(
      withoutBody,
    );
    expect(errorOn(parseEditForm({ ...editFields, body_intent: "replace" }, view), "body")).toBe(
      "Enter the new value, or choose Remove.",
    );
    expect(errorOn(parseEditForm({ ...editFields, body: "typed" }, view), "body")).toBe(
      "Choose Replace to use the new value.",
    );
    expect(errorOn(parseEditForm({ ...editFields, method: "GET" }, view), "body")).toBe(
      "A body needs POST, PUT, PATCH, DELETE or OPTIONS.",
    );
    expect(errorOn(parseEditForm({ ...editFields, method: "HEAD" }, view), "body")).toBe(
      "A body needs POST, PUT, PATCH, DELETE or OPTIONS.",
    );
  });

  test("duplicates against stored rows are refused before any object is built", () => {
    const cases: Fields[] = [
      { header_2_name: "X-Api-Key", header_2_kind: "plain", header_2_value: "new" },
      { header_2_name: "x-api-key", header_2_kind: "plain", header_2_value: "new" },
      { header_2_name: "authorization", header_2_kind: "plain", header_2_value: "new" },
    ];
    for (const rows of cases) {
      expect(errorOn(parseEditForm({ ...editFields, ...rows }, view), "header_2_name")).toBe(
        DUPLICATE,
      );
    }
    expect(
      errorOn(
        parseEditForm(
          {
            ...editFields,
            header_0_intent: "replace",
            header_0_value: "v2",
            header_2_name: "X-API-KEY",
            header_2_value: "n",
          },
          view,
        ),
        "header_2_name",
      ),
    ).toBe(DUPLICATE);
  });

  test("the duplicate-name counterexample of the spec", () => {
    const stored: AdminCheckView = { ...view, headers: { "X-Api-Key": { keep: true } } };
    const base: Fields = {
      ...editFields,
      header_1_name: "",
      header_1_kind: "",
      header_1_value: "",
    };
    for (const name of ["X-Api-Key", "x-api-key"]) {
      const result = parseEditForm(
        {
          ...base,
          header_0_intent: "keep",
          header_1_name: name,
          header_1_kind: "plain",
          header_1_value: "new",
        },
        stored,
      );
      expect(result.isOk).toBe(false);
      expect(errorOn(result, "header_1_name")).toBe(DUPLICATE);
    }
    const switched = inputOf(
      parseEditForm(
        {
          ...base,
          header_0_intent: "remove",
          header_1_name: "X-Api-Key",
          header_1_kind: "env",
          header_1_value: "PULSE_HEADER_KEY",
        },
        stored,
      ),
    );
    expect(switched).toMatchObject({ headers: { "X-Api-Key": { env: "PULSE_HEADER_KEY" } } });
    expect(JSON.stringify(switched)).toContain(
      '"headers":{"X-Api-Key":{"env":"PULSE_HEADER_KEY"}}',
    );
  });

  test("heartbeat secret intents", () => {
    const stored: AdminCheckView = {
      id: "nightly-backup",
      name: "Nightly backup",
      type: "heartbeat",
      period: 86400000,
      grace: 0,
      source: "database",
      hasSecret: true,
    };
    const fields: Fields = { name: "Backup", period_ms: "3600000", grace_ms: "60000" };
    const kept = {
      id: "nightly-backup",
      name: "Backup",
      type: "heartbeat",
      period: 3600000,
      grace: 60000,
    };
    expect(inputOf(parseEditForm(fields, stored))).toEqual(kept);
    expect(inputOf(parseEditForm({ ...fields, secret_intent: "keep" }, stored))).toEqual(kept);
    expect(
      errorOn(parseEditForm({ ...fields, secret: "abcdefghijklmnop" }, stored), "secret"),
    ).toBe("Choose Replace to use the new value.");
    expect(
      inputOf(
        parseEditForm({ ...fields, secret_intent: "replace", secret: "abcdefghijklmnopq" }, stored),
      ),
    ).toEqual({
      ...kept,
      secret: "abcdefghijklmnopq",
    });
    expect(errorOn(parseEditForm({ ...fields, secret_intent: "replace" }, stored), "secret")).toBe(
      "Enter a secret.",
    );
  });

  test("a tcp view stays tcp whatever type is posted", () => {
    const stored: AdminCheckView = {
      id: "db",
      name: "DB",
      type: "tcp",
      host: "db.internal",
      port: 5432,
      intervalMs: 30000,
      retries: 0,
      retryDelayMs: 1000,
      source: "database",
    };
    expect(
      inputOf(
        parseEditForm(
          {
            type: "http",
            url: "https://x/",
            name: "DB",
            host: "db.internal",
            port: "5432",
            interval_ms: "30000",
          },
          stored,
        ),
      ),
    ).toEqual({
      id: "db",
      name: "DB",
      type: "tcp",
      host: "db.internal",
      port: 5432,
      intervalMs: 30000,
    });
  });
});

describe("JSON pointers are exact strings", () => {
  const POINTER_TEXT =
    "Enter a JSON pointer such as /status, or leave it empty for the whole body.";
  const spaced: AdminCheckView = {
    id: "web",
    name: "Web",
    source: "database",
    url: "https://example.com/",
    intervalMs: 1500,
    jsonAssert: [
      { pointer: "/status ", equals: "ok" },
      { pointer: "/ready ", exists: true },
    ],
  };

  test("a name-only edit through editInputOf keeps stored pointers with spaces", () => {
    const fields = { ...editInputOf(spaced).values, name: "Web shop 2" };
    const result = parseEditForm(fields, spaced);
    expect(result.isOk && result.input.jsonAssert).toEqual([
      { pointer: "/status ", equals: "ok" },
      { pointer: "/ready ", exists: true },
    ]);
  });

  test("create keeps a pointer with inner and trailing whitespace", () => {
    const input = inputOf(
      parseCreateForm({ ...http, assert_0_pointer: "/a b\t", assert_0_mode: "exists" }),
    );
    expect(input).toHaveProperty("jsonAssert", [{ pointer: "/a b\t", exists: true }]);
  });

  test("a leading space or only spaces is a field error", () => {
    for (const pointer of [" /status", "   "]) {
      const posted = { ...http, assert_0_pointer: pointer, assert_0_mode: "exists" };
      expect(errorOn(parseCreateForm(posted), "assert_0_pointer")).toBe(POINTER_TEXT);
    }
  });

  test("an empty pointer checks the whole body and mode none ignores the pointer", () => {
    expect(
      inputOf(parseCreateForm({ ...http, assert_0_pointer: "", assert_0_mode: "exists" })),
    ).toHaveProperty("jsonAssert", [{ pointer: "", exists: true }]);
    expect(
      inputOf(parseCreateForm({ ...http, assert_0_pointer: "/x ", assert_0_mode: "none" })),
    ).not.toHaveProperty("jsonAssert");
  });

  test("other text fields are still trimmed", () => {
    const input = inputOf(
      parseCreateForm({ ...http, name: " Web shop 2 ", url: " https://example.com/ " }),
    );
    expect(input).toHaveProperty("name", "Web shop 2");
    expect(input).toHaveProperty("url", "https://example.com/");
  });
});
