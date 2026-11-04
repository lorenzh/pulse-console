import { describe, expect, test } from "bun:test";
import {
  createCredentialVerifier,
  isSignInPasswordAcceptable,
  PASSWORD_HASH_OPTIONS,
  passwordProblem,
} from "./passwords.ts";

const hash = (password: string): Promise<string> =>
  Bun.password.hash(password, PASSWORD_HASH_OPTIONS);
const PREFIX = "$argon2id$v=19$m=19456,t=2,p=1$";

describe("password policy", () => {
  test("12 emoji (48 bytes) and leading spaces are accepted as typed", () => {
    const emoji = "😀".repeat(12);
    expect(passwordProblem(emoji, emoji)).toBeUndefined();
    expect(passwordProblem("   abcdefghij", "   abcdefghij")).toBeUndefined();
    expect(passwordProblem("   abcdefghij", "abcdefghij")).toBe("mismatch");
  });

  test("11 or 129 code points and an unequal confirmation are rejected", () => {
    expect(passwordProblem("a".repeat(11), "a".repeat(11))).toBe("too-short");
    expect(passwordProblem("😀".repeat(129), "😀".repeat(129))).toBe("too-long");
    expect(passwordProblem("a".repeat(128), "a".repeat(128))).toBeUndefined();
    expect(passwordProblem("abcdefghijkl", "abcdefghijkm")).toBe("mismatch");
  });

  test("sign-in refuses empty and over 128 code points before the throttle", () => {
    expect(isSignInPasswordAcceptable("")).toBe(false);
    expect(isSignInPasswordAcceptable("😀".repeat(129))).toBe(false);
    expect(isSignInPasswordAcceptable("😀".repeat(128))).toBe(true);
    expect(isSignInPasswordAcceptable("x")).toBe(true);
  });
});

describe("hashing and verification with the real Bun.password", () => {
  test("hashes carry the reviewed argon2id parameters", async () => {
    expect((await hash("console-test-password-sentinel-42")).startsWith(PREFIX)).toBe(true);
  });

  test("a known hash verifies; the unknown account runs the dummy with the same costs and fails", async () => {
    const hashes: string[] = [];
    const verified: string[] = [];
    const verifier = await createCredentialVerifier({
      hash: async (pw) => {
        const value = await hash(pw);
        hashes.push(value);
        return value;
      },
      verify: (pw, stored) => {
        verified.push(stored);
        return Bun.password.verify(pw, stored);
      },
      dummySecret: "dummy-secret-from-random-bytes",
    });
    expect(hashes).toHaveLength(1);
    expect(hashes[0]?.startsWith(PREFIX)).toBe(true);
    const stored = await hash("console-test-password-sentinel-42");
    expect(await verifier.verify("console-test-password-sentinel-42", stored)).toBe(true);
    expect(await verifier.verify("console-test-wrong-password-43", stored)).toBe(false);
    expect(await verifier.verify("dummy-secret-from-random-bytes", undefined)).toBe(false);
    expect(verified).toHaveLength(3);
    expect(verified[2]).toBe(hashes[0] ?? "missing");
  });
});
