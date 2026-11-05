/** A form token lives 12 hours from its issue time. */
export const FORM_TOKEN_LIFETIME_MS = 43_200_000;
/** Entries of the pre-session (`a:`) pool, used or unused. */
export const FORM_TOKEN_ANON_MAX = 2000;
/** Entries of the signed-in (`s:`) pool, used or unused. */
export const FORM_TOKEN_SESSION_MAX = 8000;
/** Unused tokens of one binding. */
export const FORM_TOKEN_BINDING_MAX = 100;

const TOKEN_BYTES = 32;

export type FormTokenResult = "accepted" | "replayed" | "invalid";

export interface FormTokens {
  /** Issues a token for this binding (`a:` or `s:` prefix) and action path. */
  issue: (binding: string, path: string) => string;
  /** Uses the token up in one synchronous step. */
  consume: (token: string, binding: string, path: string) => FormTokenResult;
  /** True when the token was used on this path and has not expired. Uses nothing up. */
  wasUsed: (token: string, path: string) => boolean;
}

type Entry = { binding: string; path: string; issuedAt: number; isUsed: boolean };
type Pool = { max: number; entries: Map<string, Entry> };

/** The single-use form token store: in memory, two separate pools, no timer. */
export function createFormTokens(deps: {
  now: () => number;
  randomBytes: (size: number) => Uint8Array;
}): FormTokens {
  const anon: Pool = { max: FORM_TOKEN_ANON_MAX, entries: new Map() };
  const signedIn: Pool = { max: FORM_TOKEN_SESSION_MAX, entries: new Map() };
  // Unused tokens per binding, in insertion order.
  const unused = new Map<string, Set<string>>();

  const poolOf = (binding: string): Pool => (binding.startsWith("a:") ? anon : signedIn);
  const isExpired = (e: Entry, now: number): boolean => now >= e.issuedAt + FORM_TOKEN_LIFETIME_MS;

  function forget(pool: Pool, token: string, entry: Entry): void {
    pool.entries.delete(token);
    const set = unused.get(entry.binding);
    if (set === undefined) return;
    set.delete(token);
    if (set.size === 0) unused.delete(entry.binding);
  }

  // Entries sit in issue order, so the scan stops at the first live one. If the clock went
  // back, a later expired entry stays until a lookup or eviction; it is invalid either way.
  function removeExpired(now: number): void {
    for (const pool of [anon, signedIn]) {
      for (const [token, entry] of pool.entries) {
        if (!isExpired(entry, now)) break;
        forget(pool, token, entry);
      }
    }
  }

  // Oldest: the smallest issuedAt, ties broken by insertion order.
  function oldestOf(tokens: Iterable<string>, pool: Pool): string | undefined {
    let oldest: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const token of tokens) {
      const at = pool.entries.get(token)?.issuedAt ?? Number.POSITIVE_INFINITY;
      if (at < oldestAt) {
        oldest = token;
        oldestAt = at;
      }
    }
    return oldest;
  }

  function evict(pool: Pool, token: string | undefined): void {
    if (token === undefined) return;
    const entry = pool.entries.get(token);
    if (entry !== undefined) forget(pool, token, entry);
  }

  function lookup(token: string, now: number): { pool: Pool; entry: Entry } | undefined {
    for (const pool of [anon, signedIn]) {
      const entry = pool.entries.get(token);
      if (entry !== undefined) return isExpired(entry, now) ? undefined : { pool, entry };
    }
    return undefined;
  }

  return {
    issue: (binding, path) => {
      const now = deps.now();
      removeExpired(now);
      const pool = poolOf(binding);
      const own = unused.get(binding) ?? new Set<string>();
      if (own.size >= FORM_TOKEN_BINDING_MAX) evict(pool, oldestOf(own, pool));
      if (pool.entries.size >= pool.max) evict(pool, oldestOf(pool.entries.keys(), pool));
      const token = Buffer.from(deps.randomBytes(TOKEN_BYTES)).toString("base64url");
      pool.entries.set(token, { binding, path, issuedAt: now, isUsed: false });
      own.add(token);
      unused.set(binding, own);
      return token;
    },
    consume: (token, binding, path) => {
      const now = deps.now();
      removeExpired(now);
      const found = token === "" ? undefined : lookup(token, now);
      if (found === undefined) return "invalid";
      const { entry } = found;
      if (entry.binding !== binding || entry.path !== path) return "invalid";
      if (entry.isUsed) return "replayed";
      entry.isUsed = true;
      const set = unused.get(binding);
      set?.delete(token);
      if (set?.size === 0) unused.delete(binding);
      return "accepted";
    },
    wasUsed: (token, path) => {
      const now = deps.now();
      removeExpired(now);
      const found = token === "" ? undefined : lookup(token, now);
      return found?.entry.isUsed === true && found.entry.path === path;
    },
  };
}
