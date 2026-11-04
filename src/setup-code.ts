import { createHash, timingSafeEqual } from "node:crypto";

export const SETUP_GRANT_TTL_MS = 1_800_000;
const CODE_BYTES = 16;
const GRANT_BYTES = 32;

export type SetupCodeDeps = {
  now: () => number;
  randomBytes: (size: number) => Uint8Array;
};

export type CodeCheck = "empty" | "match" | "mismatch";

export type SetupGate = {
  /** Compares normalized input with the code digest in constant time. */
  checkCode: (input: string) => CodeCheck;
  /** Makes a new grant, replaces any older one, and returns the cookie value. */
  createGrant: () => string;
  isGrantValid: (value: string | undefined) => boolean;
  /** Ends the live grant, for example when setup completes. */
  endGrant: () => void;
};

function digestOf(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

function hexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Removes ASCII spaces and hyphens, then lowercases. */
export function normalizeCode(input: string): string {
  return input.replace(/[ -]/g, "").toLowerCase();
}

/**
 * Makes the setup code and its gate. The returned code is for the one stdout line only; the
 * gate keeps only its digest. A restart makes a new gate, which drops the old code and grant.
 */
export function createSetupGate(deps: SetupCodeDeps): { code: string; gate: SetupGate } {
  const hex = hexOf(deps.randomBytes(CODE_BYTES));
  const code = hex.match(/.{4}/g)?.join("-") ?? hex;
  const codeDigest = digestOf(hex);
  let grant: { digest: Buffer; expiresAt: number } | undefined;

  const gate: SetupGate = {
    checkCode(input) {
      const normalized = normalizeCode(input);
      if (normalized === "") return "empty";
      return timingSafeEqual(digestOf(normalized), codeDigest) ? "match" : "mismatch";
    },
    createGrant() {
      const value = Buffer.from(deps.randomBytes(GRANT_BYTES)).toString("base64url");
      grant = { digest: digestOf(value), expiresAt: deps.now() + SETUP_GRANT_TTL_MS };
      return value;
    },
    isGrantValid(value) {
      if (value === undefined || grant === undefined) return false;
      if (deps.now() >= grant.expiresAt) return false;
      return timingSafeEqual(digestOf(value), grant.digest);
    },
    endGrant() {
      grant = undefined;
    },
  };
  return { code, gate };
}
