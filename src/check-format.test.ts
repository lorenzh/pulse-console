import { describe, expect, test } from "bun:test";
import type { AdminCheckView } from "@lorenzh/pulse-contract";
import {
  budgetText,
  formatPercent,
  reasonText,
  targetText,
  utcTime,
  utcTimeMs,
} from "./check-format.ts";

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
    [-87400, "Error budget exceeded"],
    [-0.04, "Error budget exceeded"],
    [-12.25, "Error budget exceeded"],
    [0, "0.0 % of the error budget left"],
    [42.26, "42.3 % of the error budget left"],
    [100, "100.0 % of the error budget left"],
    [100.5, "Error budget not available"],
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

describe("reasonText", () => {
  const rows: Array<[string, string]> = [
    ["latency 1501.4197810000041ms over objective 500ms", "latency 1501ms over objective 500ms"],
    ["latency 1501.5ms over objective 500ms", "latency 1502ms over objective 500ms"],
    ["latency 1501ms over objective 500ms", "latency 1501ms over objective 500ms"],
    ['keyword "1.5" not found', 'keyword "1.5" not found'],
    ["timeout after 1500.5ms", "timeout after 1500.5ms"],
    ["<b>latency</b> 2.5ms", "<b>latency</b> 2.5ms"],
    ["latency 2.5ms<img src=x onerror=alert(1)>", "latency 3ms<img src=x onerror=alert(1)>"],
    [
      "latency 9007199254740993.5ms over objective 500ms",
      "latency 9007199254740993.5ms over objective 500ms",
    ],
  ];
  for (const [reason, expected] of rows) {
    test(`${reason} -> ${expected}`, () => {
      expect(reasonText(reason)).toBe(expected);
    });
  }

  test("a 400-digit latency stays unchanged, never Infinity", () => {
    const reason = `latency ${"9".repeat(400)}.5ms`;
    expect(reasonText(reason)).toBe(reason);
    expect(reasonText(reason)).not.toContain("Infinity");
  });

  test("a million-digit latency without a dot stays unchanged and is fast", () => {
    const reason = `latency ${"1".repeat(1_000_000)}ms`;
    const start = performance.now();
    const text = reasonText(reason);
    expect(performance.now() - start).toBeLessThan(100);
    expect(text).toBe(reason);
  });
});

describe("utcTimeMs", () => {
  const rows: Array<[number, string]> = [
    [1762343970123, "2025-11-05 11:59:30.123 UTC"],
    [1762343970987, "2025-11-05 11:59:30.987 UTC"],
    [1762343970000, "2025-11-05 11:59:30.000 UTC"],
  ];
  for (const [epochMs, expected] of rows) {
    test(`${epochMs} -> ${expected}`, () => {
      expect(utcTimeMs(epochMs)).toBe(expected);
    });
  }
  test("utcTime keeps seconds", () => {
    expect(utcTime(1762343970123)).toBe("2025-11-05 11:59:30 UTC");
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
