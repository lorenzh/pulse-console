import { type Env, readString, StartupError } from "@lorenzh/pulse-kit";

const FILE_VAR = "PULSE_CONSOLE_SECRET_KEY_FILE";
const KEY_HEX = /^[0-9a-f]{64}$/;

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  let value: unknown;
  try {
    // An own data property only, so no getter of the thrown value runs.
    value = Object.getOwnPropertyDescriptor(err, "code")?.value;
  } catch {
    // A Proxy trap threw; the code stays unknown so its text never escapes.
    return undefined;
  }
  return typeof value === "string" && /^E[A-Z0-9]+$/.test(value) ? value : undefined;
}

/**
 * Reads the optional 32-byte key from the file named by PULSE_CONSOLE_SECRET_KEY_FILE. The file
 * holds 64 lowercase hex characters and at most one trailing `\n`, and differs from the admin
 * token. Undefined when unset. Messages never hold the file content.
 */
export function readSecretKey(
  env: Env,
  readFile: (path: string) => string,
  adminToken: string | undefined,
): Uint8Array | undefined {
  const path = readString(env, FILE_VAR);
  if (path === undefined) return undefined;
  const fail = (rule: string, cause?: unknown): StartupError =>
    new StartupError(`${FILE_VAR}=${path}: ${rule}`, { setting: FILE_VAR, cause });
  let raw: string;
  try {
    raw = readFile(path);
  } catch (cause) {
    const code = errorCode(cause);
    throw fail(code === undefined ? "cannot read" : `cannot read (${code})`, cause);
  }
  const text = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!KEY_HEX.test(text)) throw fail("must hold 64 lowercase hex characters");
  if (adminToken !== undefined && text === adminToken) {
    throw fail("must differ from the admin token");
  }
  return Uint8Array.from(Buffer.from(text, "hex"));
}
