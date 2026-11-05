import { afterEach, describe, expect, test } from "bun:test";
import {
  checkWithState,
  emptyConfig,
  type FakeApi,
  type FakeReply,
  jsonReply,
  startFakeApi,
  UPSTREAM_SENTINEL,
  WIRE_HEADERS,
} from "../test/fake-api.ts";
import {
  getPage,
  type SignedInConsole,
  type SignedInOptions,
  startSignedInConsole,
} from "../test/signed-in-console.ts";

const TOKEN = "overview-admin-token-sentinel-0123456789";
const UNREACHABLE = "pulse-api cannot be reached";
const UNUSABLE = "pulse-api sent an answer the console cannot use";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function fakeApi(): FakeApi {
  const api = startFakeApi();
  cleanups.push(() => api.stop());
  return api;
}

async function consoleFor(
  apiUrl: string,
  options: Partial<SignedInOptions> = {},
): Promise<SignedInConsole> {
  const c = await startSignedInConsole({ apiUrl, adminToken: TOKEN, ...options });
  cleanups.push(() => c.close());
  return c;
}

// The console takes `typeof fetch`, so a fake keeps Bun's `preconnect`.
function fakeFetch(
  fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(fn, { preconnect: fetch.preconnect });
}

function checksOf(...states: string[]): FakeReply {
  return jsonReply(states.map((s, i) => checkWithState(`c${i}`, s)));
}

function expectClean(c: SignedInConsole, body: string): void {
  for (const text of [body, ...c.logs]) {
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(UPSTREAM_SENTINEL);
  }
}

describe("GET / Overview summary", () => {
  const rows: Array<[string, string[], string, string]> = [
    ["success", ["up", "up"], "Overall state: Up. All checks are up.", "Up: 2"],
    [
      "mixed",
      ["degraded", "down", "up"],
      "Overall state: Down. At least one check is down.",
      "Down: 1",
    ],
    [
      "all unknown",
      ["unknown", "unknown"],
      "Overall state: Unknown. At least one check has no result yet.",
      "Unknown: 2",
    ],
    [
      "all maintenance",
      ["maintenance"],
      "Overall state: Maintenance. Some checks are in maintenance, the others are up.",
      "Maintenance: 1",
    ],
  ];
  for (const [name, states, overall, count] of rows) {
    test(name, async () => {
      const api = fakeApi();
      api.reply("/admin/config", jsonReply(emptyConfig));
      api.reply("/checks", checksOf(...states));
      const c = await consoleFor(api.url);
      const res = await getPage(c, "/");
      expect(res.status).toBe(200);
      expect(res.body).toContain(overall);
      expect(res.body).toContain(count);
      expect(res.body).toContain(`pulse-api: ${api.url}`);
      expect(res.body).toContain("Signed in as Owner (owner@example.com)");
      expect(res.body).toContain('<a href="/" aria-current="page">Overview</a>');
      expectClean(c, res.body);
    });
  }

  test("mixed counts in order with Total", async () => {
    const api = fakeApi();
    api.reply("/admin/config", jsonReply(emptyConfig));
    api.reply("/checks", checksOf("down", "down", "up"));
    const c = await consoleFor(api.url);
    const res = await getPage(c, "/");
    expect(res.body).toContain(
      "<li>Down: 2</li>\n<li>Degraded: 0</li>\n<li>Unknown: 0</li>\n<li>Maintenance: 0</li>\n<li>Up: 1</li>\n<li>Total: 3</li>",
    );
  });

  test("empty", async () => {
    const api = fakeApi();
    api.reply("/admin/config", jsonReply(emptyConfig));
    api.reply("/checks", jsonReply([]));
    const c = await consoleFor(api.url);
    const res = await getPage(c, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("No checks yet");
    expect(res.body).toContain(
      "pulse-api has no active checks. Add a check in pulse-api, then reload this page.",
    );
    expect(res.body).toContain('<a href="/">Reload</a>');
  });

  test("authorization: Bearer on /admin/config, none on /checks", async () => {
    const api = fakeApi();
    api.reply("/admin/config", jsonReply(emptyConfig));
    api.reply("/checks", checksOf("up"));
    const c = await consoleFor(api.url);
    await getPage(c, "/");
    const byPath = Object.fromEntries(api.seen.map((s) => [s.path, s.authorization]));
    expect(byPath).toEqual({ "/admin/config": `Bearer ${TOKEN}`, "/checks": null });
  });

  test("a corrected api makes the next GET / show the summary", async () => {
    const api = fakeApi();
    api.reply("/admin/config", jsonReply(emptyConfig));
    api.reply("/checks", { status: 503 });
    const c = await consoleFor(api.url);
    const first = await getPage(c, "/");
    expect(first.body).toContain("pulse-api answered 503.");
    api.reply("/checks", checksOf("up"));
    const second = await getPage(c, "/");
    expect(second.body).toContain("Overall state: Up. All checks are up.");
    expect(second.body).not.toContain(UNREACHABLE);
  });
});

describe("GET / Overview failures", () => {
  const big = jsonReply([]);
  big.body = `[${" ".repeat(6 * 1024 * 1024)}]`;
  const rows: Array<{
    name: string;
    config?: FakeReply;
    checks?: FakeReply;
    heading: string;
    kind?: string;
    text: string;
    log: string;
  }> = [
    {
      name: "config 403",
      kind: "status 403",
      config: { status: 403 },
      heading: UNREACHABLE,
      text: "The console token lacks the read or checks scope.",
      log: '"call":"config","kind":"http","status":403',
    },
    {
      name: "config 429",
      kind: "status 429",
      config: { status: 429 },
      heading: UNREACHABLE,
      text: "pulse-api is throttling the console. Try again in a minute.",
      log: '"call":"config","kind":"http","status":429',
    },
    {
      name: "checks 503",
      kind: "status 503",
      checks: { status: 503 },
      heading: UNREACHABLE,
      text: "pulse-api answered 503.",
      log: '"call":"checks","kind":"http","status":503',
    },
    {
      name: "missing header",
      checks: { status: 200, body: "[]", headers: { "content-type": "application/json" } },
      heading: UNUSABLE,
      text: "pulse-api sent no x-pulse-contract header.",
      log: '"call":"checks","kind":"missing-header"',
    },
    {
      name: "wrong wire version",
      checks: { status: 200, body: "[]", headers: { ...WIRE_HEADERS, "x-pulse-contract": "2" } },
      heading: UNUSABLE,
      text: "pulse-api speaks wire version 2; this console needs 1.",
      log: '"call":"checks","kind":"wire-mismatch"',
    },
    {
      name: "6 MiB body",
      checks: big,
      heading: UNUSABLE,
      text: "pulse-api sent an invalid answer.",
      log: '"call":"checks","kind":"too-large"',
    },
    {
      name: "invalid JSON",
      checks: { status: 200, body: "{not json", headers: WIRE_HEADERS },
      heading: UNUSABLE,
      text: "pulse-api sent an invalid answer.",
      log: '"call":"checks","kind":"invalid-json"',
    },
    {
      name: "invalid shape",
      checks: jsonReply({ checks: "no" }),
      heading: UNUSABLE,
      text: "pulse-api sent an invalid answer.",
      log: '"call":"checks","kind":"validation"',
    },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const api = fakeApi();
      api.reply("/admin/config", row.config ?? jsonReply(emptyConfig));
      api.reply("/checks", row.checks ?? checksOf("up"));
      const c = await consoleFor(api.url);
      const res = await getPage(c, "/");
      expect(res.status).toBe(200);
      expect(res.body).toContain(row.heading);
      expect(res.body).toContain(row.text);
      if (row.kind === undefined) {
        expect(res.body).not.toContain("Kind:");
      } else {
        expect(res.body).toContain(`<p>Kind: ${row.kind}</p>`);
      }
      expect(res.body).not.toContain("5 seconds");
      expect(res.body).toContain('<a href="/">Retry</a>');
      expect(res.body).not.toContain("Overall state");
      const warn = c.logs.filter((l) => l.includes("api read failed"));
      expect(warn).toHaveLength(1);
      expect(warn[0]).toContain(row.log);
      expectClean(c, res.body);
    });
  }

  test("config 401 shows the token banner and keeps the session", async () => {
    const api = fakeApi();
    api.reply("/admin/config", { status: 401 });
    api.reply("/checks", checksOf("up"));
    const c = await consoleFor(api.url);
    const res = await getPage(c, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("pulse-api rejected the console token");
    expect(res.body).toContain(
      "Set a valid token in PULSE_CONSOLE_ADMIN_TOKEN or PULSE_CONSOLE_ADMIN_TOKEN_FILE and restart the console.",
    );
    expect(res.body).not.toContain("Overall state");
    expect(res.body).not.toContain("Kind:");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await getPage(c, "/")).status).toBe(200);
    expectClean(c, res.body);
  });

  test("a deadline fired after the request arrived shows Kind: timeout", async () => {
    const api = fakeApi();
    api.reply("/admin/config", jsonReply(emptyConfig));
    api.reply("/checks", { status: 200, isHeld: true });
    const delays: number[] = [];
    const pending = new Set<() => void>();
    const schedule = (fn: () => void, ms: number): (() => void) => {
      delays.push(ms);
      pending.add(fn);
      return () => pending.delete(fn);
    };
    const c = await consoleFor(api.url, { schedule });
    const page = getPage(c, "/");
    await api.received("/checks");
    // The config read may still be open here; wait until only the held read keeps its timer.
    while (pending.size > 1) await new Promise((resolve) => setImmediate(resolve));
    for (const fn of pending) fn();
    const res = await page;
    expect(res.status).toBe(200);
    expect(res.body).toContain("<p>Kind: timeout</p>");
    expect(res.body).toContain("pulse-api did not answer within 5 seconds.");
    expect(delays).toEqual([5000, 5000]);
    const warn = c.logs.filter((l) => l.includes("api read failed"));
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain('"call":"checks","kind":"timeout"');
  });

  test("closed port shows Kind: connection refused, no 5 seconds, and Retry recovers", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const url = `http://127.0.0.1:${closed.port}`;
    await closed.stop(true);
    const live = fakeApi();
    live.reply("/admin/config", jsonReply(emptyConfig));
    live.reply("/checks", checksOf("up"));
    const target = { current: url };
    const c = await consoleFor(url, {
      fetch: fakeFetch((input, init) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        return fetch(`${target.current}${path}`, init);
      }),
    });
    const res = await getPage(c, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain(UNREACHABLE);
    expect(res.body).toContain("<p>Kind: connection refused</p>");
    expect(res.body).toContain(
      `The connection to ${url} was refused. Check that pulse-api is running at this address.`,
    );
    expect(res.body).not.toContain("5 seconds");
    expect(res.body).toContain('<a href="/">Retry</a>');
    const warn = c.logs.filter((l) => l.includes("api read failed"));
    expect(warn).toHaveLength(2);
    expect(warn[0]).toContain('"call":"config","kind":"network"');
    expect(warn[1]).toContain('"call":"checks","kind":"network"');
    for (const line of warn) {
      expect(line).not.toContain("status");
      expect(line).not.toContain("ConnectionRefused");
      expect(line).not.toContain("127.0.0.1");
    }
    target.current = live.url;
    const retry = await getPage(c, "/");
    expect(retry.body).toContain("Overall state: Up. All checks are up.");
    expect(retry.body).not.toContain("Kind:");
  });

  test("fetch rejections are classified by own code only, never by message or getter", async () => {
    const calls = { count: 0 };
    const getterCause = new TypeError("getter-sentinel");
    Object.defineProperty(getterCause, "code", {
      get: () => {
        calls.count += 1;
        return "ECONNREFUSED";
      },
    });
    const rows: Array<[unknown, string]> = [
      [new TypeError("x", { cause: { code: "ECONNREFUSED" } }), "connection refused"],
      [new TypeError("x", { cause: { cause: { code: "ECONNREFUSED" } } }), "network error"],
      [new TypeError("ECONNREFUSED connection refused sentinel"), "network error"],
      [Object.create({ code: "ECONNREFUSED" }), "network error"],
      [{ code: "ENOTFOUND" }, "network error"],
      [getterCause, "network error"],
    ];
    for (const [rejection, kind] of rows) {
      const c = await consoleFor("http://127.0.0.1:9", {
        fetch: fakeFetch(() => Promise.reject(rejection)),
      });
      const res = await getPage(c, "/");
      expect(res.status).toBe(200);
      expect(res.body).toContain(`<p>Kind: ${kind}</p>`);
      for (const text of [res.body, ...c.logs]) {
        expect(text).not.toContain("sentinel");
        expect(text).not.toContain("ECONNREFUSED");
      }
    }
    expect(calls.count).toBe(0);
  });

  test("302: the redirect target gets 0 requests", async () => {
    const target = fakeApi();
    const api = fakeApi();
    api.reply("/admin/config", { status: 302, headers: { location: `${target.url}/x` } });
    api.reply("/checks", checksOf("up"));
    const c = await consoleFor(api.url);
    const res = await getPage(c, "/");
    expect(res.body).toContain(
      "pulse-api answered with a redirect (302); redirects are not followed.",
    );
    expect(target.seen).toHaveLength(0);
  });

  test("no admin token: the api gets 0 requests", async () => {
    const api = fakeApi();
    const c = await consoleFor(api.url, { adminToken: undefined });
    const res = await getPage(c, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain(
      "The console has no pulse-api token. Set PULSE_CONSOLE_ADMIN_TOKEN_FILE and restart the console.",
    );
    expect(api.seen).toHaveLength(0);
  });
});
