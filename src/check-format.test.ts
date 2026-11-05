import { describe, expect, test } from "bun:test";
import type { AdminCheckView } from "@lorenzh/pulse-contract";
import { budgetText, formatPercent, targetText, utcTime } from "./check-format.ts";

describe("formatPercent", () => {
  const rows: Array<[number | null, string]> = [
    [100, "100 %"],
    [99.995, "99.99 %"],
    [99.9999999, "99.99 %"],
    [12.345, "12.34 %"],
    [12.34, "12.34 %"],
    [0, "0.00 %"],
    [null, "No results"],
  ];
  for (const [value, expected] of rows) {
    test(`${String(value)} -> ${expected}`, () => {
      expect(formatPercent(value)).toBe(expected);
    });
  }
});

describe("budgetText", () => {
  const rows: Array<[number, string]> = [
    [-0.04, "Error budget exceeded (-0.0 %)"],
    [-12.25, "Error budget exceeded (-12.3 %)"],
    [0, "0.0 % of the error budget left"],
    [42.26, "42.3 % of the error budget left"],
  ];
  for (const [value, expected] of rows) {
    test(`${value} -> ${expected}`, () => {
      expect(budgetText(value)).toBe(expected);
    });
  }
});

describe("utcTime", () => {
  test("formats epoch ms in UTC", () => {
    expect(utcTime(1_793_880_000_123)).toBe("2026-11-05 12:00:00 UTC");
  });
  test("null has no results", () => {
    expect(utcTime(null)).toBe("No results yet");
  });
});

describe("targetText", () => {
  const rows: Array<[AdminCheckView, string]> = [
    [
      { id: "a", name: "A", url: "https://a.example/", intervalMs: 1000, source: "file" },
      "https://a.example/",
    ],
    [
      {
        id: "t",
        name: "T",
        type: "tls",
        host: "a.example",
        port: 443,
        warnDays: 14,
        intervalMs: 1000,
        source: "file",
      },
      "a.example:443",
    ],
    [
      {
        id: "c",
        name: "C",
        type: "tcp",
        host: "db",
        port: 5432,
        intervalMs: 1000,
        source: "database",
      },
      "db:5432",
    ],
    [
      {
        id: "d",
        name: "D",
        type: "dns",
        dnsName: "a.example",
        recordType: "A",
        intervalMs: 1000,
        source: "file",
      },
      "a.example A",
    ],
    [
      {
        id: "m",
        name: "M",
        type: "domain",
        domain: "a.example",
        warnDays: 30,
        intervalMs: 3_600_000,
        source: "file",
      },
      "a.example",
    ],
    [
      {
        id: "h",
        name: "H",
        type: "heartbeat",
        period: 60_000,
        grace: 0,
        hasSecret: true,
        source: "database",
      },
      "Heartbeat",
    ],
  ];
  for (const [check, expected] of rows) {
    test(`${check.type ?? "http"} -> ${expected}`, () => {
      expect(targetText(check)).toBe(expected);
    });
  }
});
