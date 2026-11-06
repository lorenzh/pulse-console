import { describe, expect, test } from "bun:test";
import { adminToken, probeToken, selfToken, T0 } from "../test/token-fixtures.ts";
import {
  ADMIN_PRESET_TEXT,
  accessText,
  countdownSeconds,
  countdownText,
  isOverlapOpen,
  lastActiveAdmin,
  lastUsedText,
  locationGroups,
  missingScope,
  PRESET_DESCRIPTIONS,
  presetOf,
  selfUnknownText,
  sourceText,
  TOKEN_PRESETS,
  tokenRevision,
  tokenStateText,
} from "./token-view.ts";

describe("presets", () => {
  test("each preset has its own literal description and the admin note names the three", () => {
    expect(PRESET_DESCRIPTIONS).toEqual({
      read: "Reads the checks and their configuration. Changes nothing.",
      checks: "Reads checks and creates, changes and deletes them.",
      incidents: "Reads checks and posts incidents.",
      full: "Reads and changes checks and posts incidents.",
    });
    expect(ADMIN_PRESET_TEXT).toBe(
      "Manage checks, Post incidents and Full access can also create, rotate and revoke tokens with the same or fewer scopes, and read the audit log.",
    );
  });

  test("the four presets hold the literal scope arrays of #460 s3", () => {
    expect(TOKEN_PRESETS.map((p) => [p.id, p.label, [...p.scopes]])).toEqual([
      ["read", "Read", ["read"]],
      ["checks", "Manage checks", ["read", "checks", "admin"]],
      ["incidents", "Post incidents", ["read", "incidents", "admin"]],
      ["full", "Full access", ["read", "checks", "incidents", "admin"]],
    ]);
  });

  test("presetOf knows only the four ids", () => {
    expect(presetOf("checks")?.scopes).toEqual(["read", "checks", "admin"]);
    expect(presetOf("read")?.scopes).toEqual(["read"]);
    expect(presetOf("admin")).toBeUndefined();
    expect(presetOf(undefined)).toBeUndefined();
  });

  test("access shows the preset label, else the scopes", () => {
    expect(accessText(["read", "checks", "incidents", "admin"])).toBe("Full access");
    expect(accessText(["read", "admin"])).toBe("read, admin");
    expect(accessText(["probe"])).toBe("probe");
  });

  test("grant: probe needs checks; a [read, admin] console lacks checks and incidents", () => {
    const held = ["read", "admin"] as const;
    expect(missingScope(["read"], held)).toBeUndefined();
    expect(missingScope(["read", "checks", "admin"], held)).toBe("checks");
    expect(missingScope(["read", "incidents", "admin"], held)).toBe("incidents");
    expect(missingScope(["probe"], held)).toBe("checks");
    expect(missingScope(["probe"], ["read", "checks", "admin"])).toBeUndefined();
  });
});

describe("token texts", () => {
  test("source texts", () => {
    expect(sourceText("api")).toBe("Created in pulse-api");
    expect(sourceText("file")).toBe("Imported from a token file");
  });

  test("last used null is Never, not 1970", () => {
    expect(lastUsedText(null)).toBe("Never");
    expect(lastUsedText(T0)).toBe("2026-01-01 00:00:00 UTC");
  });

  test.each([
    ["active", {}, "Active"],
    ["active with expiry", { expiresAt: T0 + 3600000 }, "Active, expires 2026-01-01 01:00:00 UTC"],
    [
      "rotated in overlap",
      { rotatedAt: T0 - 1000, previousValidUntil: T0 + 599000 },
      "Rotated: old secret valid until 2026-01-01 00:09:59 UTC",
    ],
    [
      "rotated after overlap",
      { rotatedAt: T0 - 700000, previousValidUntil: T0 - 100000 },
      "Active",
    ],
    ["revoked", { revokedAt: T0 - 60000 }, "Revoked 2025-12-31 23:59:00 UTC"],
    ["expired", { expiresAt: T0 }, "Expired 2026-01-01 00:00:00 UTC"],
  ])("%s", (_name, overrides, text) => {
    expect(tokenStateText(adminToken(overrides), T0)).toBe(text);
  });

  test("the self banner names the reason and the route", () => {
    expect(selfUnknownText({ kind: "http", call: "self", status: 404 })).toBe(
      "The console cannot tell which token it uses (pulse-api answered 404). Changes are off until it can. pulse-api needs GET /admin/tokens/self.",
    );
    expect(selfUnknownText({ kind: "timeout" })).toContain(
      "(pulse-api answered nothing within 5 seconds)",
    );
  });
});

describe("last active admin", () => {
  test("one active admin token besides an expired console token is the last one", () => {
    const only = adminToken();
    const tokens = [
      selfToken({ expiresAt: T0 - 1 }),
      only,
      adminToken({ id: "tok_ad0000000000000000000009", scopes: ["read"] }),
    ];
    expect(lastActiveAdmin(tokens, T0)?.id).toBe("tok_ad0000000000000000000002");
  });

  test("two active admin tokens: none is the last; a revoked one does not count", () => {
    expect(lastActiveAdmin([selfToken(), adminToken()], T0)).toBeUndefined();
    expect(lastActiveAdmin([selfToken(), adminToken({ revokedAt: T0 - 1 })], T0)?.id).toBe(
      "tok_5e1f00000000000000000001",
    );
  });
});

describe("revision", () => {
  test("is the SHA-256 of the seven fields", () => {
    // `sha256sum` of the literal JSON ["tok_ad0000000000000000000002","ops",["read","checks","admin"],null,null,null,null]
    expect(tokenRevision(adminToken())).toBe(
      "210a7dd2a96344f90ac960607810c613f830cd92410a65465ce2845556f3cd56",
    );
  });

  test("lastUsedAt and previousValidUntil keep it; revokedAt changes it", () => {
    const base = tokenRevision(adminToken());
    expect(tokenRevision(adminToken({ lastUsedAt: T0 }))).toBe(base);
    expect(tokenRevision(adminToken({ previousValidUntil: T0 }))).toBe(base);
    expect(tokenRevision(adminToken({ revokedAt: T0 }))).not.toBe(base);
    expect(tokenRevision(adminToken({ name: "ops2" }))).not.toBe(base);
  });
});

describe("countdown", () => {
  test.each([
    [T0 + 600000, 600, "10:00"],
    [T0 + 59000, 59, "00:59"],
    [T0 + 59999, 59, "00:59"],
    [T0 - 5000, 0, "00:00"],
  ])("until %d gives %d seconds, %s", (until, seconds, text) => {
    expect(countdownSeconds(until, T0)).toBe(seconds);
    expect(countdownText(seconds)).toBe(text);
  });

  test("an overlap that is null or not later than now has ended", () => {
    expect(isOverlapOpen(null, T0)).toBe(false);
    expect(isOverlapOpen(T0, T0)).toBe(false);
    expect(isOverlapOpen(T0 + 1, T0)).toBe(true);
  });
});

describe("location groups", () => {
  const eu1 = probeToken("eu", { id: "tok_b0be00000000000000000011" });
  const eu2 = probeToken("eu", { id: "tok_b0be00000000000000000012" });
  const upper = probeToken("EU", { id: "tok_b0be00000000000000000013" });

  test("eu and EU are two groups; two eu tokens are two rows of one group", () => {
    const groups = locationGroups([eu1, upper, eu2], [], T0);
    expect(groups.map((g) => [g.name, g.credentials.map((c) => c.id)])).toEqual([
      ["EU", ["tok_b0be00000000000000000013"]],
      ["eu", ["tok_b0be00000000000000000011", "tok_b0be00000000000000000012"]],
    ]);
  });

  test.each([
    [
      "reporting, active",
      [eu1],
      "reporting",
      "Reporting, last result 2026-01-01 00:00:00 UTC",
      undefined,
    ],
    [
      "reporting, none active",
      [probeToken("eu", { revokedAt: T0 - 1 })],
      "reporting",
      "Reporting, last result 2026-01-01 00:00:00 UTC",
      "No active token: new results will be refused.",
    ],
    ["silent, active", [eu1], "silent", "Silent since 2026-01-01 00:00:00 UTC", undefined],
    ["silent, none active", [], "silent", "Silent, no active token", undefined],
    ["not listed, active", [eu1], undefined, "Awaiting first result", undefined],
    [
      "not listed, last used but no result",
      [probeToken("eu", { lastUsedAt: T0 - 10 })],
      undefined,
      "Awaiting first result",
      undefined,
    ],
    [
      "not listed, none active",
      [probeToken("eu", { expiresAt: T0 })],
      undefined,
      "No active token",
      undefined,
    ],
  ] as const)("%s", (_name, tokens, state, text, warning) => {
    const observed = state === undefined ? [] : [{ name: "eu", lastResultAt: T0, state }];
    const [group] = locationGroups(tokens, observed, T0);
    expect(group?.stateText).toBe(text);
    expect(group?.warning).toBe(warning);
  });

  test("only inactive credentials and no result is a revoked group", () => {
    const groups = locationGroups([probeToken("old", { revokedAt: T0 - 1 }), eu1], [], T0);
    expect(groups.map((g) => [g.name, g.isRevokedOnly])).toEqual([
      ["eu", false],
      ["old", true],
    ]);
  });

  test("a failed locations read keeps the credentials and names the reason", () => {
    const [group] = locationGroups(
      [eu1],
      { failure: { kind: "http", call: "locations", status: 503 } },
      T0,
    );
    expect(group?.stateText).toBe("Last result unknown (pulse-api answered 503)");
    expect(group?.credentials).toHaveLength(1);
  });
});
