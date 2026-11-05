// Literal pulse-api token rows for tests. Every row passes contract `validateTokenMetadata`.

import type { TokenMetadata } from "@lorenzh/pulse-contract";

/** 2026-01-01 00:00:00 UTC, the fixed clock of the token tests. */
export const T0 = 1767225600000;

/** The id of the console's own token in the fixtures. */
export const SELF_ID = "tok_5e1f00000000000000000001";

/** A fake secret; tests scan answers and files for it. */
export const FAKE_SECRET = "pulse_fakeSecretValue0123456789abcdef";

/** An admin-side token row; `overrides` replace single fields. */
export function adminToken(overrides: Partial<TokenMetadata> = {}): TokenMetadata {
  return {
    id: "tok_ad0000000000000000000002",
    name: "ops",
    scopes: ["read", "checks", "admin"],
    location: null,
    source: "api",
    createdAt: T0 - 86400000,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    rotatedAt: null,
    previousValidUntil: null,
    ...overrides,
  };
}

/** The console's own token: full access, imported from a token file. */
export function selfToken(overrides: Partial<TokenMetadata> = {}): TokenMetadata {
  return adminToken({
    id: SELF_ID,
    name: "console",
    scopes: ["read", "checks", "incidents", "admin"],
    source: "file",
    ...overrides,
  });
}

/** A probe token bound to `location`. */
export function probeToken(
  location: string,
  overrides: Partial<TokenMetadata> = {},
): TokenMetadata {
  return adminToken({
    id: "tok_b0be00000000000000000003",
    name: `probe ${location}`,
    scopes: ["probe"],
    location,
    ...overrides,
  });
}
