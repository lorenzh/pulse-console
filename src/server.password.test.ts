import { afterEach, describe, expect, test } from "bun:test";
import {
  formTokenOf,
  getPage,
  OWNER_PASSWORD,
  postForm,
  type Reply,
  SESSION_CSRF,
} from "../test/signed-in-console.ts";
import { startTeamConsole, type TeamConsole } from "../test/team-console.ts";

const NEW_PASSWORD = "a-brand-new-password-77";
const CHANGED = "Your password is changed. Other sessions are signed out.";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function team(): Promise<TeamConsole> {
  const c = await startTeamConsole({ apiUrl: "http://127.0.0.1:9" });
  cleanups.push(() => c.close());
  return c;
}

function count(c: TeamConsole, sql: string, ...args: (string | number)[]): number {
  return (
    c.db.query<{ n: number }, (string | number)[]>(`SELECT count(*) AS n FROM ${sql}`).get(...args)
      ?.n ?? -1
  );
}

function hashOf(c: TeamConsole, id: number): string {
  return (
    c.db.query<{ h: string }, [number]>("SELECT password_hash AS h FROM users WHERE id = ?").get(id)
      ?.h ?? ""
  );
}

async function change(c: TeamConsole, fields: Record<string, string>): Promise<Reply> {
  const page = await getPage(c, "/account/password");
  return postForm(
    c,
    "/account/password",
    {
      csrf: SESSION_CSRF,
      form_token: formTokenOf(page.body, "/account/password"),
      password: OWNER_PASSWORD,
      new_password: NEW_PASSWORD,
      new_password_confirm: NEW_PASSWORD,
      ...fields,
    },
    { cookie: c.cookie },
  );
}

describe("own password change", () => {
  test("the security page links to the password page, which holds the three fields", async () => {
    const c = await team();
    const security = await getPage(c, "/account/security");
    expect(security.body).toContain('<a href="/account/password">Change password</a>');
    const page = await getPage(c, "/account/password");
    expect(page.status).toBe(200);
    expect(page.body).not.toContain("<script");
    for (const name of ["password", "new_password", "new_password_confirm"]) {
      expect(page.body).toContain(`name="${name}"`);
    }
    expect(page.body).toMatch(/name="csrf"[^>]*>\s*<input type="hidden" name="form_token"/);
  });

  test("a change sets the hash, ends other sessions, keeps this one and writes one event", async () => {
    const c = await team();
    c.store.createSession("owner-second-session-id-0123456789abcdefghi", c.ids.owner, "x", 9e6);
    const before = hashOf(c, c.ids.owner);
    const reply = await change(c, {});
    expect(reply.status).toBe(303);
    expect(reply.headers.get("location")).toBe("/account/password?changed=1");
    expect(reply.headers.get("set-cookie")).toBeNull();
    expect(hashOf(c, c.ids.owner)).not.toBe(before);
    expect(await Bun.password.verify(NEW_PASSWORD, hashOf(c, c.ids.owner))).toBe(true);
    expect(count(c, "sessions WHERE user_id = ?", c.ids.owner)).toBe(1);
    expect(count(c, "sessions WHERE user_id = ?", c.ids.admin)).toBe(1);
    expect(
      count(
        c,
        "people_events WHERE action = 'user.password-change' AND target_id = ?",
        c.ids.owner,
      ),
    ).toBe(1);
    const notice = await getPage(c, "/account/password?changed=1");
    expect(notice.status).toBe(200);
    expect(notice.body).toContain(CHANGED);
    expect(c.logs.join("\n")).not.toContain(NEW_PASSWORD);
    expect(c.logs.join("\n")).not.toContain(OWNER_PASSWORD);
  });

  test("a pending reset link of the user stays valid after an own change", async () => {
    const c = await team();
    c.db
      .query(
        "INSERT INTO reset_links (token_digest, user_id, issued_by, kind, target_role, created_at, expires_at) VALUES ('d', ?, ?, 'team', 'owner', 0, 99999999999)",
      )
      .run(c.ids.owner, c.ids.owner);
    expect((await change(c, {})).status).toBe(303);
    expect(count(c, "reset_links WHERE used_at IS NULL")).toBe(1);
  });

  test.each([
    [{ new_password: "short", new_password_confirm: "short" }, "at least 12 characters"],
    [{ new_password: "x".repeat(129), new_password_confirm: "x".repeat(129) }, "at most 128"],
    [{ new_password_confirm: "another-password-99" }, "The passwords do not match."],
    [{ password: "" }, "Enter your password (at most 128 characters)."],
  ])("bad fields answer 422 and change nothing (%#)", async (fields, text) => {
    const c = await team();
    const before = hashOf(c, c.ids.owner);
    const reply = await change(c, fields);
    expect(reply.status).toBe(422);
    expect(reply.body).toContain(text);
    expect(hashOf(c, c.ids.owner)).toBe(before);
    expect(count(c, "people_events")).toBe(0);
  });

  test("a wrong current password is 401 five times, then 429", async () => {
    const c = await team();
    const before = hashOf(c, c.ids.owner);
    for (let i = 0; i < 5; i++) {
      const reply = await change(c, { password: "wrong-password-123" });
      expect(reply.status).toBe(401);
      expect(reply.body).toContain("Wrong password.");
    }
    expect((await change(c, {})).status).toBe(429);
    expect(hashOf(c, c.ids.owner)).toBe(before);
    expect(count(c, "people_events")).toBe(0);
    expect(c.metrics.render()).toContain('kind="password-confirm"');
  });

  test("a used form token answers 409 and changes nothing", async () => {
    const c = await team();
    const page = await getPage(c, "/account/password");
    const fields = {
      csrf: SESSION_CSRF,
      form_token: formTokenOf(page.body, "/account/password"),
      password: OWNER_PASSWORD,
      new_password: NEW_PASSWORD,
      new_password_confirm: NEW_PASSWORD,
    };
    expect((await postForm(c, "/account/password", fields, { cookie: c.cookie })).status).toBe(303);
    const again = await postForm(
      c,
      "/account/password",
      { ...fields, password: NEW_PASSWORD },
      { cookie: c.cookie },
    );
    expect(again.status).toBe(409);
    expect(count(c, "people_events WHERE action = 'user.password-change'")).toBe(1);
  });

  test("every role may change its own password", async () => {
    const c = await team();
    for (const role of ["admin", "member", "viewer"] as const) {
      const page = await getPage(c, "/account/password", c.cookies[role]);
      expect(page.status).toBe(200);
    }
  });

  test("without a session the page redirects to sign-in", async () => {
    const c = await team();
    const reply = await getPage(c, "/account/password", "");
    expect(reply.status).toBe(303);
    expect(reply.headers.get("location")).toBe("/sign-in?next=%2Faccount%2Fpassword");
  });
});
