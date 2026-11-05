import { afterEach, describe, expect, test } from "bun:test";
import { emptyConfig, type FakeApi, jsonReply, startFakeApi } from "../test/fake-api.ts";
import { formTokenOf, getPage, postForm } from "../test/signed-in-console.ts";
import { startTeamConsole, type TeamConsole } from "../test/team-console.ts";
import type { ConsoleRole } from "./roles.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function team(isRequiredForAll = false): Promise<{ c: TeamConsole; api: FakeApi }> {
  const api = startFakeApi();
  cleanups.push(() => api.stop());
  api.reply("/checks", jsonReply([]));
  api.reply("/config", jsonReply(emptyConfig));
  const c = await startTeamConsole({ apiUrl: api.url, adminToken: "t", isRequiredForAll });
  cleanups.push(() => c.close());
  return { c, api };
}

const ROLES: readonly ConsoleRole[] = ["viewer", "member", "admin", "owner"];

describe("row 1 overview.view at HTTP level", () => {
  test.each([...ROLES])("GET / is 200 for %s with a stored role", async (role) => {
    const { c } = await team();
    expect((await getPage(c, "/", c.cookies[role])).status).toBe(200);
  });

  test("without a session GET / is 303 to sign-in", async () => {
    const { c } = await team();
    const r = await getPage(c, "/", "");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/sign-in?next=%2F");
  });
});

describe("team.view at HTTP level", () => {
  test.each([
    ["owner", 200],
    ["admin", 200],
    ["member", 403],
    ["viewer", 403],
  ] as const)("GET /team as %s is %d", async (role, status) => {
    const { c, api } = await team();
    const r = await getPage(c, "/team", c.cookies[role]);
    expect(r.status).toBe(status);
    if (status === 403) {
      expect(r.body).toContain("<h2>Access denied</h2>");
      const label = role === "member" ? "Member" : "Viewer";
      expect(r.body).toContain(
        `<p>This page needs the Admin role or higher. Your role is ${label}.</p>`,
      );
    }
    expect(api.seen).toHaveLength(0);
  });

  test("without a session GET /team is 303 to sign-in", async () => {
    const { c } = await team();
    const r = await getPage(c, "/team", "");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/sign-in?next=%2Fteam");
  });
});

describe("route inventory", () => {
  // Literal required role of every production protected route (section 8, routes built so far).
  const PROTECTED: readonly (readonly [string, ConsoleRole])[] = [
    ["/", "viewer"],
    ["/team", "admin"],
  ];
  const ORDER: readonly ConsoleRole[] = ["viewer", "member", "admin", "owner"];

  test.each(PROTECTED)("%s needs %s", async (path, needed) => {
    const { c } = await team();
    const index = ORDER.indexOf(needed);
    for (const [i, role] of ORDER.entries()) {
      const r = await getPage(c, path, c.cookies[role]);
      expect([role, r.status]).toEqual([role, i >= index ? 200 : 403]);
    }
  });

  // Account routes (row 27) need stage full, every role, and no role step.
  const ACCOUNT = [
    "/account/security",
    "/account/recovery-codes",
    "/account/sessions",
    "/account/sessions/sign-out-all",
  ];

  test.each(ACCOUNT)("%s is 200 for every role with a full session", async (path) => {
    const { c } = await team();
    for (const role of ROLES) {
      expect([role, (await getPage(c, path, c.cookies[role])).status]).toEqual([role, 200]);
    }
  });

  test.each(ACCOUNT)("%s sends an enrol stage to the authenticator page", async (path) => {
    const { c } = await team(true);
    const r = await getPage(c, path, c.cookies.member);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/account/authenticator");
  });
});

describe("rows 14 and 15: invites at HTTP level", () => {
  const TABLES = ["users", "invites", "reset_links", "sessions", "authenticators", "people_events"];

  function snapshot(c: TeamConsole): unknown[] {
    return TABLES.map((t) => c.db.query(`SELECT * FROM ${t} ORDER BY rowid`).all());
  }

  async function invite(c: TeamConsole, as: ConsoleRole, role: string) {
    // A Member or Viewer cannot open the Team page; the role step answers before the form token.
    const page = await getPage(c, "/team", c.cookies[as]);
    return postForm(
      c,
      "/team/invites",
      {
        csrf: c.csrfs[as],
        form_token: formTokenOf(page.body, "/team/invites"),
        email: "new@example.com",
        role,
      },
      { cookie: c.cookies[as] },
    );
  }

  test("row 14: Admin invites a Member 200; Member 403 and nothing changes", async () => {
    const { c, api } = await team();
    const before = snapshot(c);
    const denied = await invite(c, "member", "member");
    expect(denied.status).toBe(403);
    expect(denied.body).toContain("This page needs the Admin role or higher. Your role is Member.");
    expect(snapshot(c)).toEqual(before);
    expect((await invite(c, "admin", "member")).status).toBe(200);
    expect(api.seen).toHaveLength(0);
  });

  test("row 15: Owner invites an Admin 200; Admin 403 naming Owner and nothing changes", async () => {
    const { c, api } = await team();
    const before = snapshot(c);
    const denied = await invite(c, "admin", "admin");
    expect(denied.status).toBe(403);
    expect(denied.body).toContain("needs the Owner role");
    expect(snapshot(c)).toEqual(before);
    expect((await invite(c, "owner", "admin")).status).toBe(200);
    expect(api.seen).toHaveLength(0);
  });

  test("the invite routes need Admin: GET /team/invites is 405, revoke is 403 below Admin", async () => {
    const { c } = await team();
    const r = await fetch(`${c.base}/team/invites`, { headers: { cookie: c.cookies.owner } });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
    for (const role of ["viewer", "member"] as const) {
      const page = await getPage(c, "/team/invites/revoke?invite=1", c.cookies[role]);
      expect(page.status).toBe(403);
    }
    expect((await getPage(c, "/team/invites/revoke?invite=1", c.cookies.admin)).status).toBe(404);
  });
});
