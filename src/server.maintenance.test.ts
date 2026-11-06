import { afterEach, describe, expect, test } from "bun:test";
import { WIRE_HEADERS } from "../test/fake-api.ts";
import {
  type IncidentApi,
  incidentConfig,
  NOW,
  type SeedWindow,
  startIncidentApi,
} from "../test/incident-api.ts";
import { formTokenOf, getPage, type Reply, replyOf } from "../test/signed-in-console.ts";
import { startTeamConsole, type TeamConsole } from "../test/team-console.ts";
import type { ConsoleRole } from "./roles.ts";

const TOKEN = "maintenance-admin-token-sentinel-0123456789";
const NOTE = "Database upgrade sentinel note";
const REVISION0 = `sha256-${"b".repeat(64)}`;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function seed(): { windows: SeedWindow[]; shadowed: SeedWindow[] } {
  return {
    windows: [
      {
        id: "db-upgrade",
        index: null,
        source: "database",
        checkIds: ["web", "gone-check"],
        start: 1793959200123,
        end: 1793966400456,
        note: NOTE,
      },
      {
        id: "planned-one",
        index: null,
        source: "database",
        checkIds: ["cert"],
        start: 1794000000000,
        end: 1794003600000,
        note: "Later",
      },
      {
        id: "file-window",
        index: 0,
        source: "file",
        checkIds: ["web"],
        start: 1793000000000,
        end: 1793003600000,
        note: "From the file",
      },
    ],
    shadowed: [
      {
        id: "file-window",
        index: null,
        source: "database",
        checkIds: ["web"],
        start: 1793000000000,
        end: 1793003600000,
        note: "Old copy",
      },
    ],
  };
}

function api(): IncidentApi {
  const s = seed();
  const a = startIncidentApi({
    token: TOKEN,
    config: incidentConfig,
    maintenance: s.windows,
    shadowed: s.shadowed,
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

/** Opens `page` as `role`, takes the token of `action`, resets the record and posts. */
async function submit(
  c: TeamConsole,
  a: IncidentApi,
  view: { page: string; action: string; entries: Entries; role?: ConsoleRole },
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

function calls(a: IncidentApi): string[] {
  return a.seen.map((s) => `${s.method} ${s.path}`);
}

function mainOf(body: string): string {
  const start = body.indexOf('<main id="main"');
  const end = body.indexOf("</main>");
  return start < 0 || end < 0 ? "" : body.slice(start, end);
}

function hits(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** Section "Required behavior": no screen form in main, the shell's Sign out form kept. */
function expectNoScreenForm(body: string, action: string): void {
  expect(hits(mainOf(body), "<form")).toBe(0);
  expect(hits(mainOf(body), 'name="form_token"')).toBe(0);
  expect(hits(body, `action="${action}`)).toBe(0);
  expect(hits(body, 'name="form_token"')).toBe(1);
  expect(hits(body, 'action="/sign-out"')).toBe(1);
}

type PeopleRow = { action: string; target_kind: string; target_name: string; value: string | null };

function peopleRows(c: TeamConsole): PeopleRow[] {
  return c.db
    .query<PeopleRow, []>(
      "SELECT action, target_kind, target_name, value FROM people_events WHERE action LIKE 'maintenance.%' ORDER BY id",
    )
    .all();
}

const EDIT = "/maintenance/edit?id=db-upgrade";

function editEntries(start: string, end: string, note = "Edited"): Entries {
  return [
    ["revision", REVISION0],
    ["target", "db-upgrade"],
    ["check", "web"],
    ["check", "gone-check"],
    ["start", start],
    ["end", end],
    ["note", note],
  ];
}

const CREATE: Entries = [
  ["revision", REVISION0],
  ["id", "net-work"],
  ["check", "cert"],
  ["check", "db-port"],
  ["component", "web"],
  ["start", "2026-11-07T10:00"],
  ["end", "2026-11-07T11:00:00"],
  ["note", NOTE],
];

describe("GET /maintenance", () => {
  test("shows the sections by api phase with 2 reads and 0 writes", async () => {
    const a = api();
    const c = await team(a);
    const page = await getPage(c, "/maintenance", c.cookies.owner);
    expect(page.status).toBe(200);
    expect(calls(a)).toEqual(["GET /admin/maintenance", "GET /admin/config"]);
    expect(page.body).toContain("Current (1)");
    expect(page.body).toContain("Planned (1)");
    expect(page.body).toContain("Past (1)");
    expect(page.body).toContain("Shadowed by the checks file (1)");
    expect(page.body).toContain("gone-check (not configured; does not apply now)");
    expect(page.body).toContain("From the checks file, read-only");
    expect(page.body).toContain('href="/maintenance/edit?id=db-upgrade">Edit</a>');
    expect(page.body).toContain(">Delete database copy</a>");
    expect(page.body).toContain('href="/maintenance/new">Plan maintenance</a>');
    expect(page.body).toContain("As of <time");
  });

  test("a viewer sees no actions", async () => {
    const a = api();
    const c = await team(a);
    const page = await getPage(c, "/maintenance", c.cookies.viewer);
    expect(page.status).toBe(200);
    expect(page.body).not.toContain("/maintenance/edit");
    expect(page.body).not.toContain("/maintenance/delete");
    expect(page.body).not.toContain("Plan maintenance");
  });

  test.each([404, 405])("an old api (%i) shows the old-api text without form", async (status) => {
    const a = api();
    a.override(
      "GET",
      "/admin/maintenance",
      () => new Response(JSON.stringify({ error: "no" }), { status, headers: WIRE_HEADERS }),
    );
    const c = await team(a);
    for (const path of ["/maintenance", "/maintenance/new", EDIT]) {
      const page = await getPage(c, path, c.cookies.owner);
      expect(page.body).toContain(
        "This pulse-api is too old for the Maintenance page. It needs database maintenance windows (pulse-api with #765).",
      );
      expectNoScreenForm(page.body, path.split("?")[0] ?? path);
    }
    expect(a.writes()).toBe(0);
  });
});

describe("maintenance form GET", () => {
  test("new and edit read twice; edit prefills seconds and keeps a stale check", async () => {
    const a = api();
    const c = await team(a);
    const created = await getPage(c, "/maintenance/new", c.cookies.member);
    expect(created.status).toBe(200);
    expect(calls(a)).toEqual(["GET /admin/maintenance", "GET /admin/config"]);
    a.seen.length = 0;
    const edit = await getPage(c, EDIT, c.cookies.member);
    expect(edit.status).toBe(200);
    expect(calls(a)).toEqual(["GET /admin/maintenance", "GET /admin/config"]);
    expect(edit.body).toContain('value="2026-11-06T10:00:00"');
    expect(edit.body).toContain('value="2026-11-06T12:00:00"');
    expect(edit.body).toContain('value="gone-check" checked> gone-check (not configured)');
    expect(edit.body).toContain('<input type="hidden" name="target" value="db-upgrade">');
  });

  test("a revision mismatch reads both once more (4 reads); still stale shows no form", async () => {
    const a = api();
    let flips = 0;
    const flip = () => {
      flips += 1;
      a.bumpRevision();
    };
    const c = await team(a);
    a.seen.length = 0;
    // Both config reads see a changed revision, so the retry disagrees as well.
    a.beforeAnswer("GET", "/admin/config", () => {
      flip();
      a.beforeAnswer("GET", "/admin/config", flip);
    });
    const page = await getPage(c, "/maintenance/new", c.cookies.member);
    expect(flips).toBe(2);
    expect(calls(a)).toEqual([
      "GET /admin/maintenance",
      "GET /admin/config",
      "GET /admin/maintenance",
      "GET /admin/config",
    ]);
    expect(page.status).toBe(409);
    expectNoScreenForm(page.body, "/maintenance/new");
  });

  test("one mismatch then agreement shows the form after 4 reads", async () => {
    const a = api();
    const c = await team(a);
    a.seen.length = 0;
    a.beforeAnswer("GET", "/admin/config", () => a.bumpRevision());
    const page = await getPage(c, "/maintenance/new", c.cookies.member);
    expect(page.status).toBe(200);
    expect(a.reads()).toBe(4);
    expect(page.body).toContain(`name="revision" value="${a.revision()}"`);
  });

  test.each(["file-window", "planned-x"])("edit of %s has no form", async (id) => {
    const a = api();
    const c = await team(a);
    const page = await getPage(c, `/maintenance/edit?id=${id}`, c.cookies.member);
    expect(page.status).toBe(id === "file-window" ? 409 : 404);
    expectNoScreenForm(page.body, "/maintenance/edit");
    expect(a.reads()).toBe(2);
  });

  test.each(["1window", "Window", "a".repeat(65)])(
    "id %s answers 404 without reads",
    async (id) => {
      const a = api();
      const c = await team(a);
      const page = await getPage(c, `/maintenance/edit?id=${id}`, c.cookies.member);
      expect(page.status).toBe(404);
      expect(a.seen).toHaveLength(0);
    },
  );
});

describe("POST /maintenance/new", () => {
  test("creates with 1 read and 1 write, quoted If-Match and an id-only People row", async () => {
    const a = api();
    const c = await team(a);
    const reply = await submit(c, a, {
      page: "/maintenance/new",
      action: "/maintenance/new",
      entries: CREATE,
    });
    expect(reply.status).toBe(303);
    expect(reply.headers.get("location")).toBe("/maintenance?saved=1");
    expect(calls(a)).toEqual(["GET /admin/config", "POST /admin/maintenance"]);
    expect(a.seen[1]?.body).toEqual({
      id: "net-work",
      checkIds: ["cert", "db-port", "web"],
      start: 1794045600000,
      end: 1794049200000,
      note: NOTE,
    });
    expect(peopleRows(c)).toEqual([
      {
        action: "maintenance.create",
        target_kind: "maintenance",
        target_name: "net-work",
        value: `sha256-${"b".repeat(63)}1`,
      },
    ]);
    const list = await getPage(c, "/maintenance?saved=1", c.cookies.member);
    expect(list.body).toContain("Maintenance window saved.");
  });

  test("an existing id is the api's 409 after 1 read and 1 write, input kept", async () => {
    const a = api();
    const c = await team(a);
    const entries = CREATE.map(([k, v]): [string, string] => [k, k === "id" ? "db-upgrade" : v]);
    const reply = await submit(c, a, {
      page: "/maintenance/new",
      action: "/maintenance/new",
      entries,
    });
    expect(reply.status).toBe(409);
    expect([a.reads(), a.writes()]).toEqual([1, 1]);
    expect(reply.body).toContain("a window with this id exists");
    expect(reply.body).toContain('value="db-upgrade"');
    expect(peopleRows(c)).toEqual([]);
  });

  test.each([
    ["no check", [["check", ""]], "Select 1 to 50 checks; this selection has"],
    ["equal times", [["end", "2026-11-07T10:00"]], "End must be after start."],
    ["bad date", [["start", "2026-02-30T10:00"]], "Enter a date and time"],
    ["unknown component", [["component", "nope"]], "Component nope is not configured any more."],
  ] as const)("%s gives 422 after 1 read and 0 writes", async (_name, change, text) => {
    const a = api();
    const c = await team(a);
    const names = new Set<string>(change.map(([k]) => k));
    const base = CREATE.filter(
      ([k]) => !names.has(k) && !(names.has("check") && k === "component"),
    );
    const entries = [...base, ...change.filter(([, v]) => v !== "")];
    const reply = await submit(c, a, {
      page: "/maintenance/new",
      action: "/maintenance/new",
      entries,
    });
    expect(reply.status).toBe(422);
    expect(reply.body).toContain(text);
    expect([a.reads(), a.writes()]).toEqual([1, 0]);
  });

  test("a changed revision is stale with the input as text, 1 read and 0 writes", async () => {
    const a = api();
    const c = await team(a);
    const opened = await getPage(c, "/maintenance/new", c.cookies.member);
    const token = formTokenOf(opened.body, "/maintenance/new");
    a.bumpRevision();
    a.seen.length = 0;
    const reply = await post(
      c,
      "/maintenance/new",
      [["csrf", c.csrfs.member], ["form_token", token], ...CREATE],
      "member",
    );
    expect(reply.status).toBe(409);
    expect(reply.body).toContain("Open the form again");
    expect(reply.body).toContain(NOTE);
    expect(calls(a)).toEqual(["GET /admin/config"]);
  });

  test("dispatcher refusals send 0 api requests", async () => {
    const a = api();
    const c = await team(a);
    const viewer = await post(
      c,
      "/maintenance/new",
      [["csrf", c.csrfs.viewer], ...CREATE],
      "viewer",
    );
    expect(viewer.status).toBe(403);
    const wrongCsrf = await post(c, "/maintenance/new", [["csrf", "nope"], ...CREATE], "member");
    expect(wrongCsrf.status).toBe(403);
    const twice = await post(
      c,
      "/maintenance/new",
      [["csrf", c.csrfs.member], ...CREATE, ["check", "cert"]],
      "member",
    );
    expect(twice.status).toBe(400);
    const many = Array.from({ length: 1001 }, (_, i): [string, string] => ["check", `c${i}`]);
    const tooMany = await post(
      c,
      "/maintenance/new",
      [["csrf", c.csrfs.member], ...many],
      "member",
    );
    expect(tooMany.status).toBe(400);
    const big = await post(
      c,
      "/maintenance/new",
      [
        ["csrf", c.csrfs.member],
        ["note", "x".repeat(131072)],
      ],
      "member",
    );
    expect(big.status).toBe(413);
    expect(a.seen).toHaveLength(0);
  });

  test("a timeout-free unknown answer shows the unknown text after 1 write, People value unknown", async () => {
    const a = api();
    a.override("POST", "/admin/maintenance", () => new Response("<html>", { status: 200 }));
    const c = await team(a);
    const reply = await submit(c, a, {
      page: "/maintenance/new",
      action: "/maintenance/new",
      entries: CREATE,
    });
    expect(reply.status).toBe(502);
    expect(reply.body).toContain(
      "The result is unknown. Open Maintenance to see whether the window was saved.",
    );
    expect([a.reads(), a.writes()]).toEqual([1, 1]);
    expect(peopleRows(c).map((r) => r.value)).toEqual(["unknown"]);
  });
});

describe("POST /maintenance/edit", () => {
  test.each([
    ["seconds kept", "2026-11-06T10:00:00", "2026-11-06T12:00:00", 1793959200123, 1793966400456],
    ["browser text", "2026-11-06T10:00", "2026-11-06T12:00", 1793959200123, 1793966400456],
    ["next second", "2026-11-06T10:00:01", "2026-11-06T12:00", 1793959201000, 1793966400456],
    ["previous second", "2026-11-06T09:59:59", "2026-11-06T12:00:00", 1793959199000, 1793966400456],
  ] as const)("%s: 2 reads, 1 PUT with start %s", async (_n, start, end, sentStart, sentEnd) => {
    const a = api();
    const c = await team(a);
    const reply = await submit(c, a, {
      page: EDIT,
      action: EDIT,
      entries: editEntries(start, end),
    });
    expect(reply.status).toBe(303);
    expect(reply.headers.get("location")).toBe("/maintenance?saved=1");
    expect(calls(a)).toEqual([
      "GET /admin/maintenance",
      "GET /admin/config",
      "PUT /admin/maintenance/db-upgrade",
    ]);
    expect(a.seen[2]?.body).toEqual({
      id: "db-upgrade",
      checkIds: ["web", "gone-check"],
      start: sentStart,
      end: sentEnd,
      note: "Edited",
    });
    expect(peopleRows(c).map((r) => [r.action, r.target_name])).toEqual([
      ["maintenance.replace", "db-upgrade"],
    ]);
  });

  test("posted hidden epochs are ignored: the stored ones come from the maintenance read", async () => {
    const a = api();
    const c = await team(a);
    const entries = [
      ...editEntries("2026-11-06T10:00", "2026-11-06T12:00"),
      ["start_ms", "1"],
    ] as const;
    const reply = await submit(c, a, { page: EDIT, action: EDIT, entries });
    // An unknown field is ignored; the PUT keeps the epochs of the maintenance read.
    expect(reply.status).toBe(303);
    expect(a.seen[2]?.body).toMatchObject({ start: 1793959200123, end: 1793966400456 });
  });

  test.each(["GET /admin/maintenance", "GET /admin/config"])(
    "a revision change seen by %s is stale after exactly 2 reads and 0 writes",
    async (call) => {
      const a = api();
      const c = await team(a);
      const opened = await getPage(c, EDIT, c.cookies.member);
      const token = formTokenOf(opened.body, EDIT);
      const [method, path] = call.split(" ");
      a.beforeAnswer(method ?? "", path ?? "", () => a.bumpRevision());
      a.seen.length = 0;
      const reply = await post(
        c,
        EDIT,
        [
          ["csrf", c.csrfs.member],
          ["form_token", token],
          ...editEntries("2026-11-06T10:00", "2026-11-06T12:00"),
        ],
        "member",
      );
      expect(reply.status).toBe(409);
      expect(reply.body).toContain("Open the form again");
      expect(calls(a)).toEqual(["GET /admin/maintenance", "GET /admin/config"]);
    },
  );

  test("a forged edit of a file window is refused by the console after 2 reads", async () => {
    const a = api();
    const c = await team(a);
    const opened = await getPage(c, EDIT, c.cookies.member);
    const token = formTokenOf(opened.body, EDIT);
    a.seen.length = 0;
    const entries = editEntries("2026-11-06T10:00", "2026-11-06T12:00").map(
      ([k, v]): [string, string] => [k, k === "target" ? "file-window" : v],
    );
    // The form token is bound to the path, so the forged target posts to its own query.
    const reply = await post(
      c,
      "/maintenance/edit?id=file-window",
      [["csrf", c.csrfs.member], ["form_token", token], ...entries],
      "member",
    );
    expect(reply.status).toBe(409);
    expect(reply.body).toContain(
      "This window comes from the checks file or is shadowed by it; it cannot be edited here.",
    );
    expect(calls(a)).toEqual(["GET /admin/maintenance", "GET /admin/config"]);
  });

  test("a window deleted since the GET answers 404 after 2 reads", async () => {
    const a = api();
    const c = await team(a);
    const opened = await getPage(c, EDIT, c.cookies.member);
    const token = formTokenOf(opened.body, EDIT);
    a.windows.splice(0, 1);
    a.seen.length = 0;
    const reply = await post(
      c,
      EDIT,
      [
        ["csrf", c.csrfs.member],
        ["form_token", token],
        ...editEntries("2026-11-06T10:00", "2026-11-06T12:00"),
      ],
      "member",
    );
    expect(reply.status).toBe(404);
    expect(reply.body).toContain("This maintenance window no longer exists.");
    expect(a.reads()).toBe(2);
    expect(a.writes()).toBe(0);
  });

  test.each([
    ["role lowered", 403],
    ["session removed", 409],
  ] as const)("%s during the last read: %i after 2 reads and 0 writes", async (kind, status) => {
    const a = api();
    const c = await team(a);
    const opened = await getPage(c, EDIT, c.cookies.member);
    const token = formTokenOf(opened.body, EDIT);
    a.beforeAnswer("GET", "/admin/config", () => {
      if (kind === "role lowered") {
        c.db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(c.ids.member);
      } else {
        c.db.query("DELETE FROM sessions WHERE user_id = ?").run(c.ids.member);
      }
    });
    a.seen.length = 0;
    const reply = await post(
      c,
      EDIT,
      [
        ["csrf", c.csrfs.member],
        ["form_token", token],
        ...editEntries("2026-11-06T10:00", "2026-11-06T12:00"),
      ],
      "member",
    );
    expect(reply.status).toBe(status);
    expect(calls(a)).toEqual(["GET /admin/maintenance", "GET /admin/config"]);
  });

  test("the api's 412 keeps the input after exactly 1 write and leaves the window", async () => {
    const a = api();
    a.override(
      "PUT",
      "/admin/maintenance/",
      () =>
        new Response(JSON.stringify({ error: "revision changed" }), {
          status: 412,
          headers: WIRE_HEADERS,
        }),
    );
    const c = await team(a);
    const reply = await submit(c, a, {
      page: EDIT,
      action: EDIT,
      entries: editEntries("2026-11-06T10:00", "2026-11-06T12:00"),
    });
    expect(reply.status).toBe(412);
    expect(reply.body).toContain("Open the form again");
    expect(reply.body).toContain("Edited");
    expect([a.reads(), a.writes()]).toEqual([2, 1]);
    expect(a.windows[0]?.note).toBe(NOTE);
  });
});

describe("/maintenance/delete", () => {
  test("GET reads once; POST makes no read and 1 DELETE with If-Match", async () => {
    const a = api();
    const c = await team(a);
    const opened = await getPage(c, "/maintenance/delete?id=db-upgrade", c.cookies.admin);
    expect(opened.status).toBe(200);
    expect(opened.body).toContain("Delete maintenance window db-upgrade?");
    expect(calls(a)).toEqual(["GET /admin/maintenance"]);
    const token = formTokenOf(opened.body, "/maintenance/delete?id=db-upgrade");
    a.seen.length = 0;
    const reply = await post(
      c,
      "/maintenance/delete?id=db-upgrade",
      [
        ["csrf", c.csrfs.admin],
        ["form_token", token],
        ["revision", REVISION0],
        ["target", "db-upgrade"],
      ],
      "admin",
    );
    expect(reply.status).toBe(303);
    expect(reply.headers.get("location")).toBe("/maintenance?deleted=1");
    expect(calls(a)).toEqual(["DELETE /admin/maintenance/db-upgrade"]);
    expect(a.windows.some((w) => w.id === "db-upgrade")).toBe(false);
    expect(peopleRows(c).map((r) => [r.action, r.target_name])).toEqual([
      ["maintenance.delete", "db-upgrade"],
    ]);
  });

  test("a shadowed id deletes only the database copy", async () => {
    const a = api();
    const c = await team(a);
    const opened = await getPage(c, "/maintenance/delete?id=file-window", c.cookies.admin);
    expect(opened.body).toContain(
      "Delete the database copy of file-window? The file window stays in force.",
    );
    const token = formTokenOf(opened.body, "/maintenance/delete?id=file-window");
    const reply = await post(
      c,
      "/maintenance/delete?id=file-window",
      [
        ["csrf", c.csrfs.admin],
        ["form_token", token],
        ["revision", REVISION0],
        ["target", "file-window"],
      ],
      "admin",
    );
    expect(reply.status).toBe(303);
    expect(a.shadowed).toHaveLength(0);
    expect(a.windows.some((w) => w.id === "file-window" && w.source === "file")).toBe(true);
  });

  test("an unknown id answers 404; a member's forged delete is 403 with 0 api requests", async () => {
    const a = api();
    const c = await team(a);
    const unknown = await getPage(c, "/maintenance/delete?id=none-here", c.cookies.admin);
    expect(unknown.status).toBe(404);
    a.seen.length = 0;
    const forged = await post(
      c,
      "/maintenance/delete?id=db-upgrade",
      [
        ["csrf", c.csrfs.member],
        ["revision", REVISION0],
        ["target", "db-upgrade"],
      ],
      "member",
    );
    expect(forged.status).toBe(403);
    expect(a.seen).toHaveLength(0);
  });
});

describe("maintenance secrets", () => {
  test("the token never reaches a response, a log line or the database; the note no log or People row", async () => {
    const a = api();
    const c = await team(a);
    const reply = await submit(c, a, {
      page: "/maintenance/new",
      action: "/maintenance/new",
      entries: CREATE,
    });
    expect(reply.body).not.toContain(TOKEN);
    const list = await getPage(c, "/maintenance", c.cookies.owner);
    expect(list.body).not.toContain(TOKEN);
    expect(c.logs.join("\n")).not.toContain(TOKEN);
    expect(c.logs.join("\n")).not.toContain(NOTE);
    expect(JSON.stringify(peopleRows(c))).not.toContain(NOTE);
    const tables = c.db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    for (const { name } of tables) {
      const rows = c.db.query(`SELECT * FROM "${name}"`).all();
      expect(JSON.stringify(rows)).not.toContain(TOKEN);
    }
  });
});
