import { createHash, timingSafeEqual } from "node:crypto";

export const RECOVERY_CODE_COUNT = 10;
const CODE_BYTES = 16;
const STORED_DIGEST = /^[0-9a-f]{64}$/;

export type RecoveryCodeRow = { id: number; digest: string };

/** Ten distinct codes as 8 groups of 4 lowercase hex characters joined by `-`. */
export function generateRecoveryCodes(randomBytes: (size: number) => Uint8Array): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) {
    const hex = Buffer.from(randomBytes(CODE_BYTES)).toString("hex");
    codes.add(hex.match(/.{4}/g)?.join("-") ?? hex);
  }
  return [...codes];
}

/** Trims, removes spaces and `-`, lowercases; 32 hex characters or undefined. */
export function normalizeRecoveryCode(input: string): string | undefined {
  const text = input.trim().replace(/[ -]/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(text) ? text : undefined;
}

/** The 32-byte SHA-256 of a normalised code. */
export function recoveryCodeDigest(normalized: string): Buffer {
  return createHash("sha256").update(normalized, "utf8").digest();
}

/**
 * The id of the row whose stored hex digest equals `candidate`, or undefined. Every row is
 * compared without an early exit; a malformed stored digest never matches.
 */
export function matchRecoveryCode(
  candidate: Uint8Array,
  rows: readonly RecoveryCodeRow[],
): number | undefined {
  if (candidate.length !== 32) return undefined;
  let match: number | undefined;
  for (const row of rows) {
    if (!STORED_DIGEST.test(row.digest)) continue;
    const isEqual = timingSafeEqual(Buffer.from(row.digest, "hex"), candidate);
    if (isEqual && match === undefined) match = row.id;
  }
  return match;
}
