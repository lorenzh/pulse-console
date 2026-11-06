import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { checkConfig, REVISION } from "../test/check-fixtures.ts";
import { jsonReply, startFakeApi } from "../test/fake-api.ts";
import type { ApiReadDeps } from "./api-read.ts";
import {
  readMaintenance,
  readMaintenanceAndConfig,
  readMaintenanceForm,
} from "./maintenance-read.ts";

const TOKEN = "console-token-value";
const OTHER = `sha256-${"c".repeat(64)}`;
const api = startFakeApi();
afterAll(() => api.stop());

const deps: ApiReadDeps = {
  fetch: (input, init) => fetch(input, init),
  token: TOKEN,
  warn: () => undefined,
};

const window = {
  id: "db-upgrade",
  index: null,
  source: "database",
  checkIds: ["web"],
  start: 1793959200123,
  end: 1793966400456,
  note: "Upgrade",
  phase: "planned",
};

const listOf = (revision: string) => ({ revision, windows: [window], shadowed: [] });
const paths = () => api.seen.map((s) => `${s.method} ${s.path}`);

beforeEach(() => {
  api.seen.length = 0;
  api.reply("/admin/config", jsonReply(checkConfig));
  api.reply("/admin/maintenance", jsonReply(listOf(REVISION)));
});

describe("maintenance reads", () => {
  test("reads the list with the admin token and keeps stored epochs", async () => {
    const read = await readMaintenance(api.url, deps);
    expect(read.kind === "ok" && read.list.windows[0]?.start).toBe(1793959200123);
    expect(api.seen[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("404 and 405 are the old-api state", async () => {
    for (const status of [404, 405]) {
      api.reply("/admin/maintenance", { status });
      expect(await readMaintenance(api.url, deps)).toEqual({ kind: "old-maintenance" });
    }
  });

  test("401 is token-rejected and 500 a failure", async () => {
    api.reply("/admin/maintenance", { status: 401 });
    expect(await readMaintenance(api.url, deps)).toEqual({ kind: "token-rejected" });
    api.reply("/admin/maintenance", { status: 500 });
    expect(await readMaintenance(api.url, deps)).toEqual({
      kind: "failed",
      failure: { kind: "http", call: "maintenance", status: 500 },
    });
  });

  test("no token sends no read", async () => {
    expect(await readMaintenance(api.url, { ...deps, token: undefined })).toEqual({
      kind: "no-token",
    });
    expect(api.seen).toHaveLength(0);
  });

  test("both reads go in order and agree", async () => {
    const read = await readMaintenanceAndConfig(api.url, deps);
    expect(read.kind === "ok" && read.isCoherent).toBe(true);
    expect(paths()).toEqual(["GET /admin/maintenance", "GET /admin/config"]);
  });

  test("a failed list read stops before the config read", async () => {
    api.reply("/admin/maintenance", { status: 503 });
    const read = await readMaintenanceAndConfig(api.url, deps);
    expect(read.kind).toBe("failed");
    expect(paths()).toEqual(["GET /admin/maintenance"]);
  });

  test("the form reads both once more when the revisions differ", async () => {
    let calls = 0;
    api.reply("/admin/maintenance", {
      ...jsonReply(listOf(OTHER)),
      after: () => {
        calls += 1;
        if (calls === 1) api.reply("/admin/maintenance", jsonReply(listOf(REVISION)));
      },
    });
    const read = await readMaintenanceForm(api.url, deps);
    expect(read.kind === "ok" && read.isCoherent).toBe(true);
    expect(paths()).toEqual([
      "GET /admin/maintenance",
      "GET /admin/config",
      "GET /admin/maintenance",
      "GET /admin/config",
    ]);
  });

  test("the form stays incoherent after the one retry", async () => {
    api.reply("/admin/maintenance", jsonReply(listOf(OTHER)));
    const read = await readMaintenanceForm(api.url, deps);
    expect(read.kind === "ok" && read.isCoherent).toBe(false);
    expect(api.seen).toHaveLength(4);
  });
});
