import { expect, test } from "bun:test";
import { isWithinApiBodyLimit } from "./check-write.ts";

test("a built body of 1048576 bytes fits; 1048577 bytes do not", () => {
  expect(isWithinApiBodyLimit("x".repeat(1048576))).toBe(true);
  expect(isWithinApiBodyLimit("x".repeat(1048577))).toBe(false);
});

test("the limit counts UTF-8 bytes, not characters", () => {
  // 524288 'é' are 1048576 bytes; one more character is over.
  expect(isWithinApiBodyLimit("é".repeat(524288))).toBe(true);
  expect(isWithinApiBodyLimit(`${"é".repeat(524288)}x`)).toBe(false);
});
