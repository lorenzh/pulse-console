import { createHash } from "node:crypto";

/** The two kinds of single-use account link. */
export type LinkKind = "invite" | "reset";

/** A link token: 32 random bytes as base64url, 43 characters. */
const LINK_TOKEN_BYTES = 32;
const LINK_PREFIX = /^\/+(invite|reset)\//;
const LINK_PATH = /^\/(invite|reset)\/([A-Za-z0-9_-]{43})$/;

/** The token of a link path, matched on the raw path byte for byte; undefined when it is no link. */
export function linkOfPath(path: string): { kind: LinkKind; token: string } | undefined {
  const match = LINK_PATH.exec(path);
  const kind = match?.[1];
  const token = match?.[2];
  if (token === undefined || (kind !== "invite" && kind !== "reset")) return undefined;
  return { kind, token };
}

/**
 * Whether a raw path sits under a link prefix (also `//invite/`). Such a path that is no link
 * answers the plain `404 not found`, never the signed-in shell.
 */
export function isLinkPrefixedPath(path: string): boolean {
  return LINK_PREFIX.test(path);
}

/** The metrics and log label of a link path; it never holds the token. */
export function linkPathLabel(kind: LinkKind): "/invite/:token" | "/reset/:token" {
  return kind === "invite" ? "/invite/:token" : "/reset/:token";
}

/** A new link token from `randomBytes`. */
export function newLinkToken(randomBytes: (size: number) => Uint8Array): string {
  return Buffer.from(randomBytes(LINK_TOKEN_BYTES)).toString("base64url");
}

/** The stored form of a link token: its SHA-256 hex digest. */
export function linkDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * The origin of a link: PULSE_CONSOLE_PUBLIC_URL when set, else `http://<Host>` of the request,
 * which already passed the loopback check. Forwarded headers are never read.
 */
export function linkOrigin(publicOrigin: string | undefined, host: string | undefined): string {
  return publicOrigin ?? `http://${host ?? "127.0.0.1"}`;
}

/** The full link of a token. */
export function linkUrl(origin: string, kind: LinkKind, token: string): string {
  return `${origin}/${kind}/${token}`;
}
