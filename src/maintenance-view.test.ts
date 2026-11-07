import { describe, expect, test } from "bun:test";
import type { AdminMaintenanceList, AdminMaintenanceWindow } from "@lorenzh/pulse-contract";
import { maintenanceSections, windowPlace } from "./maintenance-view.ts";

function db(
  id: string,
  phase: AdminMaintenanceWindow["phase"],
  start: number,
  end: number,
): AdminMaintenanceWindow {
  return { id, index: null, source: "database", checkIds: ["web"], start, end, note: "n", phase };
}

function file(
  index: number,
  phase: AdminMaintenanceWindow["phase"],
  start: number,
  end: number,
): AdminMaintenanceWindow {
  return { id: null, index, source: "file", checkIds: ["gone"], start, end, note: "f", phase };
}

const NAMES = new Map([["web", "Web"]]);

function list(windows: AdminMaintenanceWindow[], shadowed: AdminMaintenanceWindow[] = []) {
  const value: AdminMaintenanceList = { revision: "sha256-a", windows, shadowed };
  return value;
}

describe("maintenanceSections", () => {
  test("sections in order with the api phase and their sort keys", () => {
    const sections = maintenanceSections(
      list([
        db("c2", "current", 0, 300),
        db("c1", "current", 0, 200),
        db("p2", "planned", 500, 900),
        db("p1", "planned", 400, 900),
        db("x1", "past", 0, 10),
        db("x2", "past", 0, 20),
        file(0, "planned", 400, 900),
      ]),
      NAMES,
      "owner",
    );
    expect(sections.map((s) => s.title)).toEqual([
      "Current",
      "Planned",
      "Past",
      "Shadowed by the checks file",
    ]);
    expect(sections.map((s) => s.rows.map((r) => r.identity))).toEqual([
      ["c1", "c2"],
      ["File window #0", "p1", "p2"],
      ["x2", "x1"],
      [],
    ]);
  });

  test("the api phase decides, not the times", () => {
    const sections = maintenanceSections(
      list([db("a", "past", 0, 10_000_000_000_000)]),
      NAMES,
      "owner",
    );
    expect(sections[2]?.rows.length).toBe(1);
  });

  test("past is cut at 50 with a count", () => {
    const past = Array.from({ length: 51 }, (_, i) => db(`w${i}`, "past", 0, i + 1));
    const section = maintenanceSections(list(past), NAMES, "owner")[2];
    expect(section?.rows.length).toBe(50);
    expect(section?.total).toBe(51);
    expect(section?.limitText).toBe("Showing 50 of 51 past windows.");
  });

  test("missing check and source labels", () => {
    const row = maintenanceSections(list([file(3, "current", 0, 5)]), NAMES, "owner")[0]?.rows[0];
    expect(row?.checks).toEqual(["gone (not configured; does not apply now)"]);
    expect(row?.source).toBe("From the checks file, read-only");
    expect(row?.identity).toBe("File window #3");
  });

  test.each([
    ["viewer", [], [], []],
    ["member", ["edit"], [], []],
    ["admin", ["edit", "delete"], ["delete-copy"], []],
    ["owner", ["edit", "delete"], ["delete-copy"], []],
  ] as const)(
    "%p actions for database, shadowed and file rows",
    (role, dbActions, copy, fileActions) => {
      const sections = maintenanceSections(
        list([db("a", "current", 0, 5), file(0, "planned", 6, 9)], [db("s", "planned", 6, 9)]),
        NAMES,
        role,
      );
      expect(sections[0]?.rows[0]?.actions).toEqual([...dbActions]);
      expect(sections[3]?.rows[0]?.actions).toEqual([...copy]);
      expect(sections[1]?.rows[0]?.actions).toEqual([...fileActions]);
    },
  );
});

describe("windowPlace", () => {
  const value = list(
    [db("a", "current", 0, 5), { ...file(0, "planned", 6, 9), id: "f" }],
    [db("s", "planned", 6, 9)],
  );

  test.each([
    ["a", "database"],
    ["s", "shadowed"],
    ["f", "file"],
    ["zz", "missing"],
  ])("%p is %p", (id, kind) => {
    expect<string>(windowPlace(value, id).kind).toBe(kind);
  });
});
