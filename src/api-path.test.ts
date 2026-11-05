import { describe, expect, test } from "bun:test";
import { apiIdSegment } from "./api-path.ts";

describe("apiIdSegment", () => {
  const rows: Array<[string, string | undefined]> = [
    [".", undefined],
    ["..", undefined],
    ["...", "..."],
    ["a/b", "a%2Fb"],
    ["%2e", "%252e"],
    [".x", ".x"],
    ["web?x#y", "web%3Fx%23y"],
    ["nightly-backup", "nightly-backup"],
  ];
  for (const [id, expected] of rows) {
    test(`${JSON.stringify(id)} -> ${String(expected)}`, () => {
      expect(apiIdSegment(id)).toBe(expected);
    });
  }
});
