import { afterEach, describe, expect, test } from "bun:test";
import {
  type IncidentApi,
  incidentConfig,
  NOW,
  seedAutomatic,
  seedManual,
  seedResults,
  startIncidentApi,
} from "../test/incident-api.ts";
import { expectCalloutsOnly } from "../test/rendered-audit.ts";
import {
  getPage as fetchPage,
  type Reply,
  postForm as sendForm,
} from "../test/signed-in-console.ts";
import { startTeamConsole, type TeamConsole } from "../test/team-console.ts";
import type { ConsoleRole } from "./roles.ts";

/** Every HTML page this suite reads passes the shared callout audit. */
async function audited(reply: Promise<Reply>): Promise<Reply> {
  const r = await reply;
  if ((r.headers.get("content-type") ?? "").includes("text/html")) expectCalloutsOnly(r.body);
  return r;
}

function getPage(...args: Parameters<typeof fetchPage>): Promise<Reply> {
  return audited(fetchPage(...args));
}

function postForm(...args: Parameters<typeof sendForm>): Promise<Reply> {
  return audited(sendForm(...args));
}

const TOKEN = "incidents-admin-token-sentinel-0123456789";

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
    results: seedResults,
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

function get(c: TeamConsole, path: string, role: ConsoleRole = "owner"): Promise<Reply> {
  return getPage(c, path, c.cookies[role]);
}

function mainOf(body: string): string {
  const start = body.indexOf('<main id="main"');
  const end = body.indexOf("</main>");
  return start < 0 || end < 0 ? "" : body.slice(start, end);
}

function hits(text: string, part: string): number {
  return text.split(part).length - 1;
}

describe("GET /incidents", () => {
  test("lists manual and automatic rows with both MTTR values and three reads", async () => {
    const a = api();
    const c = await team(a);
    const page = await get(c, "/incidents");
    expect(page.status).toBe(200);
    expect(page.body).toContain('<a href="/incidents/manual?id=1">Checkout slow</a>');
    expect(page.body).toContain('<a href="/incidents/manual?id=2">Untitled incident #2</a>');
    expect(page.body).toContain('<a href="/incidents/automatic?id=7">Web shop — timeout</a>');
    expect(page.body).toContain('<a href="/incidents/automatic?id=31">. — no reason</a>');
    expect(page.body).toContain("Impact: major");
    expect(page.body).toContain("open for 2 h");
    expect(page.body).toContain("Mean time to resolve, manual incidents");
    expect(page.body).toContain("1 resolved in the last 14 days (pulse-api returns at most 50)");
    expect(page.body).toContain("Mean time to resolve, automatic incidents");
    expect(page.body).toContain("2 resolved in the last 14 days</span>");
    expect(page.body).toContain('href="/incidents/new">Declare incident</a>');
    expect([a.reads(), a.writes()]).toEqual([3, 0]);
    expect(a.count("GET", "/manual-incidents")).toBe(1);
    expect(a.count("GET", "/incidents")).toBe(1);
    expect(a.count("GET", "/admin/config")).toBe(1);
    expect(a.seen.find((s) => s.path === "/incidents")?.query).toBe(
      `?since=${NOW - 1209600000}&limit=1000`,
    );
  });

  test("open rows come first, then resolved rows by resolvedAt", async () => {
    const c = await team(api());
    const body = (await get(c, "/incidents")).body;
    const order = ["id=7", "manual?id=1", "manual?id=3", "manual?id=2", "id=31", "id=32"].map(
      (part) => body.indexOf(part),
    );
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  test("filters keep the other filter and an unknown value is ignored", async () => {
    const c = await team(api());
    const body = (await get(c, "/incidents?state=open&kind=manual")).body;
    expect(body).toContain("manual?id=1");
    expect(body).not.toContain("automatic?id=7");
    expect(body).not.toContain("manual?id=2");
    expect(body).toContain('href="/incidents?state=open&amp;kind=automatic"');
    const ignored = (await get(c, "/incidents?state=later")).body;
    expect(ignored).toContain("Some filters were ignored.");
  });

  test("a filter without matches shows the clear link", async () => {
    const a = startIncidentApi({
      token: TOKEN,
      config: incidentConfig,
      now: () => NOW,
      manual: seedManual().slice(0, 1),
    });
    cleanups.push(() => a.stop());
    const c = await team(a);
    const body = (await get(c, "/incidents?kind=automatic")).body;
    expect(body).toContain("No incidents match these filters.");
    expect(body).toContain('href="/incidents">Clear filters</a>');
  });

  test("no incident at all and a manual list 404 show the empty state", async () => {
    const a = startIncidentApi({ token: TOKEN, config: incidentConfig, now: () => NOW });
    cleanups.push(() => a.stop());
    a.override("GET", "/manual-incidents", () => new Response("", { status: 404 }));
    const c = await team(a);
    const page = await get(c, "/incidents");
    expect(page.status).toBe(200);
    expect(page.body).toContain("No incidents in the last 14 days.");
  });

  test("a private-looking item never reaches the page", async () => {
    const a = api();
    a.setPrivateItem(true);
    const c = await team(a);
    const page = await get(c, "/incidents");
    expect(page.status).toBe(200);
    expect(page.body).not.toContain("Private draft title");
  });

  test("a Viewer sees no Declare incident link", async () => {
    const c = await team(api());
    const page = await get(c, "/incidents", "viewer");
    expect(page.status).toBe(200);
    expect(page.body).not.toContain("Declare incident");
  });

  test("a rejected token shows the banner and no rows", async () => {
    const a = api();
    a.override("GET", "/admin/config", () => new Response("{}", { status: 401 }));
    const c = await team(a);
    const page = await get(c, "/incidents");
    expect(page.status).toBe(502);
    expect(page.body).toContain("pulse-api rejected the console token");
    expect(page.body).not.toContain("manual?id=1");
  });

  test("the deleted callout", async () => {
    const c = await team(api());
    expect((await get(c, "/incidents?deleted=1")).body).toContain("Incident deleted.");
  });
});

describe("GET /incidents/manual", () => {
  test("shows the header, the timeline, the update form and the links", async () => {
    const a = api();
    const c = await team(a);
    const page = await get(c, "/incidents/manual?id=1&published=1");
    expect(page.status).toBe(200);
    expect(page.body).toContain("Incident published.");
    expect(page.body).toContain('<h2 class="incident-title">Checkout slow</h2>');
    expect(page.body).toContain('<li id="update-0">');
    expect(page.body).toContain("Looking into it.");
    expect(page.body).toContain('action="/incidents/update"');
    expect(page.body).toContain('href="/incidents/resolve?id=1">Resolve</a>');
    expect(page.body).toContain('href="/incidents/delete?id=1">Delete</a>');
    expect([a.reads(), a.writes()]).toEqual([2, 0]);
  });

  test("component names fall back to the id", async () => {
    const c = await team(api());
    const body = (await get(c, "/incidents/manual?id=3")).body;
    expect(body).toContain("Public API, gone");
  });

  test("a resolved incident has no form of its own for any role", async () => {
    const c = await team(api());
    const page = await get(c, "/incidents/manual?id=2");
    expect(page.status).toBe(200);
    expect(page.body).toContain("Untitled incident #2");
    const main = mainOf(page.body);
    expect(hits(main, "<form")).toBe(0);
    expect(hits(main, 'name="form_token"')).toBe(0);
    expect(hits(page.body, 'name="form_token"')).toBe(1);
    expect(hits(page.body, 'action="/sign-out"')).toBe(1);
    expect(page.body).not.toContain("/incidents/resolve?id=2");
  });

  test("a Viewer sees no update form, no Resolve and no Delete", async () => {
    const c = await team(api());
    const page = await get(c, "/incidents/manual?id=1", "viewer");
    expect(page.status).toBe(200);
    expect(page.body).not.toContain('action="/incidents/update"');
    expect(page.body).not.toContain(">Resolve</a>");
    expect(page.body).not.toContain(">Delete</a>");
  });

  test("an unknown id answers 404 with the incident text", async () => {
    const c = await team(api());
    const page = await get(c, "/incidents/manual?id=99");
    expect(page.status).toBe(404);
    expect(page.body).toContain("This incident does not exist or is not public.");
  });

  for (const query of ["", "?id=", "?id=01", "?id=1&id=1", "?id=abc", "?id=1234567890123456"]) {
    test(`id query ${JSON.stringify(query)} answers 404 without an api request`, async () => {
      const a = api();
      const c = await team(a);
      const page = await get(c, `/incidents/manual${query}`);
      expect(page.status).toBe(404);
      expect(a.seen).toHaveLength(0);
    });
  }
});

describe("GET /incidents/automatic", () => {
  test("shows the check, the reason and its results with three reads", async () => {
    const a = api();
    const c = await team(a);
    const page = await get(c, "/incidents/automatic?id=7");
    expect(page.status).toBe(200);
    expect(page.body).toContain('href="/checks/check?id=web">Web shop</a>');
    expect(page.body).toContain("timeout");
    expect(page.body).toContain("They cannot be edited here.");
    expect(page.body).toContain('href="/incidents/new?from=7">Post a public update</a>');
    expect(page.body).toContain('aria-label="Results table"');
    expect([a.reads(), a.writes()]).toEqual([3, 0]);
    expect(a.seen.at(-1)?.query).toBe("?limit=20");
  });

  for (const [id, checkId] of [
    [31, "."],
    [32, ".."],
  ] as const) {
    test(`check id ${checkId} sends no results read`, async () => {
      const a = api();
      const c = await team(a);
      const page = await get(c, `/incidents/automatic?id=${id}`);
      expect(page.status).toBe(200);
      expect(page.body).toContain(
        `pulse-api cannot address the id &quot;${checkId}&quot; in a URL path`,
      );
      expect([a.reads(), a.writes()]).toEqual([2, 0]);
      expect(a.count("GET", "/checks")).toBe(0);
    });
  }

  test("a removed check shows the no-results text", async () => {
    const a = startIncidentApi({
      token: TOKEN,
      config: incidentConfig,
      automatic: [
        { id: 8, checkId: "removed", openedAt: NOW - 5000, resolvedAt: NOW - 1000, reason: null },
      ],
      now: () => NOW,
    });
    cleanups.push(() => a.stop());
    const c = await team(a);
    const page = await get(c, "/incidents/automatic?id=8");
    expect(page.status).toBe(200);
    expect(page.body).toContain("The check no longer exists; no results.");
    expect(a.seen.at(-1)?.query).toBe(`?limit=20&before=${NOW - 999}`);
  });

  test("an id outside the window answers 404 with its text", async () => {
    const c = await team(api());
    const page = await get(c, "/incidents/automatic?id=5");
    expect(page.status).toBe(404);
    expect(page.body).toContain(
      "This automatic incident is not among the incidents of the last 14 days.",
    );
  });

  test("POST answers 405 with Allow: GET, HEAD", async () => {
    const a = api();
    const c = await team(a);
    const res = await postForm(c, "/incidents/automatic?id=7", { csrf: c.csrfs.owner });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(a.seen).toHaveLength(0);
  });
});

describe("GET /incidents/new", () => {
  test("from=31 preselects the component that contains check .", async () => {
    const a = api();
    const c = await team(a);
    const page = await get(c, "/incidents/new?from=31");
    expect(page.status).toBe(200);
    expect(page.body).toContain(
      'value="public-api" data-name="Public API" checked> Public API</label>',
    );
    expect(page.body).toContain('value="web" data-name="Web"> Web</label>');
    expect(page.body).toContain(
      "Publishing creates a new manual incident. Automatic incident #31 stays unchanged.",
    );
    expect([a.reads(), a.writes()]).toEqual([2, 0]);
    expect(a.seen.map((s) => s.path)).toEqual(["/incidents", "/admin/config"]);
  });

  test("from of an unknown incident preselects nothing", async () => {
    const c = await team(api());
    const body = (await get(c, "/incidents/new?from=5")).body;
    expect(body).toContain(
      "Automatic incident #5 is not among the incidents of the last 14 days; nothing was preselected.",
    );
    expect(body).not.toContain(" checked> Public API");
  });

  test("a check in no component says so", async () => {
    const c = await team(api());
    const body = (await get(c, "/incidents/new?from=32")).body;
    expect(body).toContain(
      "No component contains check ..; pick components or publish a general incident.",
    );
  });

  test("without from it reads only the config and never prefills text", async () => {
    const a = api();
    const c = await team(a);
    const page = await get(c, "/incidents/new");
    expect(page.status).toBe(200);
    expect(page.body).toContain('name="impact" value="minor" checked');
    expect(page.body).toContain('name="status" value="investigating" checked');
    expect(page.body).toContain("Status page preview");
    expect(a.seen.map((s) => s.path)).toEqual(["/admin/config"]);
  });

  test("a Viewer gets 403 and a Viewer's forged POST makes zero api requests", async () => {
    const a = api();
    const c = await team(a);
    expect((await get(c, "/incidents/new", "viewer")).status).toBe(403);
    const res = await postForm(
      c,
      "/incidents/new",
      { csrf: c.csrfs.viewer, form_token: "x", title: "T", action: "publish" },
      { cookie: c.cookies.viewer },
    );
    expect(res.status).toBe(403);
    expect(a.seen).toHaveLength(0);
  });

  test("a Member opens the delete page with 403", async () => {
    const a = api();
    const c = await team(a);
    expect((await get(c, "/incidents/delete?id=1", "member")).status).toBe(403);
    expect(a.seen).toHaveLength(0);
  });
});
