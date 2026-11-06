import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  jsonReply,
  NOTIFY_REVISION,
  notifyChannelsView,
  STATUS_REVISION,
  startFakeApi,
  statusSettingsView,
  WIRE_HEADERS,
  webhookChannel,
} from "../test/fake-api.ts";
import type { ApiReadDeps } from "./api-read.ts";
import {
  readNotifyChannels,
  readNotifyFailed,
  readResendCommand,
  readStatusSettings,
} from "./runtime-read.ts";

const TOKEN = "runtime-read-token-sentinel";
const PATH = "/admin/status/settings";
const api = startFakeApi();
afterAll(() => api.stop());

const warnings: Array<Record<string, unknown>> = [];
const inits: Array<RequestInit | undefined> = [];
const deps: ApiReadDeps = {
  fetch: (input, init) => {
    inits.push(init);
    return fetch(input, init);
  },
  token: TOKEN,
  warn: (_message, fields) => warnings.push(fields),
};

beforeEach(() => {
  api.seen.length = 0;
  warnings.length = 0;
  inits.length = 0;
  api.reply(PATH, jsonReply(statusSettingsView({ name: "Acme" })));
});

describe("readStatusSettings", () => {
  test("reads the view once with the bearer token and no followed redirect", async () => {
    const read = await readStatusSettings(api.url, deps);
    expect(read.kind === "ok" && read.view.revision).toBe(STATUS_REVISION);
    expect(read.kind === "ok" && read.view.settings).toEqual({ name: "Acme" });
    expect(api.seen.map((s) => [s.method, s.path, s.authorization])).toEqual([
      ["GET", PATH, `Bearer ${TOKEN}`],
    ]);
    expect(inits[0]?.redirect).toBe("manual");
  });

  test("no token reads nothing", async () => {
    expect(await readStatusSettings(api.url, { ...deps, token: undefined })).toEqual({
      kind: "no-token",
    });
    expect(api.seen).toEqual([]);
  });

  test.each([
    [401, { kind: "token-rejected" }],
    [404, { kind: "old-api" }],
    [403, { kind: "failed", failure: { kind: "http", call: "status-settings", status: 403 } }],
  ])("status %d is %o", async (status, expected) => {
    api.reply(PATH, { status, headers: WIRE_HEADERS, body: '{"error":"no"}' });
    expect(await readStatusSettings(api.url, deps)).toEqual(expected as never);
    expect(warnings).toEqual([{ call: "status-settings", kind: "http", status }]);
  });

  test("a view over the 5 MiB read limit is unusable", async () => {
    const big = statusSettingsView({ name: "x".repeat(5 * 1024 * 1024) });
    api.reply(PATH, jsonReply(big));
    expect(await readStatusSettings(api.url, deps)).toEqual({
      kind: "failed",
      failure: { kind: "invalid" },
    });
    expect(warnings).toEqual([{ call: "status-settings", kind: "too-large" }]);
  });

  test("an invalid body and a missing wire header are failures", async () => {
    api.reply(PATH, jsonReply({ revision: "x" }));
    expect(await readStatusSettings(api.url, deps)).toEqual({
      kind: "failed",
      failure: { kind: "invalid" },
    });
    api.reply(PATH, { status: 200, body: JSON.stringify(statusSettingsView()) });
    const absent = await readStatusSettings(api.url, deps);
    expect(absent.kind).toBe("failed");
  });

  test("a timeout after 5000 ms is a failure", async () => {
    api.reply(PATH, { status: 200, isHeld: true });
    const delays: number[] = [];
    const read = await readStatusSettings(api.url, {
      ...deps,
      schedule: (fn, ms) => {
        delays.push(ms);
        queueMicrotask(fn);
        return () => undefined;
      },
    });
    expect(delays).toEqual([5000]);
    expect(read).toEqual({ kind: "failed", failure: { kind: "timeout" } });
  });
});

describe("notify reads", () => {
  test("the channels view passes the admin record validator", async () => {
    api.reply(
      "/admin/notify/channels",
      jsonReply(notifyChannelsView({ channels: [webhookChannel("a")] })),
    );
    const read = await readNotifyChannels(api.url, deps);
    expect(read.kind === "ok" && read.view.revision).toBe(NOTIFY_REVISION);
    expect(read.kind === "ok" && read.view.channels.map((c) => c.id)).toEqual(["a"]);
  });

  test("a record with a secret value field is an invalid answer", async () => {
    const view = notifyChannelsView({ channels: [webhookChannel("a", { secret: "s" })] });
    api.reply("/admin/notify/channels", jsonReply(view));
    expect(await readNotifyChannels(api.url, deps)).toEqual({
      kind: "failed",
      failure: { kind: "invalid" },
    });
  });

  test("the failed view reads state, receivedAt, failed and failedTotal", async () => {
    const view = { state: "never", receivedAt: null, failed: [], failedTotal: 0 } as const;
    api.reply("/admin/notify/failed", jsonReply(view));
    expect(await readNotifyFailed(api.url, deps)).toEqual({
      kind: "ok",
      view: { ...view, failed: [] },
    });
  });

  test("an unknown resend command is not-found, not an old api", async () => {
    api.reply("/admin/notify/resends/AAAAAAAAAAAAAAAAAAAAAAAA", {
      status: 404,
      headers: WIRE_HEADERS,
      body: "{}",
    });
    expect(await readResendCommand(api.url, "AAAAAAAAAAAAAAAAAAAAAAAA", deps)).toEqual({
      kind: "not-found",
    });
  });
});
