import { describe, expect, test } from "bun:test";
import type { Incident, ManualIncident } from "@lorenzh/pulse-contract";
import {
  automaticMttr,
  durationText,
  incidentRows,
  listedRows,
  manualMttr,
  parseIncidentFilters,
} from "./incident-list.ts";

function manual(id: number, createdAt: number, resolvedAt: number | null): ManualIncident {
  return {
    id,
    title: `Incident ${id}`,
    componentIds: [],
    impact: "minor",
    status: resolvedAt === null ? "investigating" : "resolved",
    createdAt,
    resolvedAt,
    updates: [{ at: createdAt, status: "investigating", message: "m" }],
  };
}

function automatic(id: number, openedAt: number, resolvedAt: number | null): Incident {
  return { id, checkId: "web", openedAt, resolvedAt, reason: null };
}

const NOW = 2_000_000_000_000;

describe("durationText", () => {
  test.each([
    [29999, "under 1 min"],
    [30000, "1 min"],
    [5400000, "1 h 30 min"],
    [93600000, "1 d 2 h"],
    [3600000, "1 h"],
    [86400000, "1 d"],
  ])("%p ms gives %p", (ms, text) => {
    expect(durationText(ms)).toBe(text);
  });
});

describe("manual MTTR", () => {
  test("two resolved give 20 min and the open one is ignored", () => {
    const stat = manualMttr([manual(1, 0, 600000), manual(2, 0, 1800000), manual(3, 0, null)]);
    expect(stat.value).toBe("20 min");
    expect(stat.sample).toBe("2 resolved in the last 14 days (pulse-api returns at most 50)");
  });
  test("mean 1050000 ms rounds half up to 18 min", () => {
    expect(manualMttr([manual(1, 0, 600000), manual(2, 0, 1500000)]).value).toBe("18 min");
  });
  test("no sample shows a dash", () => {
    expect(manualMttr([manual(1, 0, null)])).toEqual({
      label: "Mean time to resolve, manual incidents",
      value: "—",
      sample: "No incident resolved in the last 14 days.",
    });
  });
  test("a sample of 50 is labelled the 50 most recent", () => {
    const items = Array.from({ length: 50 }, (_, i) => manual(i + 1, 0, 60000));
    expect(manualMttr(items).sample).toBe(
      "50 resolved in the last 14 days (pulse-api returns at most 50, the 50 most recent)",
    );
  });
});

describe("automatic MTTR", () => {
  test("exactly 1000 items are not computed", () => {
    const items = Array.from({ length: 1000 }, (_, i) => automatic(i + 1, 0, 60000));
    expect(automaticMttr(items, NOW)).toEqual({
      label: "Mean time to resolve, automatic incidents",
      value: "—",
      sample: "Not computed: more than 1000 automatic incidents in 14 days.",
    });
  });
  test("an item resolved before the 14 days is excluded", () => {
    const old = NOW - 1209600001;
    const stat = automaticMttr(
      [automatic(1, old - 60000, old), automatic(2, NOW - 600000, NOW)],
      NOW,
    );
    expect(stat.value).toBe("10 min");
    expect(stat.sample).toBe("1 resolved in the last 14 days");
  });
});

describe("filters and order", () => {
  test("repeated or unknown values are ignored", () => {
    expect(parseIncidentFilters("state=open&kind=manual")).toEqual({
      state: "open",
      kind: "manual",
      hasIgnored: false,
    });
    expect(parseIncidentFilters("state=open&state=all&kind=x")).toEqual({
      state: "all",
      kind: "all",
      hasIgnored: true,
    });
    expect(parseIncidentFilters("state=").hasIgnored).toBe(true);
  });
  test("open first, manual before automatic on ties, then higher id", () => {
    const rows = incidentRows(
      [manual(7, 100, null), manual(3, 50, 500)],
      [automatic(7, 100, null), automatic(9, 100, null), automatic(2, 10, 900)],
    );
    const listed = listedRows(rows, parseIncidentFilters(""));
    expect(listed.rows.map((r) => `${r.kind}#${r.id}`)).toEqual([
      "manual#7",
      "automatic#9",
      "automatic#7",
      "automatic#2",
      "manual#3",
    ]);
  });
  test("filters keep only matching rows and do not change MTTR samples", () => {
    const items = [manual(1, 0, 600000), manual(2, 0, null)];
    const rows = incidentRows(items, [automatic(1, 0, null)]);
    const open = listedRows(rows, parseIncidentFilters("state=open&kind=manual"));
    expect(open.rows.map((r) => r.id)).toEqual([2]);
    expect(manualMttr(items).value).toBe("10 min");
  });
  test("only 200 rows are listed", () => {
    const items = Array.from({ length: 205 }, (_, i) => manual(i + 1, i, null));
    const listed = listedRows(incidentRows(items, []), parseIncidentFilters(""));
    expect(listed.rows).toHaveLength(200);
    expect(listed.total).toBe(205);
  });
});
