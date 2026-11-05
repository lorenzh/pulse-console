import { afterAll, describe, expect, test } from "bun:test";
import { selfToken } from "../test/token-fixtures.ts";
import { type ConnectionTestDeps, type FetchLike, testConnection } from "./connection-test.ts";

const TOKEN = "console-test-token-0123456789abcdefghij";
const SENTINEL = "upstream-body-sentinel-7f3a";
const REVISION = `sha256-${"a".repeat(64)}`;

const httpCheck = (id: string): Record<string, unknown> => ({
  id,
  name: id.toUpperCase(),
  url: "https://example.com",
  intervalMs: 60000,
});

const configBody = (count: number): string =>
  JSON.stringify({
    revision: REVISION,
    checks: ["a", "b", "c"].slice(0, count).map(httpCheck),
    components: [],
    maintenance: [],
  });

// Counterexamples 40-42: literal `GET /admin/config` answers of a 1.x and a 2.0.0 api.
const config1x = {
  revision: `sha256-${"1".repeat(64)}`,
  checks: [
    {
      id: "a",
      name: "A",
      url: "https://a.test",
      intervalMs: 1000,
      method: "POST",
      headers: ["authorization"],
      hasBody: true,
    },
    { id: "b", name: "B", url: "https://b.test", intervalMs: 1000 },
  ],
  components: [],
  maintenance: [],
};
const config200 = {
  revision: `sha256-${"2".repeat(64)}`,
  checks: [
    {
      id: "a",
      name: "A",
      url: "https://a.test",
      intervalMs: 1000,
      method: "POST",
      headers: { authorization: { keep: true } },
      body: { keep: true },
      source: "database",
    },
    { id: "b", name: "B", url: "https://b.test", intervalMs: 1000, source: "file" },
    {
      id: "h",
      name: "H",
      type: "heartbeat",
      period: 1000,
      grace: 0,
      hasSecret: true,
      source: "file",
    },
  ],
  shadowed: [
    { id: "b", name: "B db", url: "https://b.test", intervalMs: 1000, source: "database" },
  ],
  components: [],
  maintenance: [],
  file: { state: "invalid", message: "checks[0].url: is required", lastAppliedAt: 7 },
};
const literalConfig = (body: unknown): Reply => ({
  status: 200,
  body: JSON.stringify(body),
  headers: wire1,
});

type Reply = { status: number; body?: string; headers?: Record<string, string> };
type Seen = { path: string; authorization: string | null };

const wire1 = { "x-pulse-contract": "1", "content-type": "application/json" };
const okConfig = (count = 3): Reply => ({ status: 200, body: configBody(count), headers: wire1 });
const okTokens: Reply = { status: 200, body: JSON.stringify({ tokens: [] }), headers: wire1 };

const selfMissing: Reply = { status: 404 };
const okSelf: Reply = { status: 200, body: JSON.stringify(selfToken()), headers: wire1 };

type FakeApi = {
  url: string;
  seen: Seen[];
  /** `self` defaults to `404`, an api older than the self route, so `tokens` is the fallback. */
  set: (config: Reply, tokens?: Reply, self?: Reply) => void;
};
const servers: { stop: (force: boolean) => unknown }[] = [];

function replyName(path: string): "config" | "self" | "tokens" {
  if (path.endsWith("/admin/config")) return "config";
  return path.endsWith("/admin/tokens/self") ? "self" : "tokens";
}

function startApi(): FakeApi {
  const seen: Seen[] = [];
  const replies: Record<string, Reply> = {};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ path, authorization: req.headers.get("authorization") });
      const name = replyName(path);
      const reply = replies[name] ?? { status: 500 };
      return new Response(reply.body ?? SENTINEL, {
        status: reply.status,
        headers: reply.headers ?? {},
      });
    },
  });
  servers.push(server);
  return {
    url: `http://127.0.0.1:${server.port}`,
    seen,
    set(config, tokens = okTokens, self = selfMissing) {
      seen.length = 0;
      replies.config = config;
      replies.tokens = tokens;
      replies.self = self;
    },
  };
}

afterAll(() => {
  for (const server of servers) {
    server.stop(true);
  }
});

type Recorded = { url: string; redirect: RequestInit["redirect"] };

function recordingDeps(): { deps: ConnectionTestDeps; calls: Recorded[]; timeouts: number[] } {
  const calls: Recorded[] = [];
  const timeouts: number[] = [];
  const fetchFn: FetchLike = (input, init) => {
    calls.push({ url: String(input), redirect: init?.redirect });
    return fetch(input, init);
  };
  const schedule = (_fn: () => void, ms: number): (() => void) => {
    timeouts.push(ms);
    return () => undefined;
  };
  return { deps: { fetch: fetchFn, token: TOKEN, schedule }, calls, timeouts };
}

const api = startApi();
const target = startApi();

describe("testConnection success", () => {
  test("calls config then self with bearer, manual redirect and 5 s timeout", async () => {
    api.set(okConfig(3), okTokens, okSelf);
    const { deps, calls, timeouts } = recordingDeps();
    const result = await testConnection(api.url, deps);
    expect(result).toEqual({
      isOk: true,
      wireVersion: 1,
      checkCount: 3,
      adminScope: "confirmed",
    });
    expect(api.seen).toEqual([
      { path: "/admin/config", authorization: `Bearer ${TOKEN}` },
      { path: "/admin/tokens/self", authorization: `Bearer ${TOKEN}` },
    ]);
    expect(calls.map((c) => c.redirect)).toEqual(["manual", "manual"]);
    expect(timeouts).toEqual([5000, 5000]);
  });

  test("self 404 falls back to the token list: 200 confirms", async () => {
    api.set(okConfig(3), okTokens, selfMissing);
    expect(await testConnection(api.url, recordingDeps().deps)).toEqual({
      isOk: true,
      wireVersion: 1,
      checkCount: 3,
      adminScope: "confirmed",
    });
    expect(api.seen.map((s) => s.path)).toEqual([
      "/admin/config",
      "/admin/tokens/self",
      "/admin/tokens",
    ]);
  });

  test("a self answer that fails validation is an invalid answer, with no fallback", async () => {
    api.set(okConfig(3), okTokens, {
      status: 200,
      body: JSON.stringify({ ...selfToken(), secret: SENTINEL }),
      headers: wire1,
    });
    const result = await testConnection(api.url, recordingDeps().deps);
    expect(result).toEqual({ isOk: false, text: "pulse-api sent an invalid answer." });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(api.seen.map((s) => s.path)).toEqual(["/admin/config", "/admin/tokens/self"]);
  });

  test("a 1.x answer with header names and hasBody counts 2 checks", async () => {
    api.set(literalConfig(config1x));
    expect(await testConnection(api.url, recordingDeps().deps)).toEqual({
      isOk: true,
      wireVersion: 1,
      checkCount: 2,
      adminScope: "confirmed",
    });
  });

  test("a 2.0.0 answer counts 3 effective checks, not the shadowed entry", async () => {
    api.set(literalConfig(config200));
    expect(await testConnection(api.url, recordingDeps().deps)).toEqual({
      isOk: true,
      wireVersion: 1,
      checkCount: 3,
      adminScope: "confirmed",
    });
  });

  test("zero checks is a success", async () => {
    api.set(okConfig(0));
    expect(await testConnection(api.url, recordingDeps().deps)).toEqual({
      isOk: true,
      wireVersion: 1,
      checkCount: 0,
      adminScope: "confirmed",
    });
  });

  test("self 404 and tokens 404 give not-checked", async () => {
    api.set(okConfig(3), { status: 404 }, selfMissing);
    expect(await testConnection(api.url, recordingDeps().deps)).toEqual({
      isOk: true,
      wireVersion: 1,
      checkCount: 3,
      adminScope: "not-checked",
    });
  });

  test("a path prefix is kept", async () => {
    api.set(okConfig(1));
    const result = await testConnection(`${api.url}/pulse`, recordingDeps().deps);
    expect(result.isOk).toBe(true);
    expect(api.seen.map((s) => s.path)).toEqual([
      "/pulse/admin/config",
      "/pulse/admin/tokens/self",
      "/pulse/admin/tokens",
    ]);
  });
});

describe("testConnection failures", () => {
  const big = "x".repeat(5 * 1024 * 1024 + 1);
  const cases: [string, Reply, Reply, string][] = [
    [
      "config 302",
      { status: 302, headers: { location: "" } },
      okTokens,
      "pulse-api answered with a redirect (302); redirects are not followed.",
    ],
    [
      "tokens 307",
      okConfig(),
      { status: 307, headers: { location: "/x" } },
      "pulse-api answered with a redirect (307); redirects are not followed.",
    ],
    [
      "config 404",
      { status: 404 },
      okTokens,
      "The admin routes of pulse-api are off. Enable its admin token import.",
    ],
    ["config 401", { status: 401 }, okTokens, "pulse-api rejected the console token."],
    ["tokens 401", okConfig(), { status: 401 }, "pulse-api rejected the console token."],
    ["config 403", { status: 403 }, okTokens, "The console token lacks the read or checks scope."],
    ["tokens 403", okConfig(), { status: 403 }, "The console token lacks the admin scope."],
    [
      "config 429",
      { status: 429 },
      okTokens,
      "pulse-api is throttling the console. Try again in a minute.",
    ],
    [
      "tokens 429",
      okConfig(),
      { status: 429 },
      "pulse-api is throttling the console. Try again in a minute.",
    ],
    ["config 500", { status: 500 }, okTokens, "pulse-api answered 500."],
    ["tokens 503", okConfig(), { status: 503 }, "pulse-api answered 503."],
    [
      "config without wire header",
      { status: 200, body: configBody(3) },
      okTokens,
      "pulse-api sent no x-pulse-contract header.",
    ],
    [
      "tokens without wire header",
      okConfig(),
      { status: 200, body: JSON.stringify({ tokens: [] }) },
      "pulse-api sent no x-pulse-contract header.",
    ],
    [
      "wire 2",
      { status: 200, body: configBody(3), headers: { "x-pulse-contract": " 2 " } },
      okTokens,
      "pulse-api speaks wire version 2; this console needs 1.",
    ],
    [
      "wire with unsafe characters",
      { status: 200, body: configBody(3), headers: { "x-pulse-contract": "<b>2</b>" } },
      okTokens,
      "pulse-api speaks wire version an unknown version; this console needs 1.",
    ],
    [
      "wire longer than 16",
      { status: 200, body: configBody(3), headers: { "x-pulse-contract": "1.2.3.4.5.6.7.8.9" } },
      okTokens,
      "pulse-api speaks wire version an unknown version; this console needs 1.",
    ],
    [
      "tokens wire 3",
      okConfig(),
      { status: 200, body: "{}", headers: { "x-pulse-contract": "3" } },
      "pulse-api speaks wire version 3; this console needs 1.",
    ],
    [
      "invalid JSON",
      { status: 200, body: `{${SENTINEL}`, headers: wire1 },
      okTokens,
      "pulse-api sent an invalid answer.",
    ],
    [
      "config fails validation",
      { status: 200, body: JSON.stringify({ checks: SENTINEL }), headers: wire1 },
      okTokens,
      "pulse-api sent an invalid answer.",
    ],
    ...(
      [
        ["revision missing", { ...config1x, revision: undefined }],
        ["revision sha256-abc", { ...config1x, revision: "sha256-abc" }],
        ["checks a string", { ...config1x, checks: SENTINEL }],
        ["check entry a string", { ...config1x, checks: [SENTINEL] }],
        ["check entry without id", { ...config1x, checks: [{ name: SENTINEL }] }],
        ["check id empty", { ...config1x, checks: [{ id: "", name: SENTINEL }] }],
        ["check id a number", { ...config1x, checks: [{ id: 7, name: SENTINEL }] }],
      ] as const
    ).map(([name, body]): [string, Reply, Reply, string] => [
      `summary: ${name}`,
      literalConfig(body),
      okTokens,
      "pulse-api sent an invalid answer.",
    ]),
    [
      "tokens fails validation",
      okConfig(),
      { status: 200, body: JSON.stringify({ tokens: SENTINEL }), headers: wire1 },
      "pulse-api sent an invalid answer.",
    ],
    [
      "body over 5 MiB",
      { status: 200, body: big, headers: wire1 },
      okTokens,
      "pulse-api sent an invalid answer.",
    ],
  ];

  test.each(cases)("%s", async (_name, config, tokens, text) => {
    api.set(config, tokens);
    const result = await testConnection(api.url, recordingDeps().deps);
    expect(result).toEqual({ isOk: false, text });
    const shown = JSON.stringify(result);
    expect(shown).not.toContain(SENTINEL);
    expect(shown).not.toContain(TOKEN);
  });

  const selfCases: [string, Reply, string][] = [
    ["self 401", { status: 401 }, "pulse-api rejected the console token."],
    ["self 403", { status: 403 }, "The console token lacks the admin scope."],
    ["self 429", { status: 429 }, "pulse-api is throttling the console. Try again in a minute."],
    ["self 503", { status: 503 }, "pulse-api answered 503."],
    [
      "self 307",
      { status: 307, headers: { location: "/elsewhere" } },
      "pulse-api answered with a redirect (307); redirects are not followed.",
    ],
    [
      "self without wire header",
      { status: 200, body: JSON.stringify(selfToken()) },
      "pulse-api sent no x-pulse-contract header.",
    ],
    [
      "self wire 3",
      { status: 200, body: JSON.stringify(selfToken()), headers: { "x-pulse-contract": "3" } },
      "pulse-api speaks wire version 3; this console needs 1.",
    ],
  ];

  test.each(selfCases)("%s keeps its text and never falls back", async (_name, self, text) => {
    api.set(okConfig(), okTokens, self);
    const result = await testConnection(api.url, recordingDeps().deps);
    expect(result).toEqual({ isOk: false, text });
    const shown = JSON.stringify(result);
    expect(shown).not.toContain(SENTINEL);
    expect(shown).not.toContain(TOKEN);
    expect(api.seen.map((s) => s.path)).toEqual(["/admin/config", "/admin/tokens/self"]);
  });

  test("a 302 target receives no request", async () => {
    api.set({ status: 302, headers: { location: `${target.url}/admin/config` } });
    target.set(okConfig());
    const result = await testConnection(api.url, recordingDeps().deps);
    expect(result).toEqual({
      isOk: false,
      text: "pulse-api answered with a redirect (302); redirects are not followed.",
    });
    expect(target.seen).toEqual([]);
  });

  test("no token sends no request", async () => {
    const { deps, calls } = recordingDeps();
    const result = await testConnection(api.url, { ...deps, token: undefined });
    expect(result).toEqual({
      isOk: false,
      text: "The console has no pulse-api token. Set PULSE_CONSOLE_ADMIN_TOKEN_FILE and restart the console.",
    });
    expect(calls).toEqual([]);
  });

  test("an unreachable api names the origin", async () => {
    const down: FetchLike = () => Promise.reject(new TypeError(SENTINEL));
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- the fake fetch makes no request
    const result = await testConnection("http://api.invalid:3000/pulse", {
      fetch: down,
      token: TOKEN,
    });
    expect(result).toEqual({
      isOk: false,
      text: "pulse-api cannot be reached at http://api.invalid:3000.",
    });
  });

  test("a timeout has its own text", async () => {
    const hang: FetchLike = () => new Promise<Response>(() => undefined);
    const fire = (fn: () => void): (() => void) => {
      fn();
      return () => undefined;
    };
    const result = await testConnection(api.url, { fetch: hang, token: TOKEN, schedule: fire });
    expect(result).toEqual({ isOk: false, text: "pulse-api did not answer within 5 seconds." });
  });
});
