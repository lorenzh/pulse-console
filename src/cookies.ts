import type { SessionStage } from "./account-store.ts";
import type { ConsoleMode } from "./settings.ts";

export type CookieKind = "session" | "csrf" | "setup";

export const SESSION_COOKIE_MAX_AGE = 2_592_000;
export const SETUP_COOKIE_MAX_AGE = 1800;
export const PARTIAL_SESSION_COOKIE_MAX_AGE = 900;

const BASE_NAMES = {
  session: "pulse_console_session",
  csrf: "pulse_console_csrf",
  setup: "pulse_console_setup",
} as const;

function maxAgeOf(kind: CookieKind): number | undefined {
  switch (kind) {
    case "session":
      return SESSION_COOKIE_MAX_AGE;
    case "setup":
      return SETUP_COOKIE_MAX_AGE;
    case "csrf":
      return undefined;
    default: {
      const never: never = kind;
      return never;
    }
  }
}

export function cookieName(kind: CookieKind, mode: ConsoleMode): string {
  const base = BASE_NAMES[kind];
  return mode === "strict-https" ? `__Host-${base}` : base;
}

function serialize(name: string, value: string, maxAge: number | undefined, mode: ConsoleMode) {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  if (mode === "strict-https") parts.push("Secure");
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

/** A Set-Cookie value. A session refresh calls this with the unchanged value. */
export function serializeCookie(kind: CookieKind, value: string, mode: ConsoleMode): string {
  return serialize(cookieName(kind, mode), value, maxAgeOf(kind), mode);
}

/** The session cookie of a stage: a `factor` or `enrol` session lives 900 seconds. */
export function serializeSessionCookie(
  value: string,
  stage: SessionStage,
  mode: ConsoleMode,
): string {
  const maxAge = stage === "full" ? SESSION_COOKIE_MAX_AGE : PARTIAL_SESSION_COOKIE_MAX_AGE;
  return serialize(cookieName("session", mode), value, maxAge, mode);
}

/** A Set-Cookie value that removes the cookie. */
export function serializeCookieDeletion(kind: CookieKind, mode: ConsoleMode): string {
  return serialize(cookieName(kind, mode), "", 0, mode);
}

/** The value of a cookie in a Cookie header; the first one wins when a name repeats. */
export function readCookie(
  header: string | null | undefined,
  kind: CookieKind,
  mode: ConsoleMode,
): string | undefined {
  if (header === null || header === undefined) return undefined;
  const name = cookieName(kind, mode);
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    if (pair.slice(0, index).trim() !== name) continue;
    const value = pair.slice(index + 1).trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}
