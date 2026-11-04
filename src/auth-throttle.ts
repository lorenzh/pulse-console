export const THROTTLE_WINDOW_MS = 900_000;
export const THROTTLE_MAX_FAILURES = 5;
export const THROTTLE_MAX_KEYS = 10_000;

type Entry = { failures: number[]; lockedUntil: number; inFlight: number };
type Table = Map<string, Entry>;

export type EntryView = { liveFailures: number; lockedUntil: number; inFlight: number };

/** One admitted attempt. Exactly one of its methods should run; later calls do nothing. */
export type Attempt = {
  fail: () => void;
  succeed: () => void;
  /** Settles without a failure, for an error that ends the request. */
  release: () => void;
};

export type Admission =
  | { isAdmitted: true; attempt: Attempt }
  | { isAdmitted: false; retryAfterSeconds: number };

export type AuthThrottle<K extends string> = {
  /** Admits an attempt for one key per table, or refuses it. Synchronous and atomic. */
  admit: (keys: Readonly<Record<K, string>>) => Admission;
  size: (table: K) => number;
  entry: (table: K, key: string) => EntryView | undefined;
};

export type AuthThrottleOptions<K extends string> = {
  now: () => number;
  tables: readonly K[];
  /** Tables whose failures a success clears (the account key for sign-in). */
  clearsOnSuccess: readonly K[];
  maxKeys?: number;
};

function liveFailures(entry: Entry, now: number): number {
  return entry.failures.filter((t) => now - THROTTLE_WINDOW_MS < t).length;
}

function isLocked(entry: Entry, now: number): boolean {
  return now < entry.lockedUntil;
}

function isIdle(entry: Entry, now: number): boolean {
  return entry.inFlight === 0 && !isLocked(entry, now) && liveFailures(entry, now) === 0;
}

function lastFailure(entry: Entry): number {
  return entry.failures.at(-1) ?? Number.NEGATIVE_INFINITY;
}

/** The entry to evict after the idle ones are gone, or undefined. */
function evictionCandidate(table: Table, now: number): string | undefined {
  let chosen: string | undefined;
  let oldest = Number.POSITIVE_INFINITY;
  for (const [key, entry] of table) {
    if (entry.inFlight > 0 || isLocked(entry, now)) continue;
    const last = lastFailure(entry);
    if (chosen === undefined || last < oldest) {
      chosen = key;
      oldest = last;
    }
  }
  return chosen;
}

function hasIdle(table: Table, now: number): boolean {
  for (const entry of table.values()) if (isIdle(entry, now)) return true;
  return false;
}

function capacityRetryAfter(table: Table, now: number): number {
  let minRemaining = THROTTLE_WINDOW_MS;
  for (const entry of table.values()) {
    if (entry.inFlight > 0) return 1;
    minRemaining = Math.min(minRemaining, entry.lockedUntil - now);
  }
  return Math.max(1, Math.ceil(minRemaining / 1000));
}

/** Drops idle entries, then evicts one entry if the table is still full. */
function makeRoom(table: Table, now: number, maxKeys: number): void {
  for (const [key, entry] of table) if (isIdle(entry, now)) table.delete(key);
  if (table.size < maxKeys) return;
  const victim = evictionCandidate(table, now);
  if (victim !== undefined) table.delete(victim);
}

/**
 * The failure limiter: 5 live failures in 15 minutes lock a key for 15 minutes from the 5th.
 * In-flight attempts count against the budget, and an entry with one is never removed.
 */
export function createAuthThrottle<K extends string>(
  options: AuthThrottleOptions<K>,
): AuthThrottle<K> {
  const maxKeys = options.maxKeys ?? THROTTLE_MAX_KEYS;
  const tables = new Map<K, Table>(options.tables.map((name) => [name, new Map()]));
  const tableOf = (name: K): Table => {
    const table = tables.get(name);
    if (table === undefined) throw new RangeError(`unknown throttle table ${name}`);
    return table;
  };

  function budgetRetryAfter(keys: Readonly<Record<K, string>>, now: number): number | undefined {
    let isRefused = false;
    let remaining = 0;
    for (const name of options.tables) {
      const entry = tableOf(name).get(keys[name]);
      if (entry === undefined) continue;
      if (isLocked(entry, now)) {
        isRefused = true;
        remaining = Math.max(remaining, entry.lockedUntil - now);
      } else if (liveFailures(entry, now) + entry.inFlight >= THROTTLE_MAX_FAILURES) {
        isRefused = true;
      }
    }
    return isRefused ? Math.max(1, Math.ceil(remaining / 1000)) : undefined;
  }

  function capacityRefusal(keys: Readonly<Record<K, string>>, now: number): number | undefined {
    for (const name of options.tables) {
      const table = tableOf(name);
      if (table.has(keys[name]) || table.size < maxKeys) continue;
      if (hasIdle(table, now) || evictionCandidate(table, now) !== undefined) continue;
      return capacityRetryAfter(table, now);
    }
    return undefined;
  }

  function attemptOf(reserved: readonly [K, Entry][]): Attempt {
    let isSettled = false;
    const settle = (apply: (name: K, entry: Entry) => void) => (): void => {
      if (isSettled) return;
      isSettled = true;
      for (const [name, entry] of reserved) {
        entry.inFlight -= 1;
        apply(name, entry);
      }
    };
    return {
      fail: settle((_name, entry) => recordFailure(entry, options.now())),
      succeed: settle((name, entry) => {
        if (options.clearsOnSuccess.includes(name)) entry.failures = [];
      }),
      release: settle(() => undefined),
    };
  }

  function recordFailure(entry: Entry, now: number): void {
    entry.failures = entry.failures.filter((t) => now - THROTTLE_WINDOW_MS < t);
    entry.failures.push(now);
    if (entry.failures.length >= THROTTLE_MAX_FAILURES) {
      entry.lockedUntil = now + THROTTLE_WINDOW_MS;
      entry.failures = [];
    }
  }

  return {
    admit(keys) {
      const now = options.now();
      const budget = budgetRetryAfter(keys, now);
      if (budget !== undefined) return { isAdmitted: false, retryAfterSeconds: budget };
      const capacity = capacityRefusal(keys, now);
      if (capacity !== undefined) return { isAdmitted: false, retryAfterSeconds: capacity };
      // From here to the return there is no await: room, creation and both reservations
      // happen in one step, so no other attempt can see a half-made admission.
      const reserved: [K, Entry][] = [];
      for (const name of options.tables) {
        const table = tableOf(name);
        let entry = table.get(keys[name]);
        if (entry === undefined) {
          if (table.size >= maxKeys) makeRoom(table, now, maxKeys);
          entry = { failures: [], lockedUntil: 0, inFlight: 0 };
          table.set(keys[name], entry);
        }
        entry.inFlight += 1;
        reserved.push([name, entry]);
      }
      return { isAdmitted: true, attempt: attemptOf(reserved) };
    },
    size: (name) => tableOf(name).size,
    entry(name, key) {
      const entry = tableOf(name).get(key);
      if (entry === undefined) return undefined;
      const now = options.now();
      return {
        liveFailures: liveFailures(entry, now),
        lockedUntil: entry.lockedUntil,
        inFlight: entry.inFlight,
      };
    },
  };
}
