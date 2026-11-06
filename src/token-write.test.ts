import { describe, expect, test } from "bun:test";
import { createLogger } from "@lorenzh/pulse-kit";
import { adminToken, FAKE_SECRET, probeToken, T0 } from "../test/token-fixtures.ts";
import type { User } from "./account-store.ts";
import type { FetchLike } from "./api-read.ts";
import type { PeopleEvent } from "./people-log.ts";
import type { PageRequest } from "./protected-route.ts";
import { sendTokenWrite, type TokenWrite, type TokenWriteDeps } from "./token-write.ts";

const API = "http://api.test";
const WIRE = { "x-pulse-contract": "1", "content-type": "application/json" };
const ADMIN: User = {
  id: 7,
  email: "a@example.com",
  name: "Ada",
  passwordHash: "h",
  role: "admin",
};

const UNKNOWN =
  "The result is unknown. Open the list to see whether the token was created, rotated or revoked.";
const LOST =
  "pulse-api made the change, but its answer could not be read, so the secret cannot be shown. Open the list: revoke the new token, or rotate it again after the overlap.";
const SAVED_NOT_LOGGED = "Saved in pulse-api. The People log row could not be written.";

type Seen = { url: string; method: string; body: string; redirect: string | undefined };
type Reply = Response | "held" | "network";

type Harness = {
  deps: TokenWriteDeps;
  seen: Seen[];
  people: PeopleEvent[];
  logs: string[];
  timeouts: number[];
};

function harness(
  reply: () => Reply,
  options: { isPeopleBroken?: boolean; isSessionGone?: boolean; storedRole?: User["role"] } = {},
): Harness {
  const seen: Seen[] = [];
  const people: PeopleEvent[] = [];
  const logs: string[] = [];
  const timeouts: number[] = [];
  let fireTimeout: () => void = () => undefined;
  const fetchFn: FetchLike = async (input, init) => {
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
      redirect: init?.redirect,
    });
    const next = reply();
    if (next === "held") {
      // The reply never arrives; the fake clock reaches the 5000 ms timeout instead.
      queueMicrotask(fireTimeout);
      return new Promise<Response>(() => undefined);
    }
    if (next === "network") throw new TypeError("fetch failed");
    return next;
  };
  const deps: TokenWriteDeps = {
    store: {
      isGuardHeld: () => options.isSessionGone !== true,
      userById: () => ({ ...ADMIN, role: options.storedRole ?? "admin" }),
      appendPeople: (event) => {
        if (options.isPeopleBroken === true) throw new RangeError("disk full");
        people.push(event);
      },
    },
    fetch: fetchFn,
    adminToken: "console-admin-token-value",
    schedule: (fn, ms) => {
      timeouts.push(ms);
      fireTimeout = fn;
      return () => undefined;
    },
    now: () => T0,
    log: createLogger({ level: "debug", write: (_level, line) => logs.push(line) }),
  };
  return { deps, seen, people, logs, timeouts };
}

const request: PageRequest = {
  method: "POST",
  path: "/tokens/new",
  user: ADMIN,
  sessionId: "session-id",
  linkOrigin: "http://console.test",
  role: "admin",
  csrf: "csrf",
  fields: {},
  lists: {},
  query: new URLSearchParams(),
  issueFormToken: () => "form-token",
};

const createWrite: TokenWrite = {
  action: "token.create",
  url: `${API}/admin/tokens`,
  body: JSON.stringify({ name: "ops", scopes: ["read", "checks", "admin"] }),
  value: "scopes=read,checks,admin",
};
const rotateWrite: TokenWrite = {
  action: "token.rotate",
  url: `${API}/admin/tokens/${probeToken("eu").id}/rotate`,
  tokenId: probeToken("eu").id,
  value: "location=eu",
};
const revokeWrite: TokenWrite = {
  action: "token.revoke",
  url: `${API}/admin/tokens/${adminToken().id}/revoke`,
  tokenId: adminToken().id,
  value: "scopes=read,checks,admin",
};

const secretBody = (token = adminToken()): string =>
  JSON.stringify({ token, secret: FAKE_SECRET, previousValidUntil: null });
const json = (status: number, body: string, headers: Record<string, string> = WIRE): Response =>
  new Response(body, { status, headers });

function run(h: Harness, write: TokenWrite) {
  return sendTokenWrite(h.deps, request, "admin", "/tokens", write);
}

describe("confirmed writes", () => {
  test("create 201 with a valid body shows the secret and logs token.create", async () => {
    const h = harness(() => json(201, secretBody()));
    const answer = await run(h, createWrite);
    expect(answer.kind).toBe("secret");
    if (answer.kind === "secret") {
      expect(answer.answer.secret).toBe(FAKE_SECRET);
      expect(answer.notLogged).toBeUndefined();
    }
    expect(h.seen).toEqual([
      {
        url: "http://api.test/admin/tokens",
        method: "POST",
        body: '{"name":"ops","scopes":["read","checks","admin"]}',
        redirect: "manual",
      },
    ]);
    expect(h.timeouts).toEqual([5000]);
    expect(h.people).toEqual([
      {
        at: T0,
        actor: { kind: "user", person: { id: 7, email: "a@example.com", name: "Ada" } },
        action: "token.create",
        target: { kind: "token", id: "tok_ad0000000000000000000002" },
        value: "scopes=read,checks,admin",
      },
    ]);
  });

  test("rotate 200 and revoke 200 send {} and log their actions", async () => {
    const rotate = harness(() => json(200, secretBody(probeToken("eu"))));
    expect((await run(rotate, rotateWrite)).kind).toBe("secret");
    expect(rotate.seen.map((s) => s.body)).toEqual(["{}"]);
    expect(rotate.people.map((e) => [e.action, e.target, e.value])).toEqual([
      ["token.rotate", { kind: "token", id: "tok_b0be00000000000000000003" }, "location=eu"],
    ]);
    const revoke = harness(() => json(200, JSON.stringify(adminToken({ revokedAt: T0 }))));
    expect(await run(revoke, revokeWrite)).toEqual({ kind: "revoked", notLogged: undefined });
    expect(revoke.seen.map((s) => [s.url, s.body])).toEqual([
      ["http://api.test/admin/tokens/tok_ad0000000000000000000002/revoke", "{}"],
    ]);
    expect(revoke.people.map((e) => e.action)).toEqual(["token.revoke"]);
  });

  test.each([
    ["create", createWrite, () => json(201, secretBody())],
    ["rotate", rotateWrite, () => json(200, secretBody(probeToken("eu")))],
    ["revoke", revokeWrite, () => json(200, "{}")],
  ] as const)(
    "a confirmed %s with a broken People log adds the saved text",
    async (_n, write, reply) => {
      const h = harness(reply, { isPeopleBroken: true });
      const answer = await run(h, write);
      expect(answer.kind === "secret" || answer.kind === "revoked").toBe(true);
      if (answer.kind === "secret" || answer.kind === "revoked") {
        expect(answer.notLogged).toBe(SAVED_NOT_LOGGED);
      }
      expect(h.logs.filter((l) => l.includes('"token change not logged"'))).toEqual([
        expect.stringContaining('"error":"RangeError"'),
      ]);
      expect(h.logs.join("\n")).not.toContain("disk full");
      expect(h.seen).toHaveLength(1);
    },
  );
});

describe("lost answer", () => {
  test.each([
    ["body {}", () => json(201, "{}")],
    ["empty body", () => json(201, "")],
    ["not JSON", () => json(201, "not json")],
    ["200 instead of 201", () => json(200, secretBody())],
  ])("create 2xx with wire ok and %s is the lost-answer 502", async (_n, reply) => {
    const h = harness(reply);
    expect(await run(h, createWrite)).toEqual({
      kind: "text",
      status: 502,
      message: LOST,
      reason: "other",
    });
    expect(h.seen).toHaveLength(1);
    expect(h.people.map((e) => [e.target, e.value])).toEqual([
      [{ kind: "token", id: undefined }, "scopes=read,checks,admin (unknown)"],
    ]);
  });

  test("with a broken People log it adds only the not-written sentence", async () => {
    const h = harness(() => json(200, "{}"), { isPeopleBroken: true });
    expect(await run(h, rotateWrite)).toEqual({
      kind: "text",
      status: 502,
      message: `${LOST} The People log row could not be written.`,
      reason: "other",
    });
  });
});

describe("refused writes", () => {
  const long = "m".repeat(1200);
  test.each([
    ["400", 400, { kind: "form", status: 422, message: "bad name" }],
    ["422", 422, { kind: "form", status: 422, message: "bad name" }],
    ["401", 401, { kind: "text", status: 502, message: "", reason: "token-rejected" }],
    [
      "403",
      403,
      {
        kind: "text",
        status: 502,
        message: "pulse-api refused: the console token lacks a scope this token holds.",
        reason: "other",
      },
    ],
    ["404", 404, { kind: "text", status: 404, message: "", reason: "not-found" }],
    ["409", 409, { kind: "form", status: 409, message: "bad name" }],
    [
      "429",
      429,
      {
        kind: "text",
        status: 503,
        message: "pulse-api is throttling the console. Try again in a minute.",
        reason: "other",
      },
    ],
    [
      "418",
      418,
      {
        kind: "text",
        status: 502,
        message: "pulse-api refused the request (418). Nothing was changed.",
        reason: "other",
      },
    ],
    [
      "500",
      500,
      {
        kind: "text",
        status: 502,
        message: "pulse-api refused the request (500). Nothing was changed.",
        reason: "other",
      },
    ],
  ] as const)("%s maps to its row and logs no People row", async (_n, status, expected) => {
    const h = harness(() => json(status, JSON.stringify({ error: "bad name" })));
    expect(await run(h, revokeWrite)).toEqual(expected);
    expect(h.people).toEqual([]);
    expect(h.seen).toHaveLength(1);
  });

  test("a 409 api message is cut at 1000 characters; no message gives the fixed text", async () => {
    const cut = harness(() => json(409, JSON.stringify({ error: long })));
    const answer = await run(cut, revokeWrite);
    expect(answer).toEqual({ kind: "form", status: 409, message: "m".repeat(1000) });
    const none = harness(() => json(409, "x"));
    expect(await run(none, revokeWrite)).toEqual({
      kind: "form",
      status: 409,
      message: "pulse-api gave no reason.",
    });
  });
});

describe("unknown outcomes", () => {
  const cases: [string, () => Reply, number][] = [
    ["timeout", () => "held", 504],
    ["network error", () => "network", 504],
    ["wire mismatch", () => json(201, secretBody(), { "x-pulse-contract": "9" }), 502],
    ["missing wire header", () => json(201, secretBody(), {}), 502],
    ["redirect", () => new Response(null, { status: 302, headers: { location: "/x" } }), 502],
    ["500 without wire header", () => json(500, "{}", {}), 502],
  ];

  test.each(cases)("%s keeps the unknown text and logs (unknown)", async (_n, reply, status) => {
    const h = harness(reply);
    expect(await run(h, createWrite)).toEqual({
      kind: "text",
      status,
      message: UNKNOWN,
      reason: "other",
    });
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]?.redirect).toBe("manual");
    expect(h.people.map((e) => [e.action, e.target, e.value])).toEqual([
      ["token.create", { kind: "token", id: undefined }, "scopes=read,checks,admin (unknown)"],
    ]);
  });

  test.each([
    ["timeout", () => "held" as const, 504],
    ["wire mismatch", () => json(201, secretBody(), { "x-pulse-contract": "9" }), 502],
  ])("%s with a throwing People insert keeps the unknown text only", async (_n, reply, status) => {
    const h = harness(reply, { isPeopleBroken: true });
    const answer = await run(h, createWrite);
    expect(answer).toEqual({ kind: "text", status, message: UNKNOWN, reason: "other" });
    const shown = JSON.stringify(answer);
    expect(shown).not.toContain("Saved in pulse-api.");
    expect(shown).not.toContain("could not be written");
    expect(h.logs.filter((l) => l.includes('"level":"error"'))).toEqual([
      expect.stringContaining('"msg":"token change not logged","error":"RangeError"'),
    ]);
    expect(h.seen).toHaveLength(1);
    expect(h.timeouts).toEqual([5000]);
  });
});

describe("live guard", () => {
  test("a gone session gives 409 Not saved and no write", async () => {
    const h = harness(() => json(201, secretBody()), { isSessionGone: true });
    const answer = await run(h, createWrite);
    expect(answer.kind === "guard" && answer.page.kind === "page" && answer.page.status).toBe(409);
    expect(h.seen).toEqual([]);
    expect(h.people).toEqual([]);
  });

  test("a stored role demoted to member gives 403 and no write", async () => {
    const h = harness(() => json(201, secretBody()), { storedRole: "member" });
    const answer = await run(h, revokeWrite);
    expect(answer.kind === "guard" && answer.page.kind === "page" && answer.page.status).toBe(403);
    expect(h.seen).toEqual([]);
  });
});

test("no secret reaches a People row or a log line", async () => {
  const h = harness(() => json(201, secretBody()));
  await run(h, createWrite);
  expect(JSON.stringify(h.people)).not.toContain(FAKE_SECRET);
  expect(h.logs.join("\n")).not.toContain(FAKE_SECRET);
  expect(h.logs.join("\n")).not.toContain("console-admin-token-value");
});
