import { expect, test } from "bun:test";
import { readSecretKey } from "./secret-key.ts";

const HEX = "0123456789abcdef".repeat(4);
const PATH = "/run/key";
const env = { PULSE_CONSOLE_SECRET_KEY_FILE: PATH };
const fileOf =
  (content: string) =>
  (path: string): string => {
    if (path !== PATH) throw new Error("wrong path");
    return content;
  };

test("unset gives no key", () => {
  expect(readSecretKey({}, fileOf(HEX), undefined)).toBeUndefined();
});

test("64 lowercase hex with one trailing newline is the key", () => {
  const key = readSecretKey(env, fileOf(`${HEX}\n`), undefined);
  expect(Buffer.from(key ?? []).toString("hex")).toBe(HEX);
  expect(readSecretKey(env, fileOf(HEX), undefined)).toHaveLength(32);
});

test("malformed key files are refused without their content", () => {
  const bad = [
    HEX.toUpperCase(),
    HEX.slice(1),
    `${HEX}0`,
    `${HEX}\n\n`,
    ` ${HEX}`,
    `${HEX}\r\n`,
    "not-a-key",
  ];
  for (const content of bad) {
    let message = "";
    try {
      readSecretKey(env, fileOf(content), undefined);
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    expect(message).toBe(
      "PULSE_CONSOLE_SECRET_KEY_FILE=/run/key: must hold 64 lowercase hex characters",
    );
  }
});

test("a missing file names the error code", () => {
  const missing = (): string => {
    throw Object.assign(new Error(`ENOENT secret ${HEX}`), { code: "ENOENT" });
  };
  expect(() => readSecretKey(env, missing, undefined)).toThrow(
    /^PULSE_CONSOLE_SECRET_KEY_FILE=\/run\/key: cannot read \(ENOENT\)$/,
  );
});

test("a key equal to the admin token is refused", () => {
  expect(() => readSecretKey(env, fileOf(`${HEX}\n`), HEX)).toThrow(
    /^PULSE_CONSOLE_SECRET_KEY_FILE=\/run\/key: must differ from the admin token$/,
  );
});
