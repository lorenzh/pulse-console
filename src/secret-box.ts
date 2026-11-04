import { createCipheriv, createDecipheriv } from "node:crypto";

const VERSION = "v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

export type OpenResult = { isOpen: true; plaintext: Buffer } | { isOpen: false };

/** The additional data that binds a TOTP seed envelope to one account. */
function additionalData(userId: number): Buffer {
  return Buffer.from(`pulse-console:totp:v1:user:${userId}`, "utf8");
}

/** Encrypts with AES-256-GCM and a fresh nonce into `v1:<nonce>:<ciphertext>:<tag>`. */
export function sealSecret(
  key: Uint8Array,
  userId: number,
  plaintext: Uint8Array,
  randomBytes: (size: number) => Uint8Array,
): string {
  const nonce = Buffer.from(randomBytes(NONCE_BYTES));
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(additionalData(userId));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const parts = [nonce, ciphertext, cipher.getAuthTag()].map((p) => p.toString("base64url"));
  return [VERSION, ...parts].join(":");
}

function decodePart(text: string): Buffer | undefined {
  return BASE64URL.test(text) ? Buffer.from(text, "base64url") : undefined;
}

/** Decrypts an envelope of `sealSecret`. Any malformed, tampered or foreign envelope fails. */
export function openSecret(key: Uint8Array, userId: number, envelope: string): OpenResult {
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) return { isOpen: false };
  const [nonce, ciphertext, tag] = parts.slice(1).map(decodePart);
  if (nonce?.length !== NONCE_BYTES || tag?.length !== TAG_BYTES || ciphertext === undefined) {
    return { isOpen: false };
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(additionalData(userId));
    decipher.setAuthTag(tag);
    return {
      isOpen: true,
      plaintext: Buffer.concat([decipher.update(ciphertext), decipher.final()]),
    };
  } catch {
    // A failed authentication is the expected typed failure; the partial plaintext is dropped.
    return { isOpen: false };
  }
}
