import { type Env, readPort, readString, readUrl, StartupError } from "@lorenzh/pulse-kit";
import { readAdminToken } from "./admin-token.ts";
import {
  checkProbeApiUrl,
  checkProbeImage,
  checkProbeNetwork,
  type FieldCheck,
} from "./probe-snippet.ts";
import { readSecretKey } from "./secret-key.ts";

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
  /** The 32 bytes of PULSE_CONSOLE_SECRET_KEY_FILE, or undefined when unset. */
  secretKey: Uint8Array | undefined;
  /** Prefills of the add-location form; never used without the person seeing them. */
  probePrefill: ProbePrefill;
}

/** PULSE_CONSOLE_PROBE_API_URL, _IMAGE and _NETWORK; undefined when unset or blank. */
export type ProbePrefill = {
  apiUrl: string | undefined;
  image: string | undefined;
  network: string | undefined;
};

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
  // readUrl drops a trailing slash, so the path is checked on the value as written.
  const url = new URL(readString(env, name) ?? href);
  if (url.pathname !== "/") {
    throw new StartupError(`${name}: must not have a path other than /`, { setting: name });
  }
  return url.origin;
}

function readProbeSetting(
  env: Env,
  name: string,
  check: (raw: string) => FieldCheck,
): string | undefined {
  const raw = readString(env, name);
  if (raw === undefined) return undefined;
  const result = check(raw);
  if (!result.isValid) throw new StartupError(`${name}: ${result.rule}`, { setting: name });
  return result.value;
}

function readProbePrefill(env: Env): ProbePrefill {
  const apiUrl = readProbeSetting(env, "PULSE_CONSOLE_PROBE_API_URL", checkProbeApiUrl);
  const image = readProbeSetting(env, "PULSE_CONSOLE_PROBE_IMAGE", checkProbeImage);
  const network = readProbeSetting(env, "PULSE_CONSOLE_PROBE_NETWORK", checkProbeNetwork);
  return { apiUrl, image, network };
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
 * PULSE_CONSOLE_HOST, PULSE_CONSOLE_PUBLIC_URL, PULSE_CONSOLE_DB, admin token, PULSE_CONSOLE_SECRET_KEY_FILE,
 * PULSE_CONSOLE_PROBE_API_URL, PULSE_CONSOLE_PROBE_IMAGE, PULSE_CONSOLE_PROBE_NETWORK. DATABASE_URL is
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
  const secretKey = readSecretKey(env, readFile, adminToken);
  const probePrefill = readProbePrefill(env);
  const mode = consoleMode(publicOrigin);
  return { apiUrl, port, host, adminToken, publicOrigin, mode, dbPath, secretKey, probePrefill };
}

/** The settings of the owner recovery command: the database and the public origin only. Pure. */
export function readRecoverySettings(env: Env): {
  dbPath: string;
  publicOrigin: string | undefined;
} {
  const publicOrigin = readPublicOrigin(env);
  const dbPath = readString(env, "PULSE_CONSOLE_DB") ?? DEFAULT_DB;
  return { dbPath, publicOrigin };
}
