import { describe, expect, test } from "bun:test";
import { createLogger } from "@lorenzh/pulse-kit";
import type { User } from "./account-store.ts";
import type { FetchLike } from "./api-read.ts";
import {
  type ApiWrite,
  type CheckWriteDeps,
  isWithinApiBodyLimit,
  sendApiWrite,
  sendCheckWrite,
  type WriteTexts,
} from "./check-write.ts";
import type { PeopleEvent } from "./people-log.ts";

test("a built body of 1048576 bytes fits; 1048577 bytes do not", () => {
  expect(isWithinApiBodyLimit("x".repeat(1048576))).toBe(true);
  expect(isWithinApiBodyLimit("x".repeat(1048577))).toBe(false);
});

test("the limit counts UTF-8 bytes, not characters", () => {
  // 524288 'é' are 1048576 bytes; one more character is over.
  expect(isWithinApiBodyLimit("é".repeat(524288))).toBe(true);
  expect(isWithinApiBodyLimit(`${"é".repeat(524288)}x`)).toBe(false);
});

const API = "http://api.test";
const ADMIN_TOKEN = "check-write-admin-token-sentinel";
const WIRE = { "x-pulse-contract": "1", "content-type": "application/json" };
const REVISION = `sha256-${"b".repeat(64)}`;
const MEMBER: User = {
  id: 3,
  email: "m@example.com",
  name: "Mo",
  passwordHash: "h",
  role: "member",
};

type Seen = { url: string; method: string; headers: Headers; body: string; redirect: string };
type Reply = Response | "held" | "network";

function harness(
  reply: () => Reply,
  isPeopleBroken = false,
): {
  deps: CheckWriteDeps;
  seen: Seen[];
  people: PeopleEvent[];
  logs: string[];
  timeouts: number[];
} {
  const seen: Seen[] = [];
  const people: PeopleEvent[] = [];
  const logs: string[] = [];
  const timeouts: number[] = [];
  let fireTimeout: () => void = () => undefined;
  const fetchFn: FetchLike = async (input, init) => {
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
      redirect: init?.redirect ?? "",
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
  const deps: CheckWriteDeps = {
    store: {
      isGuardHeld: () => true,
      userById: () => MEMBER,
      appendPeople: (event) => {
        if (isPeopleBroken) throw new RangeError("disk full");
        people.push(event);
      },
    },
    fetch: fetchFn,
    adminToken: ADMIN_TOKEN,
    schedule: (fn, ms) => {
      timeouts.push(ms);
      fireTimeout = fn;
      return () => undefined;
    },
    now: () => 1000,
    log: createLogger({ level: "debug", write: (_level, line) => logs.push(line) }),
  };
  return { deps, seen, people, logs, timeouts };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { ...WIRE, ...headers } });

describe("sendCheckWrite keeps the check behavior", () => {
  const write = {
    action: "check.replace",
    checkId: "web",
    method: "PUT",
    url: `${API}/admin/checks/web`,
    revision: REVISION,
    body: "{}",
  } as const;

  test("saved: quoted If-Match, bearer token, 5000 ms, one request, revision People row", async () => {
    const h = harness(() => json(200, { ok: true }, { etag: `"${REVISION}"` }));
    const answer = await sendCheckWrite(h.deps, write, MEMBER);
    expect(answer).toEqual({ kind: "saved", isLogged: true, answer: { ok: true } });
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]?.headers.get("if-match")).toBe(`"${REVISION}"`);
    expect(h.seen[0]?.headers.get("authorization")).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(h.seen[0]?.redirect).toBe("manual");
    expect(h.timeouts).toEqual([5000]);
    expect(h.people).toEqual([
      {
        at: 1000,
        actor: { kind: "user", person: { id: 3, email: "m@example.com", name: "Mo" } },
        action: "check.replace",
        target: { kind: "check", id: "web" },
        value: REVISION,
      },
    ]);
    const line = h.logs.find((l) => l.includes('"check change"')) ?? "";
    expect(line).toContain('"checkId":"web"');
  });

  test("refused and unknown answers keep the check texts; a network error is not retried", async () => {
    const forbidden = harness(() => json(403, { error: "forbidden" }));
    expect(await sendCheckWrite(forbidden.deps, write, MEMBER)).toEqual({
      kind: "text",
      status: 502,
      message: "The console token lacks the admin or checks scope. Saving checks needs both.",
      reason: "other",
    });
    expect(forbidden.people).toEqual([]);
    const gone = harness(() => json(404, { error: "no check" }));
    expect(await sendCheckWrite(gone.deps, write, MEMBER)).toMatchObject({
      status: 404,
      message: "This check no longer exists.",
    });
    const lost = harness(() => "network");
    expect(await sendCheckWrite(lost.deps, write, MEMBER)).toEqual({
      kind: "text",
      status: 504,
      message: "The result is unknown. Open the check to see whether the change was saved.",
      reason: "other",
    });
    expect(lost.seen).toHaveLength(1);
    expect(lost.people.map((p) => p.value)).toEqual(["unknown"]);
    const moved = harness(() => new Response(null, { status: 302, headers: WIRE }));
    const answer = await sendCheckWrite(moved.deps, write, MEMBER);
    expect(answer).toMatchObject({ status: 502 });
    expect(answer.kind === "text" && answer.message).toBe(
      "pulse-api answered with a redirect (302); redirects are not followed. The result is unknown: open the check to see whether the change was saved. Check that PULSE_API_URL points at pulse-api itself.",
    );
  });
});

describe("sendApiWrite for other resources", () => {
  const INCIDENT_TEXTS: WriteTexts = {
    scope: "The console token lacks the admin or incidents scope. Incident changes need both.",
    gone: "This incident does not exist or is not public.",
    unknown:
      "The result is unknown. Open the incident list to see whether the change was published before you send it again.",
    unknownHint: "open the incident list to see whether the change was published.",
  };
  const create: ApiWrite = {
    action: "manual-incident.create",
    targetOf: (answer) => {
      const id =
        typeof answer === "object" && answer !== null && "id" in answer ? answer.id : undefined;
      return { kind: "incident", id: typeof id === "number" ? id : undefined };
    },
    logMessage: "incident change",
    logIds: { incidentId: "new" },
    method: "POST",
    url: `${API}/manual-incidents`,
    body: JSON.stringify({ title: "Secret title" }),
    savedValue: "none",
    texts: INCIDENT_TEXTS,
  };

  test("no If-Match without a revision; the answer body reaches the target and the caller", async () => {
    const h = harness(() => json(201, { id: 12 }));
    const answer = await sendApiWrite(h.deps, create, MEMBER);
    expect(answer).toEqual({ kind: "saved", isLogged: true, answer: { id: 12 } });
    expect(h.seen[0]?.headers.has("if-match")).toBe(false);
    expect(h.seen[0]?.method).toBe("POST");
    expect(h.people).toEqual([
      {
        at: 1000,
        actor: { kind: "user", person: { id: 3, email: "m@example.com", name: "Mo" } },
        action: "manual-incident.create",
        target: { kind: "incident", id: 12 },
        value: undefined,
      },
    ]);
    const line = h.logs.find((l) => l.includes('"incident change"')) ?? "";
    expect(line).toContain('"incidentId":"new"');
    for (const l of h.logs) {
      expect(l).not.toContain("Secret title");
      expect(l).not.toContain(ADMIN_TOKEN);
    }
  });

  test("an unknown outcome targets id unknown and uses the resource texts", async () => {
    const h = harness(() => "held");
    expect(await sendApiWrite(h.deps, create, MEMBER)).toEqual({
      kind: "text",
      status: 504,
      message: INCIDENT_TEXTS.unknown,
      reason: "other",
    });
    expect(h.people.map((p) => [p.target, p.value])).toEqual([
      [{ kind: "incident", id: undefined }, "unknown"],
    ]);
    const foreign = harness(() => new Response("{}", { status: 200 }));
    const answer = await sendApiWrite(foreign.deps, create, MEMBER);
    expect(answer.kind === "text" && answer.message).toBe(
      "The answer did not come from a matching pulse-api (200). The result is unknown: open the incident list to see whether the change was published.",
    );
  });

  test("403, 404 and 409 use the resource texts and add no People row", async () => {
    const forbidden = harness(() => json(403, { error: "forbidden" }));
    expect(await sendApiWrite(forbidden.deps, create, MEMBER)).toMatchObject({
      status: 502,
      message: INCIDENT_TEXTS.scope,
    });
    const gone = harness(() => json(404, { error: "no incident" }));
    expect(await sendApiWrite(gone.deps, create, MEMBER)).toMatchObject({
      status: 404,
      message: INCIDENT_TEXTS.gone,
    });
    const resolved = harness(() => json(409, { error: "incident is resolved" }));
    expect(await sendApiWrite(resolved.deps, create, MEMBER)).toEqual({
      kind: "form",
      status: 409,
      message: "incident is resolved",
    });
    expect([...forbidden.people, ...gone.people, ...resolved.people]).toEqual([]);
  });

  test("a maintenance write stores the new ETag revision; a failed row is reported", async () => {
    const replace: ApiWrite = {
      action: "maintenance.replace",
      targetOf: () => ({ kind: "maintenance", id: "db-upgrade" }),
      logMessage: "maintenance change",
      logIds: { windowId: "db-upgrade" },
      method: "PUT",
      url: `${API}/admin/maintenance/db-upgrade`,
      revision: REVISION,
      body: "{}",
      savedValue: "revision",
      texts: INCIDENT_TEXTS,
    };
    const next = `sha256-${"c".repeat(64)}`;
    const h = harness(() => json(200, {}, { etag: `"${next}"` }));
    expect(await sendApiWrite(h.deps, replace, MEMBER)).toMatchObject({ isLogged: true });
    expect(h.seen[0]?.headers.get("if-match")).toBe(`"${REVISION}"`);
    expect(h.people.map((p) => [p.target, p.value])).toEqual([
      [{ kind: "maintenance", id: "db-upgrade" }, next],
    ]);
    const broken = harness(() => json(200, {}, { etag: `"${next}"` }), true);
    expect(await sendApiWrite(broken.deps, replace, MEMBER)).toMatchObject({ isLogged: false });
    expect(broken.logs.some((l) => l.includes("maintenance change not logged"))).toBe(true);
  });
});
