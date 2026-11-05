import { afterAll, describe, expect, test } from "bun:test";
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
import { apiFailureText } from "./api-failure.ts";
import { type OverviewRead, type OverviewReadDeps, readOverview } from "./overview-read.ts";

const TOKEN = "overview-sentinel-token-0123456789";

const api = startFakeApi();
const second = startFakeApi();
afterAll(() => {
  api.stop();
  second.stop();
});

type Logged = { message: string; fields: Record<string, unknown> };

function depsWith(extra: Partial<OverviewReadDeps> = {}): {
  deps: OverviewReadDeps;
  logs: Logged[];
  redirects: (RequestInit["redirect"] | undefined)[];
  timeouts: number[];
} {
  const logs: Logged[] = [];
  const redirects: (RequestInit["redirect"] | undefined)[] = [];
  const timeouts: number[] = [];
  const deps: OverviewReadDeps = {
    fetch: (input, init) => {
      redirects.push(init?.redirect);
      return fetch(input, init);
    },
    token: TOKEN,
    schedule: (_fn, ms) => {
      timeouts.push(ms);
      return () => undefined;
    },
    warn: (message, fields) => logs.push({ message, fields }),
    ...extra,
  };
  return { deps, logs, redirects, timeouts };
}

function setReplies(target: FakeApi, config: FakeReply, checks: FakeReply): void {
  target.seen.length = 0;
  target.reply("/admin/config", config);
  target.reply("/checks", checks);
}

function failureText(read: OverviewRead): string {
  if (read.kind !== "failed") {
    throw new Error(`expected a failure, got ${read.kind}`);
  }
  return apiFailureText(read.failure);
}

const okConfig = jsonReply(emptyConfig);
const okChecks = jsonReply([checkWithState("a", "down"), checkWithState("b", "up")]);

describe("readOverview", () => {
  test("reads config with the bearer token and checks without it, manual redirects, 5 s each", async () => {
    setReplies(api, okConfig, okChecks);
    const { deps, logs, redirects, timeouts } = depsWith();
    const read = await readOverview(api.url, deps);
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") {
      expect(read.checks.map((c) => c.state)).toEqual(["down", "up"]);
    }
    const byPath = Object.fromEntries(api.seen.map((s) => [s.path, s.authorization]));
    expect(byPath).toEqual({
      "/admin/config": "Bearer overview-sentinel-token-0123456789",
      "/checks": null,
    });
    expect(redirects).toEqual(["manual", "manual"]);
    expect(timeouts).toEqual([5000, 5000]);
    expect(logs).toEqual([]);
  });

  test("both reads start before either resolves", async () => {
    const started: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setReplies(api, okConfig, okChecks);
    const { deps } = depsWith({
      fetch: async (input, init) => {
        started.push(new URL(String(input)).pathname);
        await gate;
        return fetch(input, init);
      },
    });
    const pending = readOverview(api.url, deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(new Set(started)).toEqual(new Set(["/admin/config", "/checks"]));
    release();
    expect((await pending).kind).toBe("ok");
  });

  test("no configured token sends 0 requests", async () => {
    setReplies(api, okConfig, okChecks);
    const { deps } = depsWith({ token: undefined });
    expect(await readOverview(api.url, deps)).toEqual({ kind: "no-token" });
    expect(api.seen).toEqual([]);
  });

  test("config 401 with checks 200 gives the token banner, no summary", async () => {
    setReplies(api, { status: 401 }, okChecks);
    const { deps, logs } = depsWith();
    expect(await readOverview(api.url, deps)).toEqual({ kind: "token-rejected" });
    expect(logs).toEqual([
      { message: "api read failed", fields: { call: "config", kind: "http", status: 401 } },
    ]);
  });

  const failures: [string, FakeReply, FakeReply, string][] = [
    ["config 403", { status: 403 }, okChecks, "The console token lacks the read or checks scope."],
    [
      "config 429",
      { status: 429 },
      okChecks,
      "pulse-api is throttling the console. Try again in a minute.",
    ],
    ["checks 401", okConfig, { status: 401 }, "pulse-api answered 401."],
    ["checks 403", okConfig, { status: 403 }, "pulse-api answered 403."],
    [
      "checks 429",
      okConfig,
      { status: 429 },
      "pulse-api is throttling the console. Try again in a minute.",
    ],
    ["checks 503 (not read-only)", okConfig, { status: 503 }, "pulse-api answered 503."],
    [
      "config missing wire header",
      {
        status: 200,
        body: JSON.stringify(emptyConfig),
        headers: { "content-type": "application/json" },
      },
      okChecks,
      "pulse-api sent no x-pulse-contract header.",
    ],
    [
      "checks missing wire header",
      okConfig,
      { status: 200, body: "[]", headers: { "content-type": "application/json" } },
      "pulse-api sent no x-pulse-contract header.",
    ],
    [
      "checks wrong wire header",
      okConfig,
      { status: 200, body: "[]", headers: { "x-pulse-contract": "2" } },
      "pulse-api speaks wire version 2; this console needs 1.",
    ],
    [
      "checks 6 MiB body",
      okConfig,
      { status: 200, body: `[${" ".repeat(6 * 1024 * 1024)}]`, headers: WIRE_HEADERS },
      "pulse-api sent an invalid answer.",
    ],
    [
      "checks invalid JSON",
      okConfig,
      { status: 200, body: "{", headers: WIRE_HEADERS },
      "pulse-api sent an invalid answer.",
    ],
    ["checks invalid shape", okConfig, jsonReply([{ id: 1 }]), "pulse-api sent an invalid answer."],
    [
      "config failure wins over checks failure",
      { status: 403 },
      { status: 503 },
      "The console token lacks the read or checks scope.",
    ],
    [
      "checks HTTP failure wins over a missing header on config",
      {
        status: 200,
        body: JSON.stringify(emptyConfig),
        headers: { "content-type": "application/json" },
      },
      { status: 503 },
      "pulse-api answered 503.",
    ],
  ];
  for (const [name, config, checks, text] of failures) {
    test(`${name}: ${text}`, async () => {
      setReplies(api, config, checks);
      const { deps, logs } = depsWith();
      const read = await readOverview(api.url, deps);
      expect(failureText(read)).toBe(text);
      expect(logs.length).toBeGreaterThan(0);
      const logged = JSON.stringify(logs);
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain(UPSTREAM_SENTINEL);
      expect(logged).not.toContain("127.0.0.1");
    });
  }

  const noHeader: FakeReply = {
    status: 200,
    body: JSON.stringify(emptyConfig),
    headers: { "content-type": "application/json" },
  };
  const noHeaderChecks: FakeReply = {
    status: 200,
    body: "[]",
    headers: { "content-type": "application/json" },
  };
  const warnings: [string, FakeReply, FakeReply, string[]][] = [
    [
      "config without header, checks 503",
      noHeader,
      { status: 503 },
      ["checks:http", "config:missing-header"],
    ],
    [
      "config 503, checks without header",
      { status: 503 },
      noHeaderChecks,
      ["config:http", "checks:missing-header"],
    ],
    [
      "config 401, checks without header",
      { status: 401 },
      noHeaderChecks,
      ["config:http", "checks:missing-header"],
    ],
    ["config 403, checks 503", { status: 403 }, { status: 503 }, ["config:http", "checks:http"]],
    [
      "both without header",
      noHeader,
      noHeaderChecks,
      ["config:missing-header", "checks:missing-header"],
    ],
  ];
  for (const [name, config, checks, expected] of warnings) {
    test(`one warning per failed read: ${name}`, async () => {
      setReplies(api, config, checks);
      const { deps, logs } = depsWith();
      await readOverview(api.url, deps);
      expect(logs.map((l) => `${String(l.fields.call)}:${String(l.fields.kind)}`)).toEqual(
        expected,
      );
      expect(logs.map((l) => l.message)).toEqual(expected.map(() => "api read failed"));
    });
  }

  test("a 302 is not followed: the destination gets 0 requests", async () => {
    second.seen.length = 0;
    setReplies(api, okConfig, { status: 302, headers: { location: `${second.url}/checks` } });
    const { deps } = depsWith();
    expect(failureText(await readOverview(api.url, deps))).toBe(
      "pulse-api answered with a redirect (302); redirects are not followed.",
    );
    expect(second.seen).toEqual([]);
  });

  test("a timeout gives the timeout text", async () => {
    setReplies(api, okConfig, { status: 200, isHeld: true });
    const { deps } = depsWith({
      schedule: (fn, ms) => {
        if (ms === 5000) {
          queueMicrotask(fn);
        }
        return () => undefined;
      },
    });
    expect(failureText(await readOverview(api.url, deps))).toBe(
      "pulse-api did not answer within 5 seconds.",
    );
  });

  test("a closed port gives the network text with the origin only", async () => {
    const closed = startFakeApi();
    const url = closed.url;
    closed.stop();
    const { deps } = depsWith();
    expect(failureText(await readOverview(`${url}/base`, deps))).toBe(
      `pulse-api cannot be reached at ${url}.`,
    );
  });
});
