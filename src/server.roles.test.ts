import { afterEach, describe, expect, test } from "bun:test";
import { emptyConfig, type FakeApi, jsonReply, startFakeApi } from "../test/fake-api.ts";
import { formTokenOf, getPage, OWNER_PASSWORD, postForm } from "../test/signed-in-console.ts";
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
  // Literal required role of every member route of section 8; GET on a Viewer target.
  const MEMBER_ROUTES: readonly (readonly [string, ConsoleRole])[] = [
    ["/team/role", "owner"],
    ["/team/remove", "admin"],
    ["/team/reset-2fa", "admin"],
  ];

  test.each(MEMBER_ROUTES)("%s?user=<viewer> needs %s", async (path, needed) => {
    const { c } = await team();
    const index = ORDER.indexOf(needed);
    for (const [i, role] of ORDER.entries()) {
      if (role === "viewer") continue; // the target itself: a self action, checked elsewhere
      const r = await getPage(c, `${path}?user=${c.ids.viewer}`, c.cookies[role]);
      expect([role, r.status]).toEqual([role, i >= index ? 200 : 403]);
    }
  });

  test("/team/transfer and POST /team/require-2fa need the Owner", async () => {
    const { c } = await team();
    for (const role of ["viewer", "member", "admin"] as const) {
      expect((await getPage(c, `/team/transfer?user=${c.ids.admin}`, c.cookies[role])).status).toBe(
        403,
      );
      const r = await postForm(
        c,
        "/team/require-2fa",
        { csrf: c.csrfs[role], form_token: "x", value: "on" },
        { cookie: c.cookies[role] },
      );
      expect([role, r.status]).toEqual([role, 403]);
    }
    expect((await getPage(c, `/team/transfer?user=${c.ids.admin}`, c.cookies.owner)).status).toBe(
      200,
    );
    const r = await fetch(`${c.base}/team/require-2fa`, { headers: { cookie: c.cookies.owner } });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
  });
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

describe("rows 16 to 19 and 23 to 25 and team.require-2fa at HTTP level", () => {
  const TABLES = ["users", "invites", "reset_links", "sessions", "authenticators", "people_events"];

  function snapshot(c: TeamConsole): unknown[] {
    return TABLES.map((t) => c.db.query(`SELECT * FROM ${t} ORDER BY rowid`).all());
  }

  function revisionOf(c: TeamConsole, id: number): string {
    const row = c.db
      .query<{ created_at: number; role: string }, [number]>(
        "SELECT created_at, role FROM users WHERE id = ?",
      )
      .get(id);
    return `${row?.created_at}-${row?.role}`;
  }

  /**
   * POSTs `path?user=<target>` as `as`. The form token comes from the GET of `tokenFrom` (a target
   * the actor may open), because the token binds to the path without the query.
   */
  async function act(
    c: TeamConsole,
    as: ConsoleRole,
    path: string,
    target: ConsoleRole,
    fields: Record<string, string> = {},
    tokenFrom: ConsoleRole = target,
  ) {
    const page = await getPage(c, `${path}?user=${c.ids[tokenFrom]}`, c.cookies[as]);
    return postForm(
      c,
      `${path}?user=${c.ids[target]}`,
      {
        csrf: c.csrfs[as],
        form_token: formTokenOf(page.body, `${path}?user=${c.ids[tokenFrom]}`),
        revision: revisionOf(c, c.ids[target]),
        ...fields,
      },
      { cookie: c.cookies[as] },
    );
  }

  async function denied(
    c: TeamConsole,
    api: FakeApi,
    run: () => Promise<{ status: number; body: string }>,
    text: string,
  ) {
    const before = snapshot(c);
    const r = await run();
    expect(r.status).toBe(403);
    expect(r.body).toContain(text);
    expect(snapshot(c)).toEqual(before);
    expect(api.seen).toHaveLength(0);
  }

  function roleOf(c: TeamConsole, id: number): string | undefined {
    return c.db.query<{ role: string }, [number]>("SELECT role FROM users WHERE id = ?").get(id)
      ?.role;
  }

  test("row 16: Admin removes a Viewer 303; Member 403", async () => {
    const { c, api } = await team();
    await denied(
      c,
      api,
      () => act(c, "member", "/team/remove", "viewer", { confirm_name: "Vi Viewer" }),
      "needs the Admin role",
    );
    const r = await act(c, "admin", "/team/remove", "viewer", { confirm_name: "Vi Viewer" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/team");
    expect(roleOf(c, c.ids.viewer)).toBeUndefined();
  });

  test("row 17: Owner removes an Admin 303; Admin 403", async () => {
    const { c, api } = await team();
    await denied(
      c,
      api,
      () => act(c, "admin", "/team/remove", "admin", { confirm_name: "Ada Admin" }, "viewer"),
      "needs the Owner role",
    );
    expect(
      (await act(c, "owner", "/team/remove", "admin", { confirm_name: "Ada Admin" })).status,
    ).toBe(303);
    expect(roleOf(c, c.ids.admin)).toBeUndefined();
  });

  test("row 18: Owner changes Member to Viewer 303; Admin 403", async () => {
    const { c, api } = await team();
    await denied(
      c,
      api,
      () => act(c, "admin", "/team/role", "member", { role: "viewer" }),
      "needs the Owner role",
    );
    expect((await act(c, "owner", "/team/role", "member", { role: "viewer" })).status).toBe(303);
    expect(roleOf(c, c.ids.member)).toBe("viewer");
  });

  test("row 19: Owner promotes a Member to Admin 303; Admin 403", async () => {
    const { c, api } = await team();
    await denied(
      c,
      api,
      () => act(c, "admin", "/team/role", "member", { role: "admin" }),
      "needs the Owner role",
    );
    expect((await act(c, "owner", "/team/role", "member", { role: "admin" })).status).toBe(303);
    expect(roleOf(c, c.ids.member)).toBe("admin");
  });

  test("row 23: Admin resets a Viewer's 2FA 303; Member 403", async () => {
    const { c, api } = await team();
    await denied(
      c,
      api,
      () => act(c, "member", "/team/reset-2fa", "viewer"),
      "needs the Admin role",
    );
    expect((await act(c, "admin", "/team/reset-2fa", "viewer")).status).toBe(303);
  });

  test("row 24: Owner resets an Admin's 2FA 303; Admin 403", async () => {
    const { c, api } = await team();
    await denied(
      c,
      api,
      () => act(c, "admin", "/team/reset-2fa", "admin", {}, "viewer"),
      "needs the Owner role",
    );
    expect((await act(c, "owner", "/team/reset-2fa", "admin")).status).toBe(303);
    const n = c.db
      .query<{ n: number }, [number]>("SELECT count(*) AS n FROM authenticators WHERE user_id = ?")
      .get(c.ids.admin)?.n;
    expect(n).toBe(0);
  });

  test("row 25: Owner transfers to an enrolled Admin 303 to /sign-in?transfer=done; Admin 403", async () => {
    const { c, api } = await team();
    await denied(
      c,
      api,
      () => act(c, "admin", "/team/transfer", "admin", { confirm_name: "Ada Admin" }),
      "needs the Owner role",
    );
    const r = await act(c, "owner", "/team/transfer", "admin", { confirm_name: "Ada Admin" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/sign-in?transfer=done");
  });

  test("row 22 for the other routes: the Owner as target is 403 with the Owner-target text", async () => {
    const { c, api } = await team();
    const text = "No one can change the owner account in the console.";
    await denied(
      c,
      api,
      () => act(c, "owner", "/team/remove", "owner", { confirm_name: "Owner" }, "viewer"),
      text,
    );
    await denied(
      c,
      api,
      () => act(c, "owner", "/team/role", "owner", { role: "admin" }, "viewer"),
      text,
    );
    await denied(c, api, () => act(c, "owner", "/team/reset-2fa", "owner", {}, "viewer"), text);
    await denied(
      c,
      api,
      () => act(c, "admin", "/team/remove", "owner", { confirm_name: "Owner" }, "viewer"),
      text,
    );
  });

  test("row 20: Admin reset link for a Member 200; Member 403", async () => {
    const { c, api } = await team();
    await denied(
      c,
      api,
      () => act(c, "member", "/team/reset-link", "viewer"),
      "needs the Admin role",
    );
    const r = await act(c, "admin", "/team/reset-link", "member");
    expect(r.status).toBe(200);
    expect(r.body).toContain("/reset/");
  });

  test("row 21: Owner reset link for an Admin 200; Admin 403", async () => {
    const { c, api } = await team();
    await denied(
      c,
      api,
      () => act(c, "admin", "/team/reset-link", "admin", {}, "member"),
      "needs the Owner role",
    );
    expect((await act(c, "owner", "/team/reset-link", "admin")).status).toBe(200);
  });

  test("row 22: Owner and Admin reset link for the Owner 403 with the Owner-target text", async () => {
    const { c, api } = await team();
    const text = "No one can change the owner account in the console.";
    for (const as of ["owner", "admin"] as const) {
      await denied(c, api, () => act(c, as, "/team/reset-link", "owner", {}, "member"), text);
    }
  });

  test("row 27: each role changes its own password 303; without a session 303 and no change", async () => {
    const { c } = await team();
    c.db.run(
      "UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE role = 'owner')",
    );
    const fresh = "a-fresh-password-for-row-27";
    for (const as of ROLES) {
      const page = await getPage(c, "/account/password", c.cookies[as]);
      const r = await postForm(
        c,
        "/account/password",
        {
          csrf: c.csrfs[as],
          form_token: formTokenOf(page.body, "/account/password"),
          password: OWNER_PASSWORD,
          new_password: fresh,
          new_password_confirm: fresh,
        },
        { cookie: c.cookies[as] },
      );
      expect([as, r.status, r.headers.get("location")]).toEqual([
        as,
        303,
        "/account/password?changed=1",
      ]);
    }
    const before = c.db.query("SELECT password_hash FROM users ORDER BY id").all();
    const anon = await postForm(
      c,
      "/account/password",
      { password: fresh, new_password: "x".repeat(20), new_password_confirm: "x".repeat(20) },
      { cookie: "" },
    );
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/sign-in?next=%2Faccount%2Fpassword");
    expect(c.db.query("SELECT password_hash FROM users ORDER BY id").all()).toEqual(before);
  });

  test("team.require-2fa: Owner 303; Admin 403", async () => {
    const { c, api } = await team();
    const before = snapshot(c);
    const page = await getPage(c, "/team", c.cookies.admin);
    const r = await postForm(
      c,
      "/team/require-2fa",
      { csrf: c.csrfs.admin, form_token: formTokenOf(page.body, "/team/invites"), value: "on" },
      { cookie: c.cookies.admin },
    );
    expect(r.status).toBe(403);
    expect(r.body).toContain("This page needs the Owner role or higher. Your role is Admin.");
    expect(snapshot(c)).toEqual(before);
    const own = await getPage(c, "/team", c.cookies.owner);
    const ok = await postForm(
      c,
      "/team/require-2fa",
      { csrf: c.csrfs.owner, form_token: formTokenOf(own.body, "/team/require-2fa"), value: "on" },
      { cookie: c.cookies.owner },
    );
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/team");
    expect(api.seen).toHaveLength(0);
  });
});
