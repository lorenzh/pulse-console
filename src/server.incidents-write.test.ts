import { afterEach, describe, expect, test } from "bun:test";
import { WIRE_HEADERS } from "../test/fake-api.ts";
import {
  type IncidentApi,
  incidentConfig,
  NOW,
  seedAutomatic,
  seedManual,
  startIncidentApi,
} from "../test/incident-api.ts";
import { formTokenOf, getPage, type Reply, replyOf } from "../test/signed-in-console.ts";
import { startTeamConsole, type TeamConsole } from "../test/team-console.ts";
import type { ConsoleRole } from "./roles.ts";

const TOKEN = "incidents-write-admin-token-sentinel-0123456789";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function api(): IncidentApi {
  const a = startIncidentApi({
    token: TOKEN,
    config: incidentConfig,
    manual: seedManual(),
    automatic: seedAutomatic,
    now: () => NOW,
  });
  cleanups.push(() => a.stop());
  return a;
}

async function team(a: IncidentApi): Promise<TeamConsole> {
  const c = await startTeamConsole({ apiUrl: a.url, adminToken: TOKEN });
  cleanups.push(() => c.close());
  // The fixtures use a 2026 clock; the seeded sessions must not look idle at that time.
  c.db.query("UPDATE sessions SET created_at = ?, last_seen_at = ?").run(NOW, NOW);
  c.setNow(NOW);
  return c;
}

type Entries = ReadonlyArray<readonly [string, string]>;

function post(c: TeamConsole, path: string, entries: Entries, role: ConsoleRole): Promise<Reply> {
  return fetch(c.base + path, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: c.cookies[role],
      origin: c.base,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(entries.map(([k, v]): [string, string] => [k, v])).toString(),
  }).then(replyOf);
}

/** Opens `page`, takes the form token of `action` and posts `entries` (api counters reset). */
async function submit(
  c: TeamConsole,
  a: IncidentApi,
  view: { page: string; action: string; entries: Entries; role?: ConsoleRole | undefined },
): Promise<Reply> {
  const role = view.role ?? "member";
  const opened = await getPage(c, view.page, c.cookies[role]);
  expect(opened.status).toBe(200);
  const token = formTokenOf(opened.body, view.action);
  a.seen.length = 0;
  return post(
    c,
    view.action,
    [["csrf", c.csrfs[role]], ["form_token", token], ...view.entries],
    role,
  );
}

function composer(entries: Entries, role?: ConsoleRole) {
  return { page: "/incidents/new", action: "/incidents/new", entries, role };
}

const PUBLISH: Entries = [
  ["title", "Checkout slow again"],
  ["impact", "major"],
  ["status", "identified"],
  ["component", "web"],
  ["component", "public-api"],
  ["message", "\r\nLine one\r\nLine two"],
  ["action", "publish"],
];

type PeopleRow = { action: string; target_kind: string; target_name: string; value: string | null };

function peopleRows(c: TeamConsole): PeopleRow[] {
  return c.db
    .query<PeopleRow, []>(
      "SELECT action, target_kind, target_name, value FROM people_events WHERE action LIKE 'manual-incident.%' ORDER BY id",
    )
    .all();
}

function writeBodies(a: IncidentApi): unknown[] {
  return a.seen.filter((s) => s.method !== "GET").map((s) => s.body);
}

describe("POST /incidents/new", () => {
  test("publish sends one write with the typed text and redirects to the new incident", async () => {
    const a = api();
    const c = await team(a);
    const res = await submit(c, a, composer(PUBLISH));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/incidents/manual?id=4&published=1");
    expect([a.reads(), a.writes()]).toEqual([1, 1]);
    expect(writeBodies(a)).toEqual([
      {
        title: "Checkout slow again",
        impact: "major",
        componentIds: ["web", "public-api"],
        status: "identified",
        message: "\nLine one\nLine two",
      },
    ]);
    expect(a.seen.find((s) => s.method === "POST")?.path).toBe("/manual-incidents");
    expect(peopleRows(c)).toEqual([
      { action: "manual-incident.create", target_kind: "incident", target_name: "4", value: null },
    ]);
    expect(c.logs.join("\n")).not.toContain(TOKEN);
    expect(c.logs.join("\n")).not.toContain("Checkout slow again");
  });

  test("preview renders the posted input with zero writes and no People row", async () => {
    const a = api();
    const c = await team(a);
    const entries: Entries = [
      ["title", "<b>Checkout</b> slow"],
      ["impact", "major"],
      ["status", "investigating"],
      ["component", "web"],
      ["component", "public-api"],
      ["message", "Line 1\nLine <2>"],
      ["action", "preview"],
    ];
    const res = await submit(c, a, composer(entries));
    expect(res.status).toBe(200);
    expect(res.body).toContain('<h3 data-part="title">&lt;b&gt;Checkout&lt;/b&gt; slow</h3>');
    expect(res.body).toContain('<p data-part="affects">Affects: Web, Public API</p>');
    expect(res.body).toContain('<span data-part="impact">Impact: major</span>');
    expect(res.body).not.toContain("<b>Checkout");
    expect(res.body).toContain('name="title" type="text"');
    expect([a.reads(), a.writes()]).toEqual([1, 0]);
    expect(peopleRows(c)).toEqual([]);
  });

  test("an untitled title is refused with 422, one read and zero writes", async () => {
    const a = api();
    const c = await team(a);
    const entries: Entries = [
      ["title", "   "],
      ["impact", "minor"],
      ["status", "investigating"],
      ["message", "Kept message"],
      ["action", "publish"],
    ];
    const res = await submit(c, a, composer(entries));
    expect(res.status).toBe(422);
    expect(res.body).toContain(
      "The title needs at least one letter, digit, punctuation mark or symbol.",
    );
    expect(res.body).toContain("Kept message</textarea>");
    expect([a.reads(), a.writes()]).toEqual([1, 0]);
  });

  test("a component that is not configured is refused", async () => {
    const a = api();
    const c = await team(a);
    const entries: Entries = [...PUBLISH.filter(([k]) => k !== "component"), ["component", "old"]];
    const res = await submit(c, a, composer(entries));
    expect(res.status).toBe(422);
    expect(res.body).toContain("Component old is not configured any more.");
    expect(a.writes()).toBe(0);
  });

  test("a 201-emoji title is refused by the contract and a 200-emoji title is accepted", async () => {
    const a = api();
    const c = await team(a);
    const long = PUBLISH.map(([k, v]) => [k, k === "title" ? "😀".repeat(201) : v] as const);
    const refused = await submit(c, a, composer(long));
    expect(refused.status).toBe(422);
    expect(a.writes()).toBe(0);
    const fits = PUBLISH.map(([k, v]) => [k, k === "title" ? "😀".repeat(200) : v] as const);
    const accepted = await submit(c, a, composer(fits));
    expect(accepted.status).toBe(303);
    expect(a.writes()).toBe(1);
  });

  test("a replayed form token answers 409 with zero api requests", async () => {
    const a = api();
    const c = await team(a);
    const opened = await getPage(c, "/incidents/new", c.cookies.member);
    const token = formTokenOf(opened.body, "/incidents/new");
    const entries: Entries = [["csrf", c.csrfs.member], ["form_token", token], ...PUBLISH];
    expect((await post(c, "/incidents/new", entries, "member")).status).toBe(303);
    const before = a.seen.length;
    const replay = await post(c, "/incidents/new", entries, "member");
    expect(replay.status).toBe(409);
    expect(replay.body).toContain("Already submitted");
    expect(a.seen).toHaveLength(before);
    expect(a.writes()).toBe(1);
  });

  test("a role lowered after the token was accepted gives 403 with zero writes", async () => {
    const a = api();
    const c = await team(a);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const opened = await getPage(c, "/incidents/new", c.cookies.member);
    const token = formTokenOf(opened.body, "/incidents/new");
    a.override("GET", "/admin/config", () => {
      c.db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(c.ids.member);
      release();
      return new Response(JSON.stringify(incidentConfig), {
        status: 200,
        headers: WIRE_HEADERS,
      });
    });
    a.seen.length = 0;
    const res = await post(
      c,
      "/incidents/new",
      [["csrf", c.csrfs.member], ["form_token", token], ...PUBLISH],
      "member",
    );
    await gate;
    expect(res.status).toBe(403);
    expect([a.reads(), a.writes()]).toEqual([1, 0]);
  });

  for (const [status, expected, text] of [
    [401, 502, "pulse-api rejected the console token"],
    [403, 502, "The console token lacks the admin or incidents scope. Incident changes need both."],
    [429, 503, "pulse-api is throttling the console. Try again in a minute."],
    [500, 502, "pulse-api could not save the change (500). Nothing was changed."],
  ] as const) {
    test(`an api ${status} answers ${expected}`, async () => {
      const a = api();
      const c = await team(a);
      a.override(
        "POST",
        "/manual-incidents",
        () => new Response('{"error":"refused"}', { status, headers: WIRE_HEADERS }),
      );
      const res = await submit(c, a, composer(PUBLISH));
      expect(res.status).toBe(expected);
      expect(res.body).toContain(text);
      expect(a.writes()).toBe(1);
      expect(peopleRows(c)).toEqual([]);
    });
  }

  for (const [status, expected, text] of [
    [400, 422, "title is bad sentinel"],
    [413, 422, "title is bad sentinel"],
    [409, 409, "title is bad sentinel"],
    [404, 404, "This incident does not exist or is not public."],
  ] as const) {
    test(`an api ${status} answers ${expected} end to end`, async () => {
      const a = api();
      const c = await team(a);
      a.override(
        "POST",
        "/manual-incidents",
        () => new Response('{"error":"title is bad sentinel"}', { status, headers: WIRE_HEADERS }),
      );
      const res = await submit(c, a, composer(PUBLISH));
      expect(res.status).toBe(expected);
      expect(res.body).toContain(text);
      expect(res.body).not.toContain(TOKEN);
      expect(a.writes()).toBe(1);
      expect(peopleRows(c)).toEqual([]);
    });
  }

  test("a zero-width-space title is refused as untitled with zero writes", async () => {
    const a = api();
    const c = await team(a);
    const entries = PUBLISH.map(([k, v]) => [k, k === "title" ? "​" : v] as const);
    const res = await submit(c, a, composer(entries));
    expect(res.status).toBe(422);
    expect(res.body).toContain(
      "The title needs at least one letter, digit, punctuation mark or symbol.",
    );
    expect(a.writes()).toBe(0);
  });

  test("a mixed-emoji title of 200 code points is accepted", async () => {
    const a = api();
    const c = await team(a);
    const title = "a😀".repeat(100);
    const entries = PUBLISH.map(([k, v]) => [k, k === "title" ? title : v] as const);
    const res = await submit(c, a, composer(entries));
    expect(res.status).toBe(303);
    const [body] = writeBodies(a);
    expect(body).toMatchObject({ title });
  });

  test("a session removed after the token was accepted gives 409 Not saved with zero writes", async () => {
    const a = api();
    const c = await team(a);
    const opened = await getPage(c, "/incidents/new", c.cookies.member);
    const token = formTokenOf(opened.body, "/incidents/new");
    a.override("GET", "/admin/config", () => {
      c.db.query("DELETE FROM sessions WHERE user_id = ?").run(c.ids.member);
      return new Response(JSON.stringify(incidentConfig), { status: 200, headers: WIRE_HEADERS });
    });
    a.seen.length = 0;
    const res = await post(
      c,
      "/incidents/new",
      [["csrf", c.csrfs.member], ["form_token", token], ...PUBLISH],
      "member",
    );
    expect(res.status).toBe(409);
    expect(res.body).toContain("Not saved");
    expect(a.seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /admin/config"]);
    expect(peopleRows(c)).toEqual([]);
  });

  test("no answer within 5000 ms: 504, one unknown row, one read and one write", async () => {
    const a = api();
    const pending = new Set<() => void>();
    const c = await startTeamConsole({
      apiUrl: a.url,
      adminToken: TOKEN,
      schedule: (fn) => {
        pending.add(fn);
        return () => pending.delete(fn);
      },
    });
    cleanups.push(() => c.close());
    c.db.query("UPDATE sessions SET created_at = ?, last_seen_at = ?").run(NOW, NOW);
    c.setNow(NOW);
    let release = (): void => undefined;
    a.holdWrites(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    cleanups.push(() => release());
    const opened = await getPage(c, "/incidents/new", c.cookies.member);
    const token = formTokenOf(opened.body, "/incidents/new");
    pending.clear();
    a.seen.length = 0;
    const res = post(
      c,
      "/incidents/new",
      [["csrf", c.csrfs.member], ["form_token", token], ...PUBLISH],
      "member",
    );
    while (a.writes() !== 1 || pending.size === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (const fn of [...pending]) fn();
    const answer = await res;
    expect(answer.status).toBe(504);
    expect(answer.body).toContain(
      "The result is unknown. Open the incident list to see whether the change was published before you send it again.",
    );
    expect(a.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "GET /admin/config",
      "POST /manual-incidents",
    ]);
    expect(peopleRows(c).map((r) => r.value)).toEqual(["unknown"]);
  });

  test("the admin token never reaches responses, logs or the database; text never reaches logs", async () => {
    const a = api();
    const c = await team(a);
    const res = await submit(c, a, composer(PUBLISH));
    expect(res.status).toBe(303);
    const detail = await getPage(c, res.headers.get("location") ?? "/", c.cookies.member);
    expect(detail.body).not.toContain(TOKEN);
    expect(res.body).not.toContain(TOKEN);
    const logs = c.logs.join("\n");
    expect(logs).not.toContain(TOKEN);
    expect(logs).not.toContain("Checkout slow again");
    expect(logs).not.toContain("Line one");
    const dump = c.db
      .query<{ sql: string }, []>("SELECT name AS sql FROM sqlite_master WHERE type = 'table'")
      .all()
      .flatMap(({ sql }) => c.db.query(`SELECT * FROM "${sql}"`).all())
      .map((row) => JSON.stringify(row))
      .join("\n");
    expect(dump).not.toContain(TOKEN);
    expect(JSON.stringify(peopleRows(c))).not.toContain("Checkout slow again");
  });

  test("a foreign answer shows the unknown text with the input and logs one row", async () => {
    const a = api();
    const c = await team(a);
    a.override("POST", "/manual-incidents", () => new Response("<html>", { status: 200 }));
    const res = await submit(c, a, composer(PUBLISH));
    expect(res.status).toBe(502);
    expect(res.body).toContain(
      "The result is unknown. Open the incident list to see whether the change was published before you send it again.",
    );
    expect(res.body).toContain("Checkout slow again");
    expect(a.writes()).toBe(1);
    expect(peopleRows(c).map((r) => r.value)).toEqual(["unknown"]);
  });
});

function updateEntries(status: string, action = "publish"): Entries {
  return [
    ["incident", "1"],
    ["status", status],
    ["message", "\nSecond update"],
    ["action", action],
  ];
}

function update(entries: Entries) {
  return { page: "/incidents/manual?id=1", action: "/incidents/update", entries };
}

describe("POST /incidents/update", () => {
  test("posts the update with two reads and one write", async () => {
    const a = api();
    const c = await team(a);
    const res = await submit(c, a, update(updateEntries("identified")));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/incidents/manual?id=1&posted=1");
    expect([a.reads(), a.writes()]).toEqual([2, 1]);
    expect(writeBodies(a)).toEqual([{ status: "identified", message: "\nSecond update" }]);
    expect(peopleRows(c).map((r) => r.action)).toEqual(["manual-incident.update"]);
  });

  test("a forged resolved status answers 422 with two reads and zero writes", async () => {
    const a = api();
    const c = await team(a);
    const res = await submit(c, a, update(updateEntries("resolved")));
    expect(res.status).toBe(422);
    expect(res.body).toContain("Use Resolve to resolve an incident.");
    expect([a.reads(), a.writes()]).toEqual([2, 0]);
  });

  test("preview keeps the message with zero writes", async () => {
    const a = api();
    const c = await team(a);
    const res = await submit(c, a, update(updateEntries("monitoring", "preview")));
    expect(res.status).toBe(200);
    expect(res.body).toContain('rows="4">\n\nSecond update</textarea>');
    expect(res.body).toContain('<span data-part="status">Status: monitoring</span>');
    expect(a.writes()).toBe(0);
  });
});

function resolveEntries(action = "publish"): Entries {
  return [
    ["incident", "1"],
    ["message", "All good."],
    ["action", action],
  ];
}

function resolve(entries: Entries) {
  return { page: "/incidents/resolve?id=1", action: "/incidents/resolve?id=1", entries };
}

describe("/incidents/resolve", () => {
  test("GET shows the message prefilled and the resolved preview", async () => {
    const c = await team(api());
    const page = await getPage(c, "/incidents/resolve?id=1", c.cookies.member);
    expect(page.status).toBe(200);
    expect(page.body).toContain('rows="4">\nResolved.</textarea>');
    expect(page.body).toContain('data-preview="resolved"');
    expect(page.body).toContain("A resolved incident cannot be reopened.");
  });

  test("GET of a resolved incident answers 409 without a resolve form", async () => {
    const c = await team(api());
    const page = await getPage(c, "/incidents/resolve?id=2", c.cookies.member);
    expect(page.status).toBe(409);
    expect(page.body).toContain("This incident is already resolved.");
    const main = page.body.slice(
      page.body.indexOf('<main id="main"'),
      page.body.indexOf("</main>"),
    );
    expect(main.split("<form").length - 1).toBe(0);
    expect(main.split('name="form_token"').length - 1).toBe(0);
    expect(page.body.split('action="/incidents/resolve').length - 1).toBe(0);
    expect(page.body.split('name="form_token"').length - 1).toBe(1);
    expect(page.body.split('action="/sign-out"').length - 1).toBe(1);
  });

  test("resolve sends one write after two reads and redirects", async () => {
    const a = api();
    const c = await team(a);
    const res = await submit(c, a, resolve(resolveEntries()));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/incidents/manual?id=1&resolved=1");
    expect([a.reads(), a.writes()]).toEqual([2, 1]);
    expect(a.seen.find((s) => s.method === "POST")?.path).toBe("/manual-incidents/1/resolve");
    expect(writeBodies(a)).toEqual([{ message: "All good." }]);
  });

  test("a second open resolve form answers 409 with zero writes", async () => {
    const a = api();
    const c = await team(a);
    const first = await getPage(c, "/incidents/resolve?id=1", c.cookies.member);
    const second = await getPage(c, "/incidents/resolve?id=1", c.cookies.member);
    const tokenOf = (r: Reply) => formTokenOf(r.body, "/incidents/resolve?id=1");
    const base: Entries = resolveEntries();
    const send = (r: Reply) =>
      post(
        c,
        "/incidents/resolve?id=1",
        [["csrf", c.csrfs.member], ["form_token", tokenOf(r)], ...base],
        "member",
      );
    expect((await send(first)).status).toBe(303);
    a.seen.length = 0;
    const again = await send(second);
    expect(again.status).toBe(409);
    expect(again.body).toContain("This incident is already resolved.");
    expect(again.body).toContain("All good.");
    expect([a.reads(), a.writes()]).toEqual([2, 0]);
  });

  test("a resolve between the read and the write shows the api 409 after one write", async () => {
    const a = api();
    const c = await team(a);
    const opened = await getPage(c, "/incidents/resolve?id=1", c.cookies.member);
    const token = formTokenOf(opened.body, "/incidents/resolve?id=1");
    a.resolveAfterNextRead(1);
    a.seen.length = 0;
    const res = await post(
      c,
      "/incidents/resolve?id=1",
      [["csrf", c.csrfs.member], ["form_token", token], ...resolveEntries()],
      "member",
    );
    expect(res.status).toBe(409);
    expect(res.body).toContain("incident is resolved");
    expect(a.writes()).toBe(1);
  });
});

function deletion(id: number, typed: string) {
  return {
    page: `/incidents/delete?id=${id}`,
    action: `/incidents/delete?id=${id}`,
    entries: [
      ["revision", "1"],
      ["incident", String(id)],
      ["confirm_name", typed],
    ] as Entries,
    role: "admin" as const,
  };
}

describe("/incidents/delete", () => {
  test("a matching typed title deletes with one read and one write", async () => {
    const a = api();
    const c = await team(a);
    const res = await submit(c, a, deletion(1, " Checkout slow "));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/incidents?deleted=1");
    expect([a.reads(), a.writes()]).toEqual([1, 1]);
    expect(a.seen.at(-1)).toMatchObject({ method: "DELETE", path: "/manual-incidents/1" });
    expect(peopleRows(c)).toEqual([
      { action: "manual-incident.delete", target_kind: "incident", target_name: "1", value: null },
    ]);
  });

  for (const [typed, text] of [
    ["", "Type the name to confirm."],
    ["checkout slow", "The name does not match. Type Checkout slow exactly."],
    ["Incident 1", "The name does not match. Type Checkout slow exactly."],
  ] as const) {
    test(`typed ${JSON.stringify(typed)} is refused with one read and zero writes`, async () => {
      const a = api();
      const c = await team(a);
      const res = await submit(c, a, deletion(1, typed));
      expect(res.status).toBe(422);
      expect(res.body).toContain(text);
      expect([a.reads(), a.writes()]).toEqual([1, 0]);
    });
  }

  test("an untitled incident is deleted by typing Incident <id>", async () => {
    const a = api();
    const c = await team(a);
    const page = await getPage(c, "/incidents/delete?id=2", c.cookies.admin);
    expect(page.body).toContain("Type Incident 2 to confirm");
    expect(page.body).toContain("Delete Untitled incident #2");
    const res = await submit(c, a, deletion(2, "Incident 2"));
    expect(res.status).toBe(303);
    expect(a.writes()).toBe(1);
  });

  test("an unknown incident answers 404 with zero writes", async () => {
    const a = api();
    const c = await team(a);
    const opened = await getPage(c, "/incidents/delete?id=1", c.cookies.admin);
    const token = formTokenOf(opened.body, "/incidents/delete?id=1");
    a.manual.splice(0, 1);
    a.seen.length = 0;
    const res = await post(
      c,
      "/incidents/delete?id=1",
      [["csrf", c.csrfs.admin], ["form_token", token], ...deletion(1, "Checkout slow").entries],
      "admin",
    );
    expect(res.status).toBe(404);
    expect(res.body).toContain("This incident does not exist or is not public.");
    expect([a.reads(), a.writes()]).toEqual([1, 0]);
  });
});

type CountRow = {
  name: string;
  method: "GET" | "POST";
  path: string;
  role?: ConsoleRole;
  entries?: Entries;
  calls: string[];
};

const COUNT_ROWS: CountRow[] = [
  {
    name: "GET /incidents/manual",
    method: "GET",
    path: "/incidents/manual?id=1",
    calls: ["GET /manual-incidents/1", "GET /admin/config"],
  },
  {
    name: "GET /incidents/automatic",
    method: "GET",
    path: "/incidents/automatic?id=7",
    calls: ["GET /incidents", "GET /admin/config", "GET /checks/web/results"],
  },
  {
    name: "GET /incidents/new",
    method: "GET",
    path: "/incidents/new",
    calls: ["GET /admin/config"],
  },
  {
    name: "GET /incidents/new with from",
    method: "GET",
    path: "/incidents/new?from=7",
    calls: ["GET /incidents", "GET /admin/config"],
  },
  {
    name: "POST /incidents/new preview",
    method: "POST",
    path: "/incidents/new",
    entries: PUBLISH.map(([k, v]) => [k, k === "action" ? "preview" : v] as const),
    calls: ["GET /admin/config"],
  },
  {
    name: "POST /incidents/new publish",
    method: "POST",
    path: "/incidents/new",
    entries: PUBLISH,
    calls: ["GET /admin/config", "POST /manual-incidents"],
  },
  {
    name: "GET /incidents/resolve",
    method: "GET",
    path: "/incidents/resolve?id=1",
    calls: ["GET /manual-incidents/1", "GET /admin/config"],
  },
  {
    name: "GET /incidents/delete",
    method: "GET",
    path: "/incidents/delete?id=1",
    role: "admin",
    calls: ["GET /manual-incidents/1"],
  },
  {
    name: "POST /incidents/update preview",
    method: "POST",
    path: "/incidents/manual?id=1",
    entries: [
      ["incident", "1"],
      ["status", "monitoring"],
      ["message", "x"],
      ["action", "preview"],
    ],
    calls: ["GET /manual-incidents/1", "GET /admin/config"],
  },
  {
    name: "POST /incidents/resolve preview",
    method: "POST",
    path: "/incidents/resolve?id=1",
    entries: [
      ["incident", "1"],
      ["message", "x"],
      ["action", "preview"],
    ],
    calls: ["GET /manual-incidents/1", "GET /admin/config"],
  },
  {
    name: "POST /incidents/resolve publish",
    method: "POST",
    path: "/incidents/resolve?id=1",
    entries: [
      ["incident", "1"],
      ["message", "x"],
      ["action", "publish"],
    ],
    calls: ["GET /manual-incidents/1", "GET /admin/config", "POST /manual-incidents/1/resolve"],
  },
  {
    name: "POST /incidents/delete",
    method: "POST",
    path: "/incidents/delete?id=1",
    role: "admin",
    entries: deletion(1, "Checkout slow").entries,
    calls: ["GET /manual-incidents/1", "DELETE /manual-incidents/1"],
  },
];

describe("request counting", () => {
  for (const row of COUNT_ROWS) {
    test(`${row.name} sends exactly its reads and writes in order`, async () => {
      const a = api();
      const c = await team(a);
      const role = row.role ?? "member";
      if (row.method === "GET") {
        a.seen.length = 0;
        expect((await getPage(c, row.path, c.cookies[role])).status).toBe(200);
      } else {
        const isUpdate = row.path.startsWith("/incidents/manual");
        const action = isUpdate ? "/incidents/update" : row.path;
        const res = await submit(c, a, {
          page: row.path,
          action,
          entries: row.entries ?? [],
          role,
        });
        expect([200, 303]).toContain(res.status);
      }
      expect(a.seen.map((s) => `${s.method} ${s.path}`)).toEqual(row.calls);
    });
  }
});

describe("incident review follow-ups", () => {
  test("a component removed after the composer GET stays checked in the 422 form", async () => {
    const config = { ...incidentConfig, components: [...incidentConfig.components] };
    const a = startIncidentApi({ token: TOKEN, config, manual: seedManual(), now: () => NOW });
    cleanups.push(() => a.stop());
    const c = await team(a);
    const opened = await getPage(c, "/incidents/new", c.cookies.member);
    const token = formTokenOf(opened.body, "/incidents/new");
    config.components = [{ id: "web", name: "Web", checkIds: ["web"] }];
    a.seen.length = 0;
    const res = await post(
      c,
      "/incidents/new",
      [["csrf", c.csrfs.member], ["form_token", token], ...PUBLISH],
      "member",
    );
    expect(res.status).toBe(422);
    expect(res.body).toContain("Component public-api is not configured any more.");
    expect(res.body).toMatch(/name="component" value="public-api"[^>]*checked/);
    expect(res.body).toMatch(/name="component" value="web"[^>]*checked/);
    expect([a.reads(), a.writes()]).toEqual([1, 0]);
  });

  const accepted = [`${"😀".repeat(1000)}x`, `${"a".repeat(1999)}😀`, "😀".repeat(2000)];
  for (const message of accepted) {
    test(`message of ${[...message].length} code points is sent`, async () => {
      const a = api();
      const c = await team(a);
      const entries = PUBLISH.map(([k, v]) => [k, k === "message" ? message : v] as const);
      const res = await submit(c, a, composer(entries));
      expect(res.status).toBe(303);
      expect([a.reads(), a.writes()]).toEqual([1, 1]);
      expect(writeBodies(a)[0]).toMatchObject({ message });
    });
  }
  const refused = ["x".repeat(2001), `${"a".repeat(2000)}😀`, "😀".repeat(2001)];
  for (const message of refused) {
    test(`message of ${[...message].length} code points is refused with 422`, async () => {
      const a = api();
      const c = await team(a);
      const entries = PUBLISH.map(([k, v]) => [k, k === "message" ? message : v] as const);
      const res = await submit(c, a, composer(entries));
      expect(res.status).toBe(422);
      expect(res.body).toContain("must be 1..2000 characters");
      expect(res.body).toContain(`${message.slice(0, 40)}`);
      expect([a.reads(), a.writes()]).toEqual([1, 0]);
    });
  }

  function seedTitle(a: IncidentApi, title: string): void {
    a.manual.push({
      id: 12,
      title,
      componentIds: [],
      impact: "minor",
      status: "investigating",
      createdAt: NOW - 3_600_000,
      resolvedAt: null,
      updates: [{ at: NOW - 3_600_000, status: "investigating", message: "Seeded." }],
    });
  }

  for (const title of ["   ", "​"]) {
    describe(`untitled #12 with title ${JSON.stringify(title)}`, () => {
      test("pages name it Untitled incident #12", async () => {
        const a = api();
        seedTitle(a, title);
        const c = await team(a);
        for (const path of ["/incidents", "/incidents/manual?id=12", "/incidents/resolve?id=12"]) {
          expect((await getPage(c, path, c.cookies.admin)).body).toContain("Untitled incident #12");
        }
        const del = await getPage(c, "/incidents/delete?id=12", c.cookies.admin);
        expect(del.body).toContain("Untitled incident #12");
        expect(del.body).toContain("Type Incident 12 to confirm");
      });
      for (const typed of ["Incident 12", " Incident 12 "]) {
        test(`typed ${JSON.stringify(typed)} deletes with one read and one write`, async () => {
          const a = api();
          seedTitle(a, title);
          const c = await team(a);
          const res = await submit(c, a, deletion(12, typed));
          expect(res.status).toBe(303);
          expect([a.reads(), a.writes()]).toEqual([1, 1]);
        });
      }
      for (const [typed, text] of [
        ["", "Type the name to confirm."],
        ["incident 12", "The name does not match. Type Incident 12 exactly."],
      ] as const) {
        test(`typed ${JSON.stringify(typed)} is refused`, async () => {
          const a = api();
          seedTitle(a, title);
          const c = await team(a);
          const res = await submit(c, a, deletion(12, typed));
          expect(res.status).toBe(422);
          expect(res.body).toContain(text);
          expect([a.reads(), a.writes()]).toEqual([1, 0]);
        });
      }
    });
  }

  for (const [title, typed, isDeleted] of [
    ["Slow checkout", "Incident 12", false],
    ["Slow checkout", "slow checkout", false],
    ["Slow checkout", "Slow  checkout", false],
    ["Slow checkout", "Slow checkout ", true],
    ["Café", "Café", true],
  ] as const) {
    test(`title ${JSON.stringify(title)} typed ${JSON.stringify(typed)}`, async () => {
      const a = api();
      seedTitle(a, title);
      const c = await team(a);
      const res = await submit(c, a, deletion(12, typed));
      if (isDeleted) {
        expect(res.status).toBe(303);
        expect([a.reads(), a.writes()]).toEqual([1, 1]);
      } else {
        expect(res.status).toBe(422);
        expect(res.body).toContain("The name does not match. Type Slow checkout exactly.");
        expect([a.reads(), a.writes()]).toEqual([1, 0]);
        expect(a.seen.map((s) => s.path)).toEqual(["/manual-incidents/12"]);
      }
    });
  }

  test("a wrong csrf value stops in the dispatcher with zero api requests", async () => {
    const a = api();
    const c = await team(a);
    const opened = await getPage(c, "/incidents/new", c.cookies.member);
    const token = formTokenOf(opened.body, "/incidents/new");
    a.seen.length = 0;
    const res = await post(
      c,
      "/incidents/new",
      [["csrf", "wrong"], ["form_token", token], ...PUBLISH],
      "member",
    );
    expect(res.status).toBe(403);
    expect(a.seen).toHaveLength(0);
  });

  test("a Member's forged delete answers 403 with zero api requests", async () => {
    const a = api();
    const c = await team(a);
    a.seen.length = 0;
    const res = await post(
      c,
      "/incidents/delete?id=1",
      [["csrf", c.csrfs.member], ["form_token", "x"], ...deletion(1, "Checkout slow").entries],
      "member",
    );
    expect(res.status).toBe(403);
    expect(a.seen).toHaveLength(0);
    expect(a.manual.some((m) => m.id === 1)).toBe(true);
  });

  for (const path of ["/incidents/new", "/incidents/update", "/incidents/resolve?id=1"]) {
    for (const [size, isTooLarge] of [
      [32768, false],
      [32769, true],
    ] as const) {
      test(`${path} with a ${size}-byte body ${isTooLarge ? "answers" : "is not"} 413`, async () => {
        const a = api();
        const c = await team(a);
        const head = `csrf=${c.csrfs.member}&form_token=x&incident=1&message=`;
        const body = head + "a".repeat(size - head.length);
        expect(Buffer.byteLength(body)).toBe(size);
        const res = await fetch(c.base + path, {
          method: "POST",
          redirect: "manual",
          headers: {
            cookie: c.cookies.member,
            origin: c.base,
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
        });
        await res.text();
        if (isTooLarge) expect(res.status).toBe(413);
        else expect(res.status).not.toBe(413);
        expect(a.writes()).toBe(0);
      });
    }
  }
});
