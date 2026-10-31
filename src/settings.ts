import { type Env, readPort, readString, readUrl, StartupError } from "@lorenzh/pulse-kit";
import { readAdminToken } from "./admin-token.ts";

export const DEFAULT_PORT = 8082;
export const DEFAULT_HOST = "127.0.0.1";

export interface Settings {
  apiUrl: string;
  port: number;
  host: string;
  adminToken: string | undefined;
}

// The URL parser drops tabs and newlines inside a value, so they are refused before it runs.
// \p{Cc} covers \x00-\x1f, \x7f and the C1 controls \x80-\x9f.
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}]/u;

function readApiUrl(env: Env): string {
  const raw = readString(env, "PULSE_API_URL");
  if (raw === undefined) {
    throw new StartupError("PULSE_API_URL must be set", { setting: "PULSE_API_URL" });
  }
  if (WHITESPACE_OR_CONTROL.test(raw)) {
    throw new StartupError("PULSE_API_URL: must not contain whitespace or control characters", {
      setting: "PULSE_API_URL",
    });
  }
  // readUrl reads the trimmed value again; it is defined, because raw is.
  return readUrl({ PULSE_API_URL: raw }, "PULSE_API_URL") ?? raw;
}

/**
 * Reads and validates the console settings in this order: PULSE_API_URL, PULSE_CONSOLE_PORT,
 * PULSE_CONSOLE_HOST, admin token. The first failure throws a StartupError. Pure: the token
 * file is read through `readFile`.
 */
export function readSettings(env: Env, readFile: (path: string) => string): Settings {
  const apiUrl = readApiUrl(env);
  const port = readPort(env, "PULSE_CONSOLE_PORT", { fallback: DEFAULT_PORT }) ?? DEFAULT_PORT;
  const host = readString(env, "PULSE_CONSOLE_HOST") ?? DEFAULT_HOST;
  const adminToken = readAdminToken(env, readFile);
  return { apiUrl, port, host, adminToken };
}
