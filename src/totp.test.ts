import { expect, test } from "bun:test";
import { base32Encode, hotp, matchTotpStep, normalizeTotpInput, totpStep } from "./totp.ts";

// RFC 6238 Appendix B SHA-1 seed.
const SEED = Buffer.from("12345678901234567890", "ascii");

test("RFC 6238 SHA-1 vectors give the last 6 digits", () => {
  const vectors: [number, string][] = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];
  for (const [seconds, code] of vectors) {
    expect(hotp(SEED, totpStep(seconds * 1000))).toBe(code);
  }
});

test("base32 of the RFC seed follows RFC 4648", () => {
  expect(base32Encode(SEED)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  expect(base32Encode(new Uint8Array(20))).toHaveLength(32);
  expect(base32Encode(Buffer.from("f"))).toBe("MY");
});

test("the step floors at the 30-second boundary", () => {
  expect(totpStep(29999)).toBe(0);
  expect(totpStep(30000)).toBe(1);
});

test("the window accepts c - 1 to c + 1 only", () => {
  expect(matchTotpStep(SEED, "287082", 59000, -1)).toBe(1);
  expect(matchTotpStep(SEED, "287082", 90000, -1)).toBeUndefined();
  const now = 300_000; // step 10
  expect(matchTotpStep(SEED, hotp(SEED, 9), now, -1)).toBe(9);
  expect(matchTotpStep(SEED, hotp(SEED, 11), now, -1)).toBe(11);
  expect(matchTotpStep(SEED, hotp(SEED, 12), now, -1)).toBeUndefined();
  expect(matchTotpStep(SEED, hotp(SEED, 8), now, -1)).toBeUndefined();
});

test("steps at or below the last step are refused", () => {
  const now = 300_000;
  expect(matchTotpStep(SEED, hotp(SEED, 10), now, 10)).toBeUndefined();
  expect(matchTotpStep(SEED, hotp(SEED, 9), now, 10)).toBeUndefined();
  expect(matchTotpStep(SEED, hotp(SEED, 11), now, 10)).toBe(11);
  // The same digits at a much later step are a new code, not a replay.
  const later = 30_000 * 1000;
  expect(matchTotpStep(SEED, hotp(SEED, 1000), later, 10)).toBe(1000);
});

test("TOTP input is 6 ASCII digits after trim and space removal", () => {
  expect(normalizeTotpInput("081804")).toBe("081804");
  expect(normalizeTotpInput(" 081 804 ")).toBe("081804");
  for (const bad of ["81804", "0818040", "08180a", "٠٨١٨٠٤", "", "081\t804"]) {
    expect(normalizeTotpInput(bad)).toBeUndefined();
  }
});
