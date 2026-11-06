import { createHash } from "node:crypto";
import type { Location, TokenMetadata, TokenScope } from "@lorenzh/pulse-contract";
import type { ApiFailure } from "./api-failure.ts";
import { utcTime } from "./check-format.ts";

/** The create presets of #460 s3, scopes in api order. */
export const TOKEN_PRESETS = [
  { id: "read", label: "Read", scopes: ["read"] },
  { id: "checks", label: "Manage checks", scopes: ["read", "checks", "admin"] },
  { id: "incidents", label: "Post incidents", scopes: ["read", "incidents", "admin"] },
  { id: "full", label: "Full access", scopes: ["read", "checks", "incidents", "admin"] },
  { id: "status", label: "Status service", scopes: ["status"] },
  { id: "notify", label: "Notify service", scopes: ["notify"] },
] as const satisfies ReadonlyArray<{ id: string; label: string; scopes: readonly TokenScope[] }>;

export type TokenPreset = (typeof TOKEN_PRESETS)[number];
export type TokenPresetId = TokenPreset["id"];

/** One line per preset card, under its label. */
export const PRESET_DESCRIPTIONS: Record<TokenPresetId, string> = {
  read: "Reads the checks and their configuration. Changes nothing.",
  checks: "Reads checks and creates, changes and deletes them.",
  incidents: "Reads checks and posts incidents.",
  full: "Reads and changes checks and posts incidents.",
  status: "For pulse-status: reads the status page settings and reports what it applied.",
  notify: "For pulse-notify: reads the notify channels, reports them and runs resends.",
};

/** Shown once above the presets: every preset but Read holds `admin`. */
export const ADMIN_PRESET_TEXT =
  "Manage checks, Post incidents and Full access can also create, rotate and revoke tokens with the same or fewer scopes, and read the audit log.";

/** The preset of a form value; `undefined` for anything else. */
export function presetOf(value: string | undefined): TokenPreset | undefined {
  return TOKEN_PRESETS.find((preset) => preset.id === value);
}

const sameScopes = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((scope, i) => scope === b[i]);

/** The preset label when the scopes equal a preset, else the scopes joined with ", ". */
export function accessText(scopes: readonly TokenScope[]): string {
  return (
    TOKEN_PRESETS.find((preset) => sameScopes(preset.scopes, scopes))?.label ?? scopes.join(", ")
  );
}

/** Where the token came from. */
export function sourceText(source: TokenMetadata["source"]): string {
  switch (source) {
    case "api":
      return "Created in pulse-api";
    case "file":
      return "Imported from a token file";
    default: {
      const never: never = source;
      return never;
    }
  }
}

/** The last use in UTC, or `Never`. */
export function lastUsedText(lastUsedAt: number | null): string {
  return lastUsedAt === null ? "Never" : utcTime(lastUsedAt);
}

/** Whether a token is a probe token: its scopes are exactly `["probe"]`. */
export function isProbeToken(token: TokenMetadata): boolean {
  return token.scopes.length === 1 && token.scopes[0] === "probe";
}

/** Not revoked, and without expiry or expiring later than `now`. */
export function isTokenActive(token: TokenMetadata, now: number): boolean {
  return token.revokedAt === null && (token.expiresAt === null || token.expiresAt > now);
}

/** The state text of a token row (section 4). */
export function tokenStateText(token: TokenMetadata, now: number): string {
  if (token.revokedAt !== null) return `Revoked ${utcTime(token.revokedAt)}`;
  if (token.expiresAt !== null && token.expiresAt <= now) {
    return `Expired ${utcTime(token.expiresAt)}`;
  }
  if (token.previousValidUntil !== null && token.previousValidUntil > now) {
    return `Rotated: old secret valid until ${utcTime(token.previousValidUntil)}`;
  }
  return token.expiresAt === null ? "Active" : `Active, expires ${utcTime(token.expiresAt)}`;
}

/** The one active `admin` token when exactly one exists (api `token-scopes.ts:56-63`). */
export function lastActiveAdmin(
  tokens: readonly TokenMetadata[],
  now: number,
): TokenMetadata | undefined {
  const admins = tokens.filter((t) => t.scopes.includes("admin") && isTokenActive(t, now));
  return admins.length === 1 ? admins[0] : undefined;
}

// Probe needs checks (api `token-scopes.ts`); status and notify need admin (#570).
function grantingScope(scope: TokenScope): TokenScope {
  switch (scope) {
    case "probe":
      return "checks";
    case "status":
    case "notify":
      return "admin";
    case "read":
    case "checks":
    case "incidents":
    case "admin":
      return scope;
    default: {
      const never: never = scope;
      return never;
    }
  }
}

/**
 * The first scope of `wanted` that the console token cannot grant (api `token-scopes.ts:38-40`):
 * `probe` needs `checks`, `status` and `notify` need `admin`. `undefined` when every scope can be granted.
 */
export function missingScope(
  wanted: readonly TokenScope[],
  held: readonly TokenScope[],
): TokenScope | undefined {
  for (const scope of wanted) {
    const needed = grantingScope(scope);
    if (!held.includes(needed)) return needed;
  }
  return undefined;
}

/**
 * The confirmation revision: lowercase hex SHA-256 of
 * `[id, name, scopes, location, expiresAt, revokedAt, rotatedAt]`. `lastUsedAt` and
 * `previousValidUntil` are left out, so a probe that uses the token keeps the page fresh.
 */
export function tokenRevision(token: TokenMetadata): string {
  const fields = [
    token.id,
    token.name,
    token.scopes,
    token.location,
    token.expiresAt,
    token.revokedAt,
    token.rotatedAt,
  ];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/** The whole seconds left of an overlap: `max(0, floor((until - now) / 1000))`. */
export function countdownSeconds(previousValidUntil: number, now: number): number {
  return Math.max(0, Math.floor((previousValidUntil - now) / 1000));
}

/** `mm:ss` of a number of seconds. */
export function countdownText(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** Whether the old secret of a rotation still works at `now`. */
export function isOverlapOpen(previousValidUntil: number | null, now: number): boolean {
  return previousValidUntil !== null && previousValidUntil > now;
}

/** What pulse-api answered, for the texts "pulse-api answered <reason>". */
export function answeredReason(failure: ApiFailure): string {
  switch (failure.kind) {
    case "timeout":
      return "nothing within 5 seconds";
    case "refused":
    case "network":
      return "nothing: it cannot be reached";
    case "http":
      return String(failure.status);
    case "wire-mismatch":
      return `with wire version ${failure.label}`;
    case "missing-header":
      return "without the x-pulse-contract header";
    case "invalid":
      return "with an invalid body";
    default: {
      const never: never = failure;
      return never;
    }
  }
}

/** The banner and `503` text when the console cannot tell which token it uses (section 3). */
export function selfUnknownText(failure: ApiFailure): string {
  return `The console cannot tell which token it uses (pulse-api answered ${answeredReason(failure)}). Changes are off until it can. pulse-api needs GET /admin/tokens/self.`;
}

/** One location of the Probes page: an exact, case-sensitive location string. */
export type LocationGroup = {
  name: string;
  /** Every probe credential of the location, in the api's order, never collapsed. */
  credentials: TokenMetadata[];
  activeCount: number;
  /** The `GET /locations` entry; `undefined` when not listed or not read. */
  observed: Location | undefined;
  stateText: string;
  /** "No active token: new results will be refused." for a reporting group without one. */
  warning: string | undefined;
  /** Only inactive credentials and no observed result: the page lists it under "Revoked". */
  isRevokedOnly: boolean;
};

/** The locations read, or the reason they could not be read. */
export type ObservedLocations = readonly Location[] | { failure: ApiFailure };

function groupState(
  observed: Location | undefined,
  activeCount: number,
  locations: ObservedLocations,
): string {
  if (!Array.isArray(locations) && "failure" in locations) {
    return `Last result unknown (pulse-api answered ${answeredReason(locations.failure)})`;
  }
  if (observed?.state === "reporting")
    return `Reporting, last result ${utcTime(observed.lastResultAt)}`;
  if (observed?.state === "silent") {
    return activeCount > 0
      ? `Silent since ${utcTime(observed.lastResultAt)}`
      : "Silent, no active token";
  }
  return activeCount > 0 ? "Awaiting first result" : "No active token";
}

function compareNames(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Groups probe tokens and observed locations by exact name, sorted in code-unit order. */
export function locationGroups(
  probeTokens: readonly TokenMetadata[],
  locations: ObservedLocations,
  now: number,
): LocationGroup[] {
  const listed: readonly Location[] = Array.isArray(locations) ? locations : [];
  const names = new Set<string>();
  for (const token of probeTokens) if (token.location !== null) names.add(token.location);
  for (const location of listed) names.add(location.name);
  return [...names].sort(compareNames).map((name) => {
    const credentials = probeTokens.filter((t) => t.location === name);
    const activeCount = credentials.filter((t) => isTokenActive(t, now)).length;
    const observed = listed.find((l) => l.name === name);
    return {
      name,
      credentials,
      activeCount,
      observed,
      stateText: groupState(observed, activeCount, locations),
      warning:
        observed?.state === "reporting" && activeCount === 0
          ? "No active token: new results will be refused."
          : undefined,
      isRevokedOnly: activeCount === 0 && observed === undefined,
    };
  });
}
