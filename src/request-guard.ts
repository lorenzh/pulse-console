import { timingSafeEqual } from "node:crypto";
import type { ConsoleMode } from "./settings.ts";

// A loopback Host with an optional port. DNS rebinding sends another name, so it is refused.
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/;
const NEXT_CHARS = /^[\x21-\x7e]+$/;
const MAX_NEXT_LENGTH = 512;

/** True when the Host header names a loopback address, as loopback mode requires. */
export function isLoopbackHost(host: string | undefined): boolean {
  return host !== undefined && LOOPBACK_HOST.test(host);
}

/** The origin a POST must send: `http://<Host>` in loopback mode, else the public origin. */
export function expectedOrigin(
  mode: ConsoleMode,
  host: string | undefined,
  publicOrigin: string | undefined,
): string | undefined {
  switch (mode) {
    case "loopback":
      return host === undefined ? undefined : `http://${host}`;
    case "strict-https":
    case "strict-http":
      return publicOrigin;
    default: {
      const never: never = mode;
      return never;
    }
  }
}

/** True when `origin` is present, not `null`, and equals the expected origin. */
export function isOriginAllowed(origin: string | undefined, expected: string | undefined): boolean {
  if (origin === undefined || origin === "null" || expected === undefined) return false;
  return origin === expected;
}

/** Timing-safe equality of the form token and the expected token. A missing one never matches. */
export function isCsrfTokenValid(field: string | undefined, expected: string | undefined): boolean {
  if (field === undefined || expected === undefined || expected === "") return false;
  const a = Buffer.from(field, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A same-site path to redirect to after sign-in; anything else becomes `/`. */
export function safeNext(value: string | undefined): string {
  if (value === undefined || value.length > MAX_NEXT_LENGTH) return "/";
  if (!value.startsWith("/") || value[1] === "/" || value[1] === "\\") return "/";
  return NEXT_CHARS.test(value) ? value : "/";
}
