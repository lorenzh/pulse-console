import { describe, expect, test } from "bun:test";
import type { AdminCheckView, AdminConfigExport } from "@lorenzh/pulse-contract";
import { exportBody, shadowedCheckExport, singleCheckExport } from "./check-export.ts";

const ALL: AdminConfigExport = {
  checks: [
    {
      id: "web",
      name: "Web",
      url: "https://shop.example/",
      intervalMs: 60_000,
      headers: { "X-Token": { env: "PULSE_HEADER_TOKEN" } },
    },
    { id: "nightly-backup", name: "Backup", type: "heartbeat", period: 60_000, grace: 0 },
  ],
  components: [{ id: "shop", name: "Shop", checkIds: ["web"] }],
  maintenance: [
    {
      checkId: "web",
      start: "2026-11-05T10:00:00.000Z",
      end: "2026-11-05T11:00:00.000Z",
      note: "Deploy",
    },
    {
      checkId: "nightly-backup",
      start: "2026-11-06T10:00:00.000Z",
      end: "2026-11-06T11:00:00.000Z",
      note: "Restore test",
    },
  ],
  redacted: [
    { checkId: "web", field: "headers.X-Api-Key" },
    { checkId: "web", field: "body" },
    { checkId: "nightly-backup", field: "secret" },
  ],
};

describe("singleCheckExport", () => {
  test("one check with its maintenance and redacted entries in order", () => {
    expect(singleCheckExport(ALL, "web")).toEqual({
      checks: [
        {
          id: "web",
          name: "Web",
          url: "https://shop.example/",
          intervalMs: 60_000,
          headers: { "X-Token": { env: "PULSE_HEADER_TOKEN" } },
        },
      ],
      components: [],
      maintenance: [
        {
          checkId: "web",
          start: "2026-11-05T10:00:00.000Z",
          end: "2026-11-05T11:00:00.000Z",
          note: "Deploy",
        },
      ],
      redacted: [
        { checkId: "web", field: "headers.X-Api-Key" },
        { checkId: "web", field: "body" },
      ],
    });
  });

  test("redacted is absent when the check has none", () => {
    const document: AdminConfigExport = {
      checks: [{ id: "a", name: "A", url: "https://a.example/", intervalMs: 1000 }],
      components: [],
      maintenance: [],
    };
    expect(singleCheckExport(document, "a")).toEqual({
      checks: [{ id: "a", name: "A", url: "https://a.example/", intervalMs: 1000 }],
      components: [],
      maintenance: [],
    });
  });

  test("an unknown id has no document", () => {
    expect(singleCheckExport(ALL, "missing")).toBeUndefined();
  });
});

describe("shadowedCheckExport", () => {
  test("http: keep markers become redacted, env names stay, source is dropped", () => {
    const view: AdminCheckView = {
      id: "web",
      name: "Old web",
      url: "https://old.example/",
      intervalMs: 60_000,
      method: "POST",
      headers: {
        "X-Api-Key": { keep: true },
        "X-Token": { env: "PULSE_HEADER_TOKEN" },
        Accept: { keep: true },
      },
      body: { keep: true },
      source: "database",
    };
    const result = shadowedCheckExport(view);
    expect(result).toEqual({
      kind: "ok",
      document: {
        checks: [
          {
            id: "web",
            name: "Old web",
            url: "https://old.example/",
            intervalMs: 60_000,
            method: "POST",
            headers: { "X-Token": { env: "PULSE_HEADER_TOKEN" } },
          },
        ],
        components: [],
        maintenance: [],
        redacted: [
          { checkId: "web", field: "headers.X-Api-Key" },
          { checkId: "web", field: "headers.Accept" },
          { checkId: "web", field: "body" },
        ],
      },
    });
    const text = result.kind === "ok" ? exportBody(result.document) : "";
    for (const marker of ['"keep"', '"source"', '"hasSecret"', '"body":']) {
      expect(text).not.toContain(marker);
    }
  });

  test("http: only literal headers leave out the empty header object", () => {
    const view: AdminCheckView = {
      id: "web",
      name: "Old web",
      url: "https://old.example/",
      intervalMs: 60_000,
      headers: { "X-Api-Key": { keep: true } },
      source: "database",
    };
    expect(shadowedCheckExport(view)).toEqual({
      kind: "ok",
      document: {
        checks: [{ id: "web", name: "Old web", url: "https://old.example/", intervalMs: 60_000 }],
        components: [],
        maintenance: [],
        redacted: [{ checkId: "web", field: "headers.X-Api-Key" }],
      },
    });
  });

  test("heartbeat lists the secret and drops hasSecret", () => {
    const view: AdminCheckView = {
      id: "nightly-backup",
      name: "Backup",
      type: "heartbeat",
      period: 60_000,
      grace: 5000,
      hasSecret: true,
      source: "database",
    };
    expect(shadowedCheckExport(view)).toEqual({
      kind: "ok",
      document: {
        checks: [
          { id: "nightly-backup", name: "Backup", type: "heartbeat", period: 60_000, grace: 5000 },
        ],
        components: [],
        maintenance: [],
        redacted: [{ checkId: "nightly-backup", field: "secret" }],
      },
    });
  });

  test("tcp has no redacted key", () => {
    const view: AdminCheckView = {
      id: "db",
      name: "DB",
      type: "tcp",
      host: "db",
      port: 5432,
      intervalMs: 1000,
      source: "database",
    };
    expect(shadowedCheckExport(view)).toEqual({
      kind: "ok",
      document: {
        checks: [{ id: "db", name: "DB", type: "tcp", host: "db", port: 5432, intervalMs: 1000 }],
        components: [],
        maintenance: [],
      },
    });
  });
});

describe("exportBody", () => {
  test("two spaces and a final newline", () => {
    expect(exportBody({ checks: [], components: [], maintenance: [] })).toBe(
      '{\n  "checks": [],\n  "components": [],\n  "maintenance": []\n}\n',
    );
  });
});
