import { type Env, readPort, readString, readUrl, StartupError } from "@lorenzh/pulse-kit";
import { readAdminToken } from "./admin-token.ts";

export const DEFAULT_PORT = 8082;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_DB = "./console.db";

/** How the console checks `Host` and `Origin`, and how it marks cookies. */
export type ConsoleMode = "loopback" | "strict-https" | "strict-http";

export interface Settings {
  apiUrl: string;
  port: number;
  host: string;
  adminToken: string | undefined;
  /** The origin of PULSE_CONSOLE_PUBLIC_URL, or undefined in loopback mode without it. */
  publicOrigin: string | undefined;
  mode: ConsoleMode;
  dbPath: string;
}

// The URL parser drops tabs and newlines inside a value, so they are refused before it runs.
// \p{Cc} covers \x00-\x1f, \x7f and the C1 controls \x80-\x9f.
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}]/u;

const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

/** The PULSE_API_URL rules for any URL setting; undefined when unset or blank. */
function readCheckedUrl(env: Env, name: string): string | undefined {
  const raw = readString(env, name);
  if (raw === undefined) return undefined;
  if (WHITESPACE_OR_CONTROL.test(raw)) {
    throw new StartupError(`${name}: must not contain whitespace or control characters`, {
      setting: name,
    });
  }
  // readUrl reads the trimmed value again; it is defined, because raw is.
  return readUrl({ [name]: raw }, name) ?? raw;
}

function readApiUrl(env: Env): string {
  const url = readCheckedUrl(env, "PULSE_API_URL");
  if (url === undefined) {
    throw new StartupError("PULSE_API_URL must be set", { setting: "PULSE_API_URL" });
  }
  return url;
}

function readPublicOrigin(env: Env): string | undefined {
  const name = "PULSE_CONSOLE_PUBLIC_URL";
  const href = readCheckedUrl(env, name);
  if (href === undefined) return undefined;
  const url = new URL(href);
  if (url.pathname !== "/") {
    throw new StartupError(`${name}: must not have a path other than /`, { setting: name });
  }
  return url.origin;
}

/** The mode that a public origin selects. Pure. */
export function consoleMode(publicOrigin: string | undefined): ConsoleMode {
  if (publicOrigin === undefined) return "loopback";
  const url = new URL(publicOrigin);
  if (url.protocol === "https:") return "strict-https";
  return LOOPBACK_HOSTS.includes(url.hostname) ? "loopback" : "strict-http";
}

/**
 * Reads and validates the console settings in this order: PULSE_API_URL, PULSE_CONSOLE_PORT,
 * PULSE_CONSOLE_HOST, PULSE_CONSOLE_PUBLIC_URL, PULSE_CONSOLE_DB, admin token. DATABASE_URL is
 * not read. The first failure throws a StartupError. Pure: the token
 * file is read through `readFile`.
 */
export function readSettings(env: Env, readFile: (path: string) => string): Settings {
  const apiUrl = readApiUrl(env);
  const port = readPort(env, "PULSE_CONSOLE_PORT", { fallback: DEFAULT_PORT }) ?? DEFAULT_PORT;
  const host = readString(env, "PULSE_CONSOLE_HOST") ?? DEFAULT_HOST;
  const publicOrigin = readPublicOrigin(env);
  const dbPath = readString(env, "PULSE_CONSOLE_DB") ?? DEFAULT_DB;
  const adminToken = readAdminToken(env, readFile);
  return { apiUrl, port, host, adminToken, publicOrigin, mode: consoleMode(publicOrigin), dbPath };
}
