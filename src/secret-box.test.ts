import { expect, test } from "bun:test";
import { createCipheriv } from "node:crypto";
import { openSecret, sealSecret } from "./secret-box.ts";

const KEY = Buffer.from("0123456789abcdef".repeat(4), "hex");
const OTHER_KEY = Buffer.from("fedcba9876543210".repeat(4), "hex");
const SEED = Buffer.from("12345678901234567890", "ascii");
const fixedRandom = (size: number): Uint8Array => new Uint8Array(size).fill(7);

test("an envelope opens with the same key and user", () => {
  const envelope = sealSecret(KEY, 1, SEED, fixedRandom);
  expect(envelope).toMatch(/^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{27}:[A-Za-z0-9_-]{22}$/);
  expect(envelope).not.toContain(SEED.toString("base64url"));
  const result = openSecret(KEY, 1, envelope);
  expect(result.isOpen && result.plaintext.equals(SEED)).toBe(true);
});

test("the additional data binds the envelope to the user", () => {
  // Independent encryption with the spec's AAD text must open.
  const nonce = Buffer.alloc(12, 3);
  const cipher = createCipheriv("aes-256-gcm", KEY, nonce);
  cipher.setAAD(Buffer.from("pulse-console:totp:v1:user:5", "utf8"));
  const ct = Buffer.concat([cipher.update(SEED), cipher.final()]);
  const envelope = ["v1", nonce, ct, cipher.getAuthTag()]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(":");
  expect(openSecret(KEY, 5, envelope).isOpen).toBe(true);
  expect(openSecret(KEY, 6, envelope).isOpen).toBe(false);
});

test("malformed, tampered, foreign and wrong-key envelopes fail", () => {
  const envelope = sealSecret(KEY, 1, SEED, fixedRandom);
  const [, nonce, ct, tag] = envelope.split(":");
  const ctBytes = Buffer.from(ct ?? "", "base64url");
  ctBytes[0] = (ctBytes[0] ?? 0) ^ 1;
  const cases = [
    `v2:${nonce}:${ct}:${tag}`,
    `v1:${nonce}:${ct}`,
    `v1:${Buffer.alloc(11).toString("base64url")}:${ct}:${tag}`,
    `v1:${nonce}:${ct}:${Buffer.alloc(15).toString("base64url")}`,
    `v1:${nonce}:${ctBytes.toString("base64url")}:${tag}`,
    `v1:${nonce}:${ct}:${tag}:x`,
    `v1:${nonce}:${ct}!:${tag}`,
    "",
  ];
  for (const bad of cases) expect(openSecret(KEY, 1, bad)).toEqual({ isOpen: false });
  expect(openSecret(KEY, 2, envelope)).toEqual({ isOpen: false });
  expect(openSecret(OTHER_KEY, 1, envelope)).toEqual({ isOpen: false });
});

test("each seal uses a fresh nonce from the random source", () => {
  let n = 0;
  const counting = (size: number): Uint8Array => new Uint8Array(size).fill(n++);
  expect(sealSecret(KEY, 1, SEED, counting)).not.toBe(sealSecret(KEY, 1, SEED, counting));
});
