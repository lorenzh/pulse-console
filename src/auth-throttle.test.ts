import { describe, expect, test } from "bun:test";
import { type Attempt, type AuthThrottle, createAuthThrottle } from "./auth-throttle.ts";

type Name = "account" | "client";

function signInThrottle(): { throttle: AuthThrottle<Name>; clock: { t: number } } {
  const clock = { t: 0 };
  const throttle = createAuthThrottle<Name>({
    now: () => clock.t,
    tables: ["account", "client"],
    clearsOnSuccess: ["account"],
  });
  return { throttle, clock };
}

function admitted(throttle: AuthThrottle<Name>, account: string, client: string): Attempt {
  const result = throttle.admit({ account, client });
  if (!result.isAdmitted) throw new Error(`refused ${account}/${client}`);
  return result.attempt;
}

function failTimes(throttle: AuthThrottle<Name>, account: string, client: string, n: number) {
  for (let i = 0; i < n; i += 1) admitted(throttle, account, client).fail();
}

function lockPairs(throttle: AuthThrottle<Name>, count: number): void {
  for (let i = 1; i <= count; i += 1) failTimes(throttle, `a${i}@example.com`, `c${i}`, 5);
}

describe("rules", () => {
  test("the fifth failure locks for 900000 ms from that failure; the lock ends exactly then", () => {
    const { throttle, clock } = signInThrottle();
    for (const t of [0, 1000, 2000, 3000, 10_000]) {
      clock.t = t;
      admitted(throttle, "owner@example.com", "a").fail();
    }
    expect(throttle.entry("account", "owner@example.com")).toEqual({
      liveFailures: 0,
      lockedUntil: 910_000,
      inFlight: 0,
    });
    clock.t = 909_999;
    expect(throttle.admit({ account: "owner@example.com", client: "b" })).toEqual({
      isAdmitted: false,
      retryAfterSeconds: 1,
    });
    clock.t = 910_000;
    expect(throttle.admit({ account: "owner@example.com", client: "b" }).isAdmitted).toBe(true);
  });

  test("a blocked attempt does not extend the lock; Retry-After is at most 900", () => {
    const { throttle, clock } = signInThrottle();
    failTimes(throttle, "owner@example.com", "a", 5);
    expect(throttle.admit({ account: "owner@example.com", client: "a" })).toEqual({
      isAdmitted: false,
      retryAfterSeconds: 900,
    });
    clock.t = 500_000;
    throttle.admit({ account: "owner@example.com", client: "a" });
    expect(throttle.entry("account", "owner@example.com")?.lockedUntil).toBe(900_000);
  });

  test("expiry is exclusive at now-900000: failures at 0,1,2,3 min and 15:00.000 do not lock", () => {
    const { throttle, clock } = signInThrottle();
    for (const t of [0, 60_000, 120_000, 180_000, 900_000]) {
      clock.t = t;
      admitted(throttle, "owner@example.com", "a").fail();
    }
    expect(throttle.entry("account", "owner@example.com")).toEqual({
      liveFailures: 4,
      lockedUntil: 0,
      inFlight: 0,
    });
    expect(throttle.admit({ account: "owner@example.com", client: "a" }).isAdmitted).toBe(true);
  });

  test("5 failures for one account lock it from another client", () => {
    const { throttle } = signInThrottle();
    failTimes(throttle, "owner@example.com", "A", 5);
    expect(throttle.admit({ account: "owner@example.com", client: "B" }).isAdmitted).toBe(false);
  });

  test("5 emails from one client lock the client, not the owner account", () => {
    const { throttle } = signInThrottle();
    for (let i = 0; i < 5; i += 1) admitted(throttle, `u${i}@example.com`, "A").fail();
    expect(throttle.admit({ account: "owner@example.com", client: "A" }).isAdmitted).toBe(false);
    expect(throttle.admit({ account: "owner@example.com", client: "B" }).isAdmitted).toBe(true);
  });

  test("success clears only the account key", () => {
    const { throttle } = signInThrottle();
    failTimes(throttle, "owner@example.com", "A", 3);
    admitted(throttle, "owner@example.com", "A").succeed();
    expect(throttle.entry("account", "owner@example.com")?.liveFailures).toBe(0);
    expect(throttle.entry("client", "A")?.liveFailures).toBe(3);
  });

  test("in-flight attempts fill the budget with Retry-After 1; release settles without a failure", () => {
    const { throttle } = signInThrottle();
    const pending = [1, 2, 3, 4, 5].map(() => admitted(throttle, "owner@example.com", "A"));
    expect(throttle.admit({ account: "owner@example.com", client: "A" })).toEqual({
      isAdmitted: false,
      retryAfterSeconds: 1,
    });
    for (const attempt of pending) attempt.release();
    expect(throttle.entry("client", "A")).toEqual({ liveFailures: 0, lockedUntil: 0, inFlight: 0 });
  });

  test("an attempt settles once: a second call changes nothing", () => {
    const { throttle } = signInThrottle();
    const attempt = admitted(throttle, "owner@example.com", "A");
    attempt.fail();
    attempt.fail();
    attempt.succeed();
    expect(throttle.entry("account", "owner@example.com")).toEqual({
      liveFailures: 1,
      lockedUntil: 0,
      inFlight: 0,
    });
  });

  test("the setup limiter is a separate client-only instance, and a new instance starts empty", () => {
    const clock = { t: 0 };
    const setup = createAuthThrottle<"client">({
      now: () => clock.t,
      tables: ["client"],
      clearsOnSuccess: [],
    });
    const signIn = signInThrottle().throttle;
    for (let i = 0; i < 5; i += 1) {
      const r = setup.admit({ client: "A" });
      if (r.isAdmitted) r.attempt.fail();
    }
    expect(setup.admit({ client: "A" }).isAdmitted).toBe(false);
    expect(signIn.admit({ account: "x@example.com", client: "A" }).isAdmitted).toBe(true);
    const restarted = createAuthThrottle<"client">({
      now: () => clock.t,
      tables: ["client"],
      clearsOnSuccess: [],
    });
    expect(restarted.admit({ client: "A" }).isAdmitted).toBe(true);
  });
});

describe("capacity with the default 10000-key bound", () => {
  test("saturation with attempts in flight admits exactly 5 owner attempts, never 9", () => {
    const { throttle, clock } = signInThrottle();
    lockPairs(throttle, 9999);
    clock.t = 1000;
    const pending = [1, 2, 3, 4].map(() => admitted(throttle, "owner@example.com", "v"));
    expect(throttle.size("account")).toBe(10_000);
    expect(throttle.size("client")).toBe(10_000);
    clock.t = 2000;
    expect(throttle.admit({ account: "new@example.com", client: "n" })).toEqual({
      isAdmitted: false,
      retryAfterSeconds: 1,
    });
    expect(throttle.size("account")).toBe(10_000);
    expect(throttle.size("client")).toBe(10_000);
    expect(throttle.entry("account", "owner@example.com")?.inFlight).toBe(4);
    expect(throttle.entry("client", "v")?.inFlight).toBe(4);
    expect(throttle.entry("account", "new@example.com")).toBeUndefined();
    expect(throttle.entry("client", "n")).toBeUndefined();
    clock.t = 3000;
    for (const attempt of pending) attempt.fail();
    clock.t = 4000;
    let admissions = 4;
    if (throttle.admit({ account: "owner@example.com", client: "v" }).isAdmitted) admissions += 1;
    expect(throttle.admit({ account: "owner@example.com", client: "v" })).toEqual({
      isAdmitted: false,
      retryAfterSeconds: 1,
    });
    expect(admissions).toBe(5);
  });

  test("saturation with locks only refuses with Retry-After 899, then admits at 900000", () => {
    const { throttle, clock } = signInThrottle();
    lockPairs(throttle, 10_000);
    clock.t = 1000;
    expect(throttle.admit({ account: "new@example.com", client: "n" })).toEqual({
      isAdmitted: false,
      retryAfterSeconds: 899,
    });
    clock.t = 900_000;
    expect(throttle.admit({ account: "new@example.com", client: "n" }).isAdmitted).toBe(true);
  });

  test("atomic refusal: a refused attempt creates no entry and no reservation in either table", () => {
    const { throttle, clock } = signInThrottle();
    lockPairs(throttle, 10_000);
    clock.t = 1000;
    // A locked known client refuses first; the full account table gets no entry.
    expect(throttle.admit({ account: "new@example.com", client: "c1" })).toEqual({
      isAdmitted: false,
      retryAfterSeconds: 899,
    });
    expect(throttle.admit({ account: "new@example.com", client: "n" })).toEqual({
      isAdmitted: false,
      retryAfterSeconds: 899,
    });
    expect(throttle.size("account")).toBe(10_000);
    expect(throttle.size("client")).toBe(10_000);
    expect(throttle.entry("client", "n")).toBeUndefined();
    expect(throttle.entry("client", "c1")).toEqual({
      liveFailures: 0,
      lockedUntil: 900_000,
      inFlight: 0,
    });
  });

  test("eviction drops the unlocked idle-free pair with the oldest failure; an in-flight one is kept", () => {
    const { throttle, clock } = signInThrottle();
    lockPairs(throttle, 9999);
    clock.t = 1000;
    failTimes(throttle, "old@example.com", "o", 2);
    clock.t = 2000;
    expect(throttle.admit({ account: "fresh@example.com", client: "f" }).isAdmitted).toBe(true);
    expect(throttle.entry("account", "old@example.com")).toBeUndefined();
    expect(throttle.entry("client", "o")).toBeUndefined();

    const second = signInThrottle();
    lockPairs(second.throttle, 9999);
    second.clock.t = 1000;
    failTimes(second.throttle, "old@example.com", "o", 2);
    admitted(second.throttle, "old@example.com", "o");
    second.clock.t = 2000;
    expect(second.throttle.admit({ account: "fresh@example.com", client: "f" })).toEqual({
      isAdmitted: false,
      retryAfterSeconds: 1,
    });
    expect(second.throttle.entry("account", "old@example.com")?.inFlight).toBe(1);
    expect(second.throttle.entry("client", "o")?.inFlight).toBe(1);
  });

  test("idle cleanup drops only idle entries; eviction then picks the oldest last failure", () => {
    const { throttle, clock } = signInThrottle();
    lockPairs(throttle, 9997);
    clock.t = 1000;
    failTimes(throttle, "older@example.com", "x1", 1);
    clock.t = 2000;
    failTimes(throttle, "newer@example.com", "x2", 1);
    admitted(throttle, "pending@example.com", "x3");
    expect(throttle.size("account")).toBe(10_000);
    clock.t = 3000;
    expect(throttle.admit({ account: "fresh@example.com", client: "f" }).isAdmitted).toBe(true);
    expect(throttle.entry("account", "older@example.com")).toBeUndefined();
    expect(throttle.entry("account", "newer@example.com")?.liveFailures).toBe(1);
    expect(throttle.entry("account", "pending@example.com")?.inFlight).toBe(1);
    // The 900000 ms later every failure is gone: the idle entries are dropped before eviction.
    clock.t = 902_001;
    expect(throttle.admit({ account: "later@example.com", client: "l" }).isAdmitted).toBe(true);
    expect(throttle.entry("account", "newer@example.com")).toBeUndefined();
    expect(throttle.entry("account", "pending@example.com")?.inFlight).toBe(1);
  });
});
