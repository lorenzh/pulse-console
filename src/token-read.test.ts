import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { jsonReply, startFakeApi, WIRE_HEADERS } from "../test/fake-api.ts";
import { adminToken, probeToken, SELF_ID, selfToken, T0 } from "../test/token-fixtures.ts";
import type { ApiReadDeps } from "./api-read.ts";
import { readLocations, readSelf, readToken, readTokenList, readTokenPage } from "./token-read.ts";

const TOKEN = "console-token-value";
const api = startFakeApi();
afterAll(() => api.stop());

const warnings: Array<Record<string, unknown>> = [];
const deps: ApiReadDeps = {
  fetch: (input, init) => fetch(input, init),
  token: TOKEN,
  warn: (_message, fields) => warnings.push(fields),
};

beforeEach(() => {
  api.seen.length = 0;
  warnings.length = 0;
  api.reply("/admin/tokens", jsonReply({ tokens: [selfToken(), adminToken(), probeToken("eu")] }));
  api.reply("/admin/tokens/self", jsonReply(selfToken()));
  api.reply("/locations", jsonReply([{ name: "eu", lastResultAt: T0, state: "reporting" }]));
});

describe("successful reads", () => {
  test("list, self, one token and locations parse the contract shapes", async () => {
    api.reply(`/admin/tokens/${adminToken().id}`, jsonReply(adminToken()));
    const list = await readTokenList(api.url, deps);
    expect(list.kind === "ok" && list.value.map((t) => t.id)).toEqual([
      "tok_5e1f00000000000000000001",
      "tok_ad0000000000000000000002",
      "tok_b0be00000000000000000003",
    ]);
    const self = await readSelf(api.url, deps);
    expect(self.kind === "ok" && self.value.id).toBe(SELF_ID);
    const one = await readToken(api.url, adminToken().id, deps);
    expect(one.kind === "ok" && one.value.name).toBe("ops");
    const locations = await readLocations(api.url, deps);
    expect(locations).toEqual({
      kind: "ok",
      value: [{ name: "eu", lastResultAt: T0, state: "reporting" }],
    });
    expect(warnings).toEqual([]);
  });

  test("the list accepts status and notify service tokens", async () => {
    const status = adminToken({
      id: "tok_57a700000000000000000004",
      name: "status",
      scopes: ["status"],
    });
    const notify = adminToken({
      id: "tok_9071f0000000000000000005",
      name: "notify",
      scopes: ["notify"],
    });
    api.reply("/admin/tokens", jsonReply({ tokens: [selfToken(), status, notify] }));
    const list = await readTokenList(api.url, deps);
    expect(list.kind === "ok" && list.value.map((t) => t.scopes)).toEqual([
      ["read", "checks", "incidents", "admin"],
      ["status"],
      ["notify"],
    ]);
    expect(warnings).toEqual([]);
  });

  test("admin reads carry the bearer token; /locations carries none", async () => {
    await readTokenPage(api.url, deps, true);
    const auth = Object.fromEntries(api.seen.map((s) => [s.path, s.authorization]));
    expect(auth).toEqual({
      "/admin/tokens": `Bearer ${TOKEN}`,
      "/admin/tokens/self": `Bearer ${TOKEN}`,
      "/locations": null,
    });
  });

  test("self is read fresh on every call", async () => {
    await readSelf(api.url, deps);
    api.reply("/admin/tokens/self", jsonReply(selfToken({ name: "renamed" })));
    const second = await readSelf(api.url, deps);
    expect(second.kind === "ok" && second.value.name).toBe("renamed");
    expect(api.seen.filter((s) => s.path === "/admin/tokens/self")).toHaveLength(2);
  });

  test("a Tokens page does not read /locations", async () => {
    const page = await readTokenPage(api.url, deps, false);
    expect(page.locations).toBeUndefined();
    expect(new Set(api.seen.map((s) => s.path))).toEqual(
      new Set(["/admin/tokens", "/admin/tokens/self"]),
    );
  });
});

describe("failed reads", () => {
  test("a body with a secret field fails validation", async () => {
    api.reply("/admin/tokens/self", jsonReply({ ...selfToken(), secret: "pulse_x" }));
    expect(await readSelf(api.url, deps)).toEqual({ kind: "failed", failure: { kind: "invalid" } });
  });

  test("a missing wire header and a wrong one are failures", async () => {
    api.reply("/admin/tokens", { status: 200, body: JSON.stringify({ tokens: [] }) });
    expect(await readTokenList(api.url, deps)).toEqual({
      kind: "failed",
      failure: { kind: "missing-header" },
    });
    api.reply("/admin/tokens", {
      status: 200,
      body: JSON.stringify({ tokens: [] }),
      headers: { ...WIRE_HEADERS, "x-pulse-contract": "7" },
    });
    expect(await readTokenList(api.url, deps)).toEqual({
      kind: "failed",
      failure: { kind: "wire-mismatch", label: "7" },
    });
  });

  test("self 404 is a failure with its status; 401 is token-rejected", async () => {
    api.reply("/admin/tokens/self", { status: 404, headers: WIRE_HEADERS });
    expect(await readSelf(api.url, deps)).toEqual({
      kind: "failed",
      failure: { kind: "http", call: "self", status: 404 },
    });
    api.reply("/admin/tokens/self", { status: 401, headers: WIRE_HEADERS });
    expect(await readSelf(api.url, deps)).toEqual({ kind: "token-rejected" });
  });

  test("a partial failure keeps the readable lists", async () => {
    api.reply("/locations", { status: 503, headers: WIRE_HEADERS });
    api.reply("/admin/tokens/self", { status: 404, headers: WIRE_HEADERS });
    const page = await readTokenPage(api.url, deps, true);
    expect(page.tokens.kind === "ok" && page.tokens.value).toHaveLength(3);
    expect(page.self).toEqual({
      kind: "failed",
      failure: { kind: "http", call: "self", status: 404 },
    });
    expect(page.locations).toEqual({
      kind: "failed",
      failure: { kind: "http", call: "locations", status: 503 },
    });
  });

  test("one token: 404, the id self and a dot segment are not-found", async () => {
    api.reply(`/admin/tokens/${adminToken().id}`, { status: 404, headers: WIRE_HEADERS });
    expect(await readToken(api.url, adminToken().id, deps)).toEqual({ kind: "not-found" });
    api.seen.length = 0;
    expect(await readToken(api.url, "self", deps)).toEqual({ kind: "not-found" });
    expect(await readToken(api.url, "..", deps)).toEqual({ kind: "not-found" });
    expect(api.seen).toEqual([]);
  });

  test("without a configured token no admin read is made", async () => {
    const none = { ...deps, token: undefined };
    expect(await readTokenList(api.url, none)).toEqual({ kind: "no-token" });
    expect(await readSelf(api.url, none)).toEqual({ kind: "no-token" });
    expect(await readToken(api.url, adminToken().id, none)).toEqual({ kind: "no-token" });
    expect(api.seen).toEqual([]);
  });
});
