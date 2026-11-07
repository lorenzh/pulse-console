import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { checkConfig } from "../test/check-fixtures.ts";
import { jsonReply, startFakeApi } from "../test/fake-api.ts";
import type { ApiReadDeps } from "./api-read.ts";
import {
  readAutomaticIncident,
  readComposer,
  readIncidentList,
  readManualIncident,
} from "./incident-read.ts";

const TOKEN = "console-token-value";
const NOW = 2_000_000_000_000;
const api = startFakeApi();
afterAll(() => api.stop());

const warnings: Array<Record<string, unknown>> = [];
const deps: ApiReadDeps = {
  fetch: (input, init) => fetch(input, init),
  token: TOKEN,
  warn: (_message, fields) => warnings.push(fields),
};

function manual(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Incident ${id}`,
    componentIds: [],
    impact: "minor",
    status: "investigating",
    createdAt: NOW - 1000,
    resolvedAt: null,
    updates: [{ at: NOW - 1000, status: "investigating", message: "m" }],
    ...extra,
  };
}

const automatic = (id: number, checkId: string, resolvedAt: number | null = null) => ({
  id,
  checkId,
  openedAt: NOW - 5000,
  resolvedAt,
  reason: null,
});

beforeEach(() => {
  api.seen.length = 0;
  warnings.length = 0;
  api.reply("/admin/config", jsonReply(checkConfig));
  api.reply("/manual-incidents", jsonReply([manual(1)]));
  api.reply("/incidents", jsonReply([automatic(7, "web")]));
  api.reply("/manual-incidents/3", jsonReply(manual(3)));
  api.reply("/checks/web/results", jsonReply([]));
});

const pathsOf = () =>
  api.seen.map((s) => `${s.method} ${s.path}${s.query}`).sort((a, b) => a.localeCompare(b));

describe("incident list read", () => {
  test("reads the public lists without a token and the config with it", async () => {
    const read = await readIncidentList(api.url, deps, NOW);
    expect(read.kind).toBe("ok");
    expect(pathsOf()).toEqual([
      "GET /admin/config",
      "GET /incidents?since=1998790400000&limit=1000",
      "GET /manual-incidents?status=all",
    ]);
    const auth = Object.fromEntries(api.seen.map((s) => [s.path, s.authorization]));
    expect(auth).toEqual({
      "/admin/config": `Bearer ${TOKEN}`,
      "/incidents": null,
      "/manual-incidents": null,
    });
  });

  test("drops private items and copies only public fields", async () => {
    api.reply(
      "/manual-incidents",
      jsonReply([
        manual(1, { visibility: "public", publishedAt: NOW, notes: ["secret note"] }),
        manual(2, { visibility: "internal", publishedAt: NOW }),
        manual(4, { visibility: "public", publishedAt: null, title: "draft title" }),
      ]),
    );
    const read = await readIncidentList(api.url, deps, NOW);
    expect(read.kind === "ok" && read.manual).toEqual([
      {
        id: 1,
        title: "Incident 1",
        componentIds: [],
        impact: "minor",
        status: "investigating",
        createdAt: NOW - 1000,
        resolvedAt: null,
        updates: [{ at: NOW - 1000, status: "investigating", message: "m" }],
      },
    ]);
  });

  test("a manual list 404 counts as empty", async () => {
    api.reply("/manual-incidents", { status: 404 });
    const read = await readIncidentList(api.url, deps, NOW);
    expect(read.kind === "ok" && read.manual).toEqual([]);
  });

  test("the first failed read wins, in the listed order", async () => {
    api.reply("/manual-incidents", { status: 500 });
    api.reply("/incidents", { status: 503 });
    expect(await readIncidentList(api.url, deps, NOW)).toEqual({
      kind: "failed",
      failure: { kind: "http", call: "manual-incidents", status: 500 },
    });
    api.reply("/manual-incidents", jsonReply([]));
    expect(await readIncidentList(api.url, deps, NOW)).toEqual({
      kind: "failed",
      failure: { kind: "http", call: "incidents", status: 503 },
    });
    api.reply("/incidents", { status: 404 });
    expect(await readIncidentList(api.url, deps, NOW)).toEqual({
      kind: "failed",
      failure: { kind: "http", call: "incidents", status: 404 },
    });
    api.reply("/incidents", jsonReply([]));
    api.reply("/admin/config", { status: 401 });
    expect(await readIncidentList(api.url, deps, NOW)).toEqual({ kind: "token-rejected" });
  });

  test("an invalid manual list is an invalid answer", async () => {
    api.reply("/manual-incidents", jsonReply([{ id: "x", visibility: "public" }]));
    expect(await readIncidentList(api.url, deps, NOW)).toEqual({
      kind: "failed",
      failure: { kind: "invalid" },
    });
  });

  test("no token: no read", async () => {
    expect(await readIncidentList(api.url, { ...deps, token: undefined }, NOW)).toEqual({
      kind: "no-token",
    });
    expect(api.seen).toEqual([]);
  });
});

describe("manual incident read", () => {
  test("one incident with or without the config", async () => {
    const withConfig = await readManualIncident(api.url, deps, 3, true);
    expect(withConfig.kind === "ok" && withConfig.incident.id).toBe(3);
    expect(withConfig.kind === "ok" && withConfig.config?.revision).toBe(checkConfig.revision);
    api.seen.length = 0;
    const alone = await readManualIncident(api.url, deps, 3, false);
    expect(alone.kind === "ok" && alone.config).toBeUndefined();
    expect(pathsOf()).toEqual(["GET /manual-incidents/3"]);
  });

  test("404 and a private item are not found", async () => {
    expect(await readManualIncident(api.url, deps, 9, false)).toEqual({ kind: "not-found" });
    api.reply("/manual-incidents/9", jsonReply(manual(9, { visibility: "internal" })));
    expect(await readManualIncident(api.url, deps, 9, true)).toEqual({ kind: "not-found" });
  });

  test("a failure is a failed read", async () => {
    api.reply("/manual-incidents/9", { status: 500 });
    expect(await readManualIncident(api.url, deps, 9, true)).toEqual({
      kind: "failed",
      failure: { kind: "http", call: "manual-incident", status: 500 },
    });
  });
});

describe("automatic incident read", () => {
  test("found: reads the results of its check", async () => {
    const read = await readAutomaticIncident(api.url, deps, 7, NOW);
    expect(read.kind === "ok" && read.results.kind).toBe("ok");
    expect(pathsOf()).toEqual([
      "GET /admin/config",
      "GET /checks/web/results?limit=20",
      "GET /incidents?since=1998790400000&limit=1000",
    ]);
  });

  test("resolved: results before resolvedAt + 1", async () => {
    api.reply("/incidents", jsonReply([automatic(7, "web", NOW - 100)]));
    await readAutomaticIncident(api.url, deps, 7, NOW);
    expect(pathsOf()).toContain("GET /checks/web/results?limit=20&before=1999999999901");
  });

  test("a results 404 means the check is gone", async () => {
    api.reply("/checks/web/results", { status: 404 });
    const read = await readAutomaticIncident(api.url, deps, 7, NOW);
    expect(read.kind === "ok" && read.results).toEqual({ kind: "check-gone" });
  });

  test("check ids . and .. send no results read", async () => {
    for (const checkId of [".", ".."]) {
      api.seen.length = 0;
      api.reply("/incidents", jsonReply([automatic(7, checkId)]));
      const read = await readAutomaticIncident(api.url, deps, 7, NOW);
      expect(read.kind === "ok" && read.results).toEqual({ kind: "unaddressable" });
      expect(api.seen).toHaveLength(2);
    }
  });

  test("an id outside the read is not found", async () => {
    expect(await readAutomaticIncident(api.url, deps, 8, NOW)).toEqual({ kind: "not-found" });
    expect(api.seen).toHaveLength(2);
  });
});

describe("composer read", () => {
  test("without from: the config only", async () => {
    const read = await readComposer(api.url, deps, undefined, NOW);
    expect(read.kind === "ok" && read.from).toBeUndefined();
    expect(pathsOf()).toEqual(["GET /admin/config"]);
  });

  test("with from: the automatic list first, then the config", async () => {
    const read = await readComposer(api.url, deps, 7, NOW);
    expect(read.kind === "ok" && read.from?.checkId).toBe("web");
    expect(api.seen.map((s) => s.path)).toEqual(["/incidents", "/admin/config"]);
    const missing = await readComposer(api.url, deps, 8, NOW);
    expect(missing.kind === "ok" && missing.from).toBeUndefined();
  });
});
