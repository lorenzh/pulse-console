import { describe, expect, test } from "bun:test";
import { createLogger } from "@lorenzh/pulse-kit";
import type { User } from "./account-store.ts";
import type { FetchLike } from "./api-read.ts";
import type { CheckWriteDeps } from "./check-write.ts";
import { type IncidentWrite, sendIncidentWrite } from "./incident-write.ts";
import type { PeopleEvent } from "./people-log.ts";

const API = "http://api.test";
const ADMIN_TOKEN = "incident-write-admin-token-sentinel";
const WIRE = { "x-pulse-contract": "1", "content-type": "application/json" };
const MEMBER: User = {
  id: 3,
  email: "m@example.com",
  name: "Mo",
  passwordHash: "h",
  role: "member",
};
const UNKNOWN =
  "The result is unknown. Open the incident list to see whether the change was published before you send it again.";

type Seen = { url: string; method: string; headers: Headers; body: string };
type Reply = Response | "held" | "network";

function harness(reply: () => Reply, isPeopleBroken = false) {
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
    });
    const next = reply();
    if (next === "held") {
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

const json = (status: number, body: unknown, headers: Record<string, string> = WIRE): Response =>
  Response.json(body, { status, headers });

const CREATE: IncidentWrite = {
  action: "manual-incident.create",
  body: {
    title: "Checkout slow",
    impact: "minor",
    componentIds: ["web"],
    status: "investigating",
    message: "\nLine one",
  },
};
const UPDATE: IncidentWrite = {
  action: "manual-incident.update",
  id: 7,
  body: { status: "identified", message: "Found it" },
};
const RESOLVE: IncidentWrite = { action: "manual-incident.resolve", id: 7, message: "Resolved." };
const DELETE: IncidentWrite = { action: "manual-incident.delete", id: 7 };

const STORED = {
  id: 12,
  title: "Checkout slow",
  impact: "minor",
  componentIds: ["web"],
  visibility: "public",
  status: "investigating",
  createdAt: 1000,
  resolvedAt: null,
  updates: [{ status: "investigating", message: "\nLine one", at: 1000 }],
};

describe("sendIncidentWrite requests", () => {
  test("each write sends one request with its method, path and body, bearer, no If-Match, 5000 ms", async () => {
    const rows: [IncidentWrite, string, string, string][] = [
      [
        CREATE,
        "POST",
        `${API}/manual-incidents`,
        '{"title":"Checkout slow","impact":"minor","componentIds":["web"],"status":"investigating","message":"\\nLine one"}',
      ],
      [
        UPDATE,
        "POST",
        `${API}/manual-incidents/7/updates`,
        '{"status":"identified","message":"Found it"}',
      ],
      [RESOLVE, "POST", `${API}/manual-incidents/7/resolve`, '{"message":"Resolved."}'],
      [DELETE, "DELETE", `${API}/manual-incidents/7`, ""],
    ];
    for (const [write, method, url, body] of rows) {
      const h = harness(() => new Response(null, { status: 204, headers: WIRE }));
      await sendIncidentWrite(h.deps, API, write, MEMBER);
      expect(h.seen).toHaveLength(1);
      expect(h.seen[0]?.method).toBe(method);
      expect(h.seen[0]?.url).toBe(url);
      expect(h.seen[0]?.body).toBe(body);
      expect(h.seen[0]?.headers.get("authorization")).toBe(`Bearer ${ADMIN_TOKEN}`);
      expect(h.seen[0]?.headers.get("if-match")).toBeNull();
      expect(h.timeouts).toEqual([5000]);
    }
  });
});

describe("sendIncidentWrite saved outcomes", () => {
  test("create redirects to the new incident and logs its id without text", async () => {
    const h = harness(() => json(201, STORED));
    expect(await sendIncidentWrite(h.deps, API, CREATE, MEMBER)).toEqual({
      kind: "redirect",
      location: "/incidents/manual?id=12&published=1",
    });
    expect(h.people).toEqual([
      {
        at: 1000,
        actor: { kind: "user", person: { id: 3, email: "m@example.com", name: "Mo" } },
        action: "manual-incident.create",
        target: { kind: "incident", id: 12 },
        value: undefined,
      },
    ]);
    expect(h.logs.join("\n")).not.toContain("Checkout slow");
    expect(h.logs.join("\n")).not.toContain(ADMIN_TOKEN);
  });

  test("create with an unreadable answer redirects to the list and logs the id unknown", async () => {
    const h = harness(() => json(201, { nope: true }));
    expect(await sendIncidentWrite(h.deps, API, CREATE, MEMBER)).toEqual({
      kind: "redirect",
      location: "/incidents?published=1",
    });
    expect(h.people[0]?.target).toEqual({ kind: "incident", id: undefined });
  });

  test("update, resolve and delete redirect to their pages", async () => {
    const rows: [IncidentWrite, string][] = [
      [UPDATE, "/incidents/manual?id=7&posted=1"],
      [RESOLVE, "/incidents/manual?id=7&resolved=1"],
      [DELETE, "/incidents?deleted=1"],
    ];
    for (const [write, location] of rows) {
      const h = harness(() => json(200, STORED));
      expect(await sendIncidentWrite(h.deps, API, write, MEMBER)).toEqual({
        kind: "redirect",
        location,
      });
      expect(h.people[0]?.target).toEqual({ kind: "incident", id: 7 });
    }
  });

  test("a failed People row gives the saved page with a link", async () => {
    const h = harness(() => json(201, STORED), true);
    expect(await sendIncidentWrite(h.deps, API, CREATE, MEMBER)).toEqual({
      kind: "not-logged",
      href: "/incidents/manual?id=12",
    });
    const d = harness(() => new Response(null, { status: 204, headers: WIRE }), true);
    expect(await sendIncidentWrite(d.deps, API, DELETE, MEMBER)).toEqual({
      kind: "not-logged",
      href: "/incidents",
    });
  });
});

describe("sendIncidentWrite refused and unknown outcomes", () => {
  test("every refused row of section 10", async () => {
    const long = "x".repeat(1200);
    const rows: [number, unknown][] = [
      [400, { kind: "form", status: 422, message: "title: Too long" }],
      [413, { kind: "form", status: 422, message: "title: Too long" }],
      [409, { kind: "form", status: 409, message: "title: Too long" }],
      [
        404,
        {
          kind: "text",
          status: 404,
          message: "This incident does not exist or is not public.",
          reason: "gone",
        },
      ],
      [401, { kind: "text", status: 502, message: "", reason: "token-rejected" }],
      [
        403,
        {
          kind: "text",
          status: 502,
          message:
            "The console token lacks the admin or incidents scope. Incident changes need both.",
          reason: "other",
        },
      ],
      [
        429,
        {
          kind: "form",
          status: 503,
          message: "pulse-api is throttling the console. Try again in a minute.",
        },
      ],
      [
        418,
        {
          kind: "text",
          status: 502,
          message: "pulse-api refused the request (418): title: Too long Nothing was changed.",
          reason: "other",
        },
      ],
      [
        500,
        {
          kind: "text",
          status: 502,
          message: "pulse-api could not save the change (500). Nothing was changed.",
          reason: "other",
        },
      ],
    ];
    for (const [status, expected] of rows) {
      const h = harness(() => json(status, { error: "title: Too long" }));
      expect(await sendIncidentWrite(h.deps, API, UPDATE, MEMBER)).toEqual(expected as never);
      expect(h.seen).toHaveLength(1);
      expect(h.people).toEqual([]);
    }
    const h = harness(() => json(409, { error: long }));
    const answer = await sendIncidentWrite(h.deps, API, RESOLVE, MEMBER);
    expect(answer.kind === "form" ? answer.message.length : 0).toBe(1000);
  });

  test("timeout, network, redirect and foreign answers are unknown, sent once", async () => {
    const rows: [Reply, number][] = [
      ["held", 504],
      ["network", 504],
      [new Response(null, { status: 302, headers: { location: "http://x.test" } }), 502],
      [json(200, STORED, { "content-type": "application/json" }), 502],
    ];
    for (const [reply, status] of rows) {
      const h = harness(() => reply);
      expect(await sendIncidentWrite(h.deps, API, CREATE, MEMBER)).toEqual({
        kind: "text",
        status,
        message: UNKNOWN,
        reason: "other",
      });
      expect(h.seen).toHaveLength(1);
    }
  });
});
