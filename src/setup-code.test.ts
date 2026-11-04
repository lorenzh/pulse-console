import { describe, expect, test } from "bun:test";
import { createSetupGate, normalizeCode } from "./setup-code.ts";

const CODE_BYTES = Uint8Array.from([
  0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10,
]);
const CODE = "0123-4567-89ab-cdef-fedc-ba98-7654-3210";

function fakeRandom(): { randomBytes: (n: number) => Uint8Array; sizes: number[] } {
  const sizes: number[] = [];
  let grantCounter = 0;
  return {
    sizes,
    randomBytes(n) {
      sizes.push(n);
      if (n === 16) return CODE_BYTES;
      grantCounter += 1;
      return new Uint8Array(n).fill(grantCounter);
    },
  };
}

function makeGate(clock = { t: 0 }) {
  const random = fakeRandom();
  return { ...createSetupGate({ now: () => clock.t, randomBytes: random.randomBytes }), random };
}

describe("setup code", () => {
  test("is 16 random bytes as 8 groups of 4 lowercase hex characters", () => {
    const { code, random } = makeGate();
    expect(code).toBe(CODE);
    expect(code).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/);
    expect(random.sizes).toEqual([16]);
  });

  test("normalization removes ASCII spaces and hyphens and lowercases", () => {
    expect(normalizeCode(" AB-cd 12\t")).toBe("abcd12\t");
  });

  test("upper case, spaced and ungrouped forms of the code match", () => {
    const { gate } = makeGate();
    expect(gate.checkCode("0123-4567-89AB-CDEF-FEDC-BA98-7654-3210")).toBe("match");
    expect(gate.checkCode("0123 4567 89ab cdef fedc ba98 7654 3210")).toBe("match");
    expect(gate.checkCode("0123456789abcdeffedcba9876543210")).toBe("match");
  });

  test("empty input is its own result; a changed digit or other length is a mismatch", () => {
    const { gate } = makeGate();
    expect(gate.checkCode("")).toBe("empty");
    expect(gate.checkCode(" - -")).toBe("empty");
    expect(gate.checkCode("1123-4567-89ab-cdef-fedc-ba98-7654-3210")).toBe("mismatch");
    expect(gate.checkCode("0123")).toBe("mismatch");
  });

  test("a restart makes a new gate: the old code no longer matches", () => {
    const { gate: first } = makeGate();
    const grant = first.createGrant();
    const restarted = createSetupGate({
      now: () => 0,
      randomBytes: (n) => new Uint8Array(n).fill(0xaa),
    });
    expect(restarted.code).toBe("aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa");
    expect(restarted.gate.checkCode(CODE)).toBe("mismatch");
    expect(restarted.gate.isGrantValid(grant)).toBe(false);
  });
});

describe("setup grant", () => {
  test("is 32 random bytes as base64url and valid until 1800000 ms have passed", () => {
    const clock = { t: 1000 };
    const { gate, random } = makeGate(clock);
    const grant = gate.createGrant();
    expect(random.sizes).toEqual([16, 32]);
    expect(grant).toBe("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE");
    clock.t = 1_800_999;
    expect(gate.isGrantValid(grant)).toBe(true);
    clock.t = 1_801_000;
    expect(gate.isGrantValid(grant)).toBe(false);
  });

  test("a forged, missing or replaced grant is invalid", () => {
    const { gate } = makeGate();
    expect(gate.isGrantValid(undefined)).toBe(false);
    const grantA = gate.createGrant();
    expect(gate.isGrantValid("forged")).toBe(false);
    const grantB = gate.createGrant();
    expect(gate.isGrantValid(grantA)).toBe(false);
    expect(gate.isGrantValid(grantB)).toBe(true);
  });

  test("completion ends the grant", () => {
    const { gate } = makeGate();
    const grant = gate.createGrant();
    gate.endGrant();
    expect(gate.isGrantValid(grant)).toBe(false);
  });
});
