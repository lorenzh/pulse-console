import { describe, expect, test } from "bun:test";
import {
  keptTime,
  type MaintenanceInput,
  maintenanceBody,
  parseUtcTime,
  selectedCheckIds,
  utcInputValue,
} from "./maintenance-form.ts";

const COMPONENTS = [{ id: "web", checkIds: ["status-page", "e2e-post"] }];

function input(over: Partial<MaintenanceInput> = {}): MaintenanceInput {
  return {
    id: "db-upgrade",
    checks: ["e2e-tcp"],
    components: [],
    start: "2026-11-06T10:00",
    end: "2026-11-06T12:00",
    note: "Database upgrade",
    ...over,
  };
}

describe("parseUtcTime", () => {
  test("reads the text as UTC", () => {
    expect(parseUtcTime("2026-11-06T10:00")).toBe(1793959200000);
    expect(parseUtcTime("2026-11-06T10:00:00")).toBe(1793959200000);
    expect(parseUtcTime("2026-11-06T10:00:01")).toBe(1793959201000);
  });

  test.each(["2026-02-30T10:00", "10000-01-01T00:00", "2026-11-06 10:00", "2026-11-06T24:00", ""])(
    "refuses %p",
    (text) => {
      expect(parseUtcTime(text)).toBeUndefined();
    },
  );

  test("prefills without milliseconds", () => {
    expect(utcInputValue(1793959200123)).toBe("2026-11-06T10:00:00");
  });
});

describe("time keep", () => {
  const stored = { start: 1793959200123, end: 1793966400456 };

  test.each([
    ["2026-11-06T10:00:00", "2026-11-06T12:00:00", 1793959200123, 1793966400456],
    ["2026-11-06T10:00", "2026-11-06T12:00", 1793959200123, 1793966400456],
    ["2026-11-06T10:00:01", "2026-11-06T12:00", 1793959201000, 1793966400456],
    ["2026-11-06T09:59:59", "2026-11-06T12:00:00", 1793959199000, 1793966400456],
  ])("start %p end %p", (start, end, wantStart, wantEnd) => {
    const result = maintenanceBody(input({ start, end }), COMPONENTS, stored);
    expect(result.ok && result.body.start).toBe(wantStart);
    expect(result.ok && result.body.end).toBe(wantEnd);
  });

  test("a create sends the parsed epochs", () => {
    expect(keptTime(1793959200000, undefined)).toBe(1793959200000);
  });

  test("an invalid posted time gives an error, never a comparison", () => {
    const result = maintenanceBody(input({ start: "2026-02-30T10:00" }), COMPONENTS, stored);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.start).toBe(
      "Enter a date and time as YYYY-MM-DDTHH:MM, read as UTC.",
    );
  });
});

describe("selection", () => {
  test("checks first, then component members without repeats", () => {
    expect(selectedCheckIds(["e2e-tcp", "e2e-post"], ["web"], COMPONENTS)).toEqual({
      ok: true,
      checkIds: ["e2e-tcp", "e2e-post", "status-page"],
    });
  });

  test("an unknown component keeps the input", () => {
    const result = maintenanceBody(input({ components: ["gone"] }), COMPONENTS, undefined);
    expect(result).toEqual({
      ok: false,
      errors: { component: "Component gone is not configured any more." },
    });
  });

  test.each([
    [0, "Select 1 to 50 checks; this selection has 0."],
    [51, "Select 1 to 50 checks; this selection has 51."],
  ])("%p checks", (n, text) => {
    const checks = Array.from({ length: n }, (_, i) => `c${i}`);
    expect(maintenanceBody(input({ checks }), COMPONENTS, undefined)).toEqual({
      ok: false,
      errors: { check: text },
    });
  });
});

describe("body", () => {
  test("equal start and end", () => {
    const result = maintenanceBody(input({ end: "2026-11-06T10:00" }), COMPONENTS, undefined);
    expect(result).toEqual({ ok: false, errors: { end: "End must be after start." } });
  });

  test.each(["1window", "Window", "a".repeat(65)])("id %p is refused", (id) => {
    const result = maintenanceBody(input({ id }), COMPONENTS, undefined);
    expect(result.ok).toBe(false);
    expect(!result.ok && typeof result.errors.id).toBe("string");
  });

  test("db-upgrade is accepted", () => {
    expect(maintenanceBody(input(), COMPONENTS, undefined)).toEqual({
      ok: true,
      body: {
        id: "db-upgrade",
        checkIds: ["e2e-tcp"],
        start: 1793959200000,
        end: 1793966400000,
        note: "Database upgrade",
      },
    });
  });

  test("the note counts UTF-16 units", () => {
    expect(maintenanceBody(input({ note: "😀".repeat(250) }), COMPONENTS, undefined).ok).toBe(true);
    const over = maintenanceBody(input({ note: "😀".repeat(251) }), COMPONENTS, undefined);
    expect(over.ok).toBe(false);
    expect(!over.ok && typeof over.errors.note).toBe("string");
  });

  test.each(["", "a\u0007b", " lead", "trail "])("note %p is refused untrimmed", (note) => {
    const result = maintenanceBody(input({ note }), COMPONENTS, undefined);
    expect(result.ok).toBe(false);
    expect(!result.ok && typeof result.errors.note).toBe("string");
  });
});
