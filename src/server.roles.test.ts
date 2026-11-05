import { afterEach, describe, expect, test } from "bun:test";
import { emptyConfig, type FakeApi, jsonReply, startFakeApi } from "../test/fake-api.ts";
import { getPage } from "../test/signed-in-console.ts";
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
