import { createHmac } from "node:crypto";

export const TOTP_PERIOD_MS = 30_000;
export const TOTP_SEED_BYTES = 20;
const DIGITS = 6;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, upper case, without padding. */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** RFC 4226 HOTP with HMAC-SHA-1 and 6 digits, left-padded with zeros. */
export function hotp(seed: Uint8Array, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", seed).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const value = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** The RFC 6238 time step for T0 = 0 and a 30-second period. */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / TOTP_PERIOD_MS);
}

/** Trims, removes U+0020, and returns the 6 ASCII digits, or undefined for any other input. */
export function normalizeTotpInput(input: string): string | undefined {
  const text = input.trim().replaceAll(" ", "");
  return /^\d{6}$/.test(text) ? text : undefined;
}

/**
 * The lowest step of c - 1, c and c + 1 that is above `lastStep` and whose code equals `code`,
 * or undefined. `code` must already be normalised.
 */
export function matchTotpStep(
  seed: Uint8Array,
  code: string,
  nowMs: number,
  lastStep: number,
): number | undefined {
  const current = totpStep(nowMs);
  for (let step = current - 1; step <= current + 1; step++) {
    if (step > lastStep && step >= 0 && hotp(seed, step) === code) return step;
  }
  return undefined;
}
