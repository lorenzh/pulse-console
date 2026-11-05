import { describe, expect, test } from "bun:test";
import {
  type CheckRow,
  checkFiltersQuery,
  isCheckRowMatched,
  parseCheckFilters,
} from "./check-filters.ts";

const ROWS: CheckRow[] = [
  {
    kind: "effective",
    state: "up",
    check: {
      id: "web",
      name: "Web shop",
      url: "https://shop.example/",
      intervalMs: 1000,
      source: "file",
    },
  },
  {
    kind: "effective",
    state: "down",
    check: {
      id: "db",
      name: "Database",
      type: "tcp",
      host: "db.internal",
      port: 5432,
      intervalMs: 1000,
      source: "database",
    },
  },
  {
    kind: "effective",
    state: "maintenance",
    check: {
      id: "nightly-backup",
      name: "Backup",
      type: "heartbeat",
      period: 60_000,
      grace: 0,
      hasSecret: true,
      source: "database",
    },
  },
  {
    kind: "shadowed",
    check: {
      id: "web",
      name: "Old web",
      url: "https://old.example/",
      intervalMs: 1000,
      source: "database",
    },
  },
];

function idsOf(search: string): string[] {
  const { filters } = parseCheckFilters(new URLSearchParams(search));
  return ROWS.filter((row) => isCheckRowMatched(row, filters)).map(
    (row) => `${row.kind}:${row.check.id}`,
  );
}

describe("parseCheckFilters", () => {
  const rows: Array<[string, Record<string, string>, boolean]> = [
    ["", {}, false],
    [
      "q=%20Shop%20&type=http&state=up&source=file",
      { q: "Shop", type: "http", state: "up", source: "file" },
      false,
    ],
    ["type=http&type=tcp", {}, true],
    ["state=shadowed", {}, true],
    ["source=shadowed&state=up", { source: "shadowed", state: "up" }, false],
    ["type=", {}, true],
    ["q=%20%20", {}, true],
    ["source=all&q=db", { q: "db" }, true],
    [`q=${"a".repeat(200)}`, { q: "a".repeat(200) }, false],
    [`q=${"a".repeat(201)}`, {}, true],
    ["unrelated=1", {}, false],
  ];
  for (const [search, filters, hasIgnoredValues] of rows) {
    test(JSON.stringify(search.slice(0, 60)), () => {
      expect(parseCheckFilters(new URLSearchParams(search))).toEqual({ filters, hasIgnoredValues });
    });
  }
});

describe("isCheckRowMatched", () => {
  const rows: Array<[string, string[]]> = [
    ["", ["effective:web", "effective:db", "effective:nightly-backup", "shadowed:web"]],
    ["source=shadowed&state=up", []],
    ["source=shadowed", ["shadowed:web"]],
    ["source=database", ["effective:db", "effective:nightly-backup"]],
    ["source=file", ["effective:web"]],
    ["state=up", ["effective:web"]],
    ["type=http", ["effective:web", "shadowed:web"]],
    ["type=heartbeat", ["effective:nightly-backup"]],
    ["q=SHOP", ["effective:web"]],
    ["q=db.internal", ["effective:db"]],
    ["q=heartbeat", ["effective:nightly-backup"]],
    ["q=web&type=http&source=shadowed", ["shadowed:web"]],
    [
      "type=http&type=tcp",
      ["effective:web", "effective:db", "effective:nightly-backup", "shadowed:web"],
    ],
  ];
  for (const [search, expected] of rows) {
    test(JSON.stringify(search), () => {
      expect(idsOf(search)).toEqual(expected);
    });
  }
});

describe("checkFiltersQuery", () => {
  test("round-trips the parsed filters", () => {
    const { filters } = parseCheckFilters(
      new URLSearchParams("source=file&q=a+b&type=dns&state=down"),
    );
    expect(checkFiltersQuery(filters)).toBe("q=a+b&type=dns&state=down&source=file");
  });
  test("is empty without filters", () => {
    expect(checkFiltersQuery({})).toBe("");
  });
});
