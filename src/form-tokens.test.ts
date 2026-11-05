import { expect, test } from "bun:test";
import { createFormTokens, type FormTokens } from "./form-tokens.ts";

function setup(): { tokens: FormTokens; clock: { now: number } } {
  const clock = { now: 1_000_000 };
  let counter = 0;
  const randomBytes = (size: number): Uint8Array => {
    counter += 1;
    const bytes = new Uint8Array(size);
    new DataView(bytes.buffer).setUint32(0, counter);
    return bytes;
  };
  return { tokens: createFormTokens({ now: () => clock.now, randomBytes }), clock };
}

const S = "s:aaaa";
const A = "a:bbbb";

test("a token is 43 base64url characters, accepted once, then replayed", () => {
  const { tokens } = setup();
  const t = tokens.issue(S, "/sign-out");
  expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(tokens.consume(t, S, "/sign-out")).toBe("accepted");
  expect(tokens.consume(t, S, "/sign-out")).toBe("replayed");
});

test("another binding, another path, an unknown and an empty token are invalid", () => {
  const { tokens } = setup();
  const t = tokens.issue(S, "/sign-out");
  expect(tokens.consume(t, "s:other", "/sign-out")).toBe("invalid");
  expect(tokens.consume(t, S, "/sign-in")).toBe("invalid");
  expect(tokens.consume("unknown-token", S, "/sign-out")).toBe("invalid");
  expect(tokens.consume("", S, "/sign-out")).toBe("invalid");
  expect(tokens.consume(t, S, "/sign-out")).toBe("accepted");
});

test("a token is accepted at issuedAt + 43199999 and invalid at + 43200000", () => {
  const { tokens, clock } = setup();
  const late = tokens.issue(A, "/sign-in");
  const expired = tokens.issue(A, "/sign-in");
  clock.now = 1_000_000 + 43_199_999;
  expect(tokens.consume(late, A, "/sign-in")).toBe("accepted");
  clock.now = 1_000_000 + 43_200_000;
  expect(tokens.consume(expired, A, "/sign-in")).toBe("invalid");
  expect(tokens.consume(late, A, "/sign-in")).toBe("invalid");
});

test("the 101st unused token of a binding evicts the first, not the second", () => {
  const { tokens, clock } = setup();
  const issued: string[] = [];
  for (let i = 0; i < 101; i++) {
    clock.now += 1;
    issued.push(tokens.issue(S, "/sign-out"));
  }
  expect(tokens.consume(issued[0] ?? "", S, "/sign-out")).toBe("invalid");
  expect(tokens.consume(issued[1] ?? "", S, "/sign-out")).toBe("accepted");
  expect(tokens.consume(issued[100] ?? "", S, "/sign-out")).toBe("accepted");
});

test("used tokens stay replayed and do not count toward the 100 unused tokens", () => {
  const { tokens } = setup();
  const first = tokens.issue(S, "/x");
  expect(tokens.consume(first, S, "/x")).toBe("accepted");
  for (let i = 0; i < 100; i++) tokens.issue(S, "/x");
  expect(tokens.consume(first, S, "/x")).toBe("replayed");
});

test("wasUsed is false before use, true after on the same path, false elsewhere and at expiry", () => {
  const { tokens, clock } = setup();
  const t = tokens.issue(S, "/sign-out");
  expect(tokens.wasUsed(t, "/sign-out")).toBe(false);
  expect(tokens.consume(t, S, "/sign-out")).toBe("accepted");
  expect(tokens.wasUsed(t, "/sign-out")).toBe(true);
  expect(tokens.wasUsed(t, "/sign-in")).toBe(false);
  expect(tokens.wasUsed("", "/sign-out")).toBe(false);
  clock.now = 1_000_000 + 43_200_000;
  expect(tokens.wasUsed(t, "/sign-out")).toBe(false);
});

type Full = { tokens: FormTokens; clock: { now: number }; s: string[]; a: string[] };

function fullStore(anonCount: number): Full {
  const { tokens, clock } = setup();
  const s: string[] = [];
  const a: string[] = [];
  for (let session = 0; session < 80; session++) {
    for (let i = 0; i < 100; i++) {
      clock.now += 1;
      s.push(tokens.issue(`s:session-${session}`, "/x"));
    }
  }
  for (let i = 0; i < anonCount; i++) {
    clock.now += 1;
    a.push(tokens.issue(`a:client-${i}`, "/sign-in"));
  }
  return { tokens, clock, s, a };
}

function acceptedCount(full: Full, kind: "s" | "a"): number {
  const list = kind === "s" ? full.s : full.a;
  let count = 0;
  list.forEach((t, i) => {
    const binding = kind === "s" ? `s:session-${Math.floor(i / 100)}` : `a:client-${i}`;
    const path = kind === "s" ? "/x" : "/sign-in";
    if (full.tokens.consume(t, binding, path) === "accepted") count += 1;
  });
  return count;
}

test("full store: one more a: issue removes only the oldest a: entry", () => {
  const full = fullStore(2000);
  expect(full.s.length + full.a.length).toBe(10000);
  full.clock.now += 1;
  const extra = full.tokens.issue("a:client-new", "/sign-in");
  expect(full.tokens.consume(full.a[0] ?? "", "a:client-0", "/sign-in")).toBe("invalid");
  expect(full.tokens.consume(full.s[0] ?? "", "s:session-0", "/x")).toBe("accepted");
  expect(full.tokens.consume(extra, "a:client-new", "/sign-in")).toBe("accepted");
});

test("full store: an 81st session's s: issue removes only the oldest s: entry", () => {
  const full = fullStore(2000);
  full.clock.now += 1;
  const extra = full.tokens.issue("s:session-80", "/x");
  expect(full.tokens.consume(full.s[0] ?? "", "s:session-0", "/x")).toBe("invalid");
  expect(full.tokens.consume(full.a[1] ?? "", "a:client-1", "/sign-in")).toBe("accepted");
  expect(full.tokens.consume(extra, "s:session-80", "/x")).toBe("accepted");
});

test("full store: the counts stay at 8000 s: and 2000 a: after one more of each", () => {
  const full = fullStore(2000);
  full.clock.now += 1;
  full.tokens.issue("a:client-new", "/sign-in");
  full.tokens.issue("s:session-80", "/x");
  expect(acceptedCount(full, "s")).toBe(7999);
  expect(acceptedCount(full, "a")).toBe(1999);
});

test("8000 s: entries and an empty a: pool: one a: issue removes nothing", () => {
  const full = fullStore(0);
  full.clock.now += 1;
  const extra = full.tokens.issue("a:client-new", "/sign-in");
  expect(full.tokens.consume(extra, "a:client-new", "/sign-in")).toBe("accepted");
  expect(acceptedCount(full, "s")).toBe(8000);
});
