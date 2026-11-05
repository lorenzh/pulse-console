import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  generateRecoveryCodes,
  matchRecoveryCode,
  normalizeRecoveryCode,
  recoveryCodeDigest,
} from "./recovery-codes.ts";

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

test("a set has 10 distinct formatted codes and draws repeats again", () => {
  let n = 0;
  // Every value comes twice, so a repeat must be drawn again.
  const random = (size: number): Uint8Array => new Uint8Array(size).fill(Math.floor(n++ / 2));
  const codes = generateRecoveryCodes(random);
  expect(codes).toHaveLength(10);
  expect(new Set(codes).size).toBe(10);
  for (const code of codes) expect(code).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/);
  expect(codes[1]).toBe("0101-0101-0101-0101-0101-0101-0101-0101");
});

test("digests are the SHA-256 of the normalised code", () => {
  const code = "abcd-0123-4567-89ef-abcd-0123-4567-89ef";
  const normalized = normalizeRecoveryCode(code.toUpperCase());
  expect(normalized).toBe("abcd0123456789efabcd0123456789ef");
  expect(recoveryCodeDigest(normalized ?? "").toString("hex")).toBe(
    sha256Hex("abcd0123456789efabcd0123456789ef"),
  );
});

test("recovery input normalisation", () => {
  const plain = "abcd0123456789efabcd0123456789ef";
  expect(normalizeRecoveryCode(` ${plain} `)).toBe(plain);
  expect(normalizeRecoveryCode("abcd 0123 4567 89ef abcd 0123 4567 89ef")).toBe(plain);
  expect(normalizeRecoveryCode(plain.slice(1))).toBeUndefined();
  expect(normalizeRecoveryCode(`g${plain.slice(1)}`)).toBeUndefined();
});

test("matchRecoveryCode finds the matching row and refuses the rest", () => {
  const rows = ["a", "b", "c"].map((s, i) => ({ id: i + 1, digest: sha256Hex(s) }));
  const candidate = createHash("sha256").update("b").digest();
  expect(matchRecoveryCode(candidate, rows)).toBe(2);
  const lastByte = Buffer.from(candidate);
  lastByte[31] = (lastByte[31] ?? 0) ^ 1;
  expect(matchRecoveryCode(lastByte, rows)).toBeUndefined();
  expect(matchRecoveryCode(candidate, [])).toBeUndefined();
});

test("malformed stored digests never match and never throw", () => {
  const candidate = createHash("sha256").update("b").digest();
  const hex = sha256Hex("b");
  const bad = [hex.slice(1), `${hex}00`, hex.toUpperCase(), ""];
  for (const digest of bad) {
    expect(() => matchRecoveryCode(candidate, [{ id: 1, digest }])).not.toThrow();
    expect(matchRecoveryCode(candidate, [{ id: 1, digest }])).toBeUndefined();
  }
  expect(
    matchRecoveryCode(candidate, [
      { id: 1, digest: hex.slice(1) },
      { id: 2, digest: hex },
    ]),
  ).toBe(2);
});
