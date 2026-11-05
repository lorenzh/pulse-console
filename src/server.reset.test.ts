import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { formTokenOf, getPage, postForm, type Reply, START } from "../test/signed-in-console.ts";
import { startTeamConsole, type TeamConsole } from "../test/team-console.ts";
import type { ConsoleRole } from "./roles.ts";

const LINK_NOT_VALID =
  "This link is not valid. It may have expired or been used. Ask an admin for a new one.";
const NEW_PASSWORD = "a-brand-new-password-77";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function team(): Promise<TeamConsole> {
  const c = await startTeamConsole({ apiUrl: "http://127.0.0.1:9" });
  cleanups.push(() => c.close());
  return c;
}

function count(db: Database, sql: string, ...args: (string | number)[]): number {
  return (
    db.query<{ n: number }, (string | number)[]>(`SELECT count(*) AS n FROM ${sql}`).get(...args)
      ?.n ?? -1
  );
}

function revisionOf(c: TeamConsole, id: number): string {
  const row = c.db
    .query<{ created_at: number; role: string }, [number]>(
      "SELECT created_at, role FROM users WHERE id = ?",
    )
    .get(id);
  return row === null ? "" : `${row.created_at}-${row.role}`;
}

/** Makes a reset link for `target` as `as`; the token is empty when none was shown. */
async function makeLink(
  c: TeamConsole,
  target: ConsoleRole,
  as: ConsoleRole = "admin",
): Promise<{ reply: Reply; token: string }> {
  const path = `/team/reset-link?user=${c.ids[target]}`;
  const page = await getPage(c, path, c.cookies[as]);
  const reply = await postForm(
    c,
    path,
    {
      csrf: c.csrfs[as],
      form_token: formTokenOf(page.body, path),
      revision: revisionOf(c, c.ids[target]),
    },
    { cookie: c.cookies[as] },
  );
  const token = /\/reset\/([A-Za-z0-9_-]{43})/.exec(reply.body)?.[1] ?? "";
  return { reply, token };
}

type Opened = { reply: Reply; csrf: string; formToken: string };

async function openLink(c: TeamConsole, token: string): Promise<Opened> {
  const reply = await getPage(c, `/reset/${token}`, "");
  const csrf = /pulse_console_csrf=([A-Za-z0-9_-]+)/.exec(
    reply.headers.get("set-cookie") ?? "",
  )?.[1];
  return { reply, csrf: csrf ?? "", formToken: formTokenOf(reply.body, `/reset/${token}`) };
}

function redeem(
  c: TeamConsole,
  token: string,
  opened: Opened,
  fields: Record<string, string> = {},
  cookie = `pulse_console_csrf=${opened.csrf}`,
): Promise<Reply> {
  return postForm(
    c,
    `/reset/${token}`,
    {
      csrf: opened.csrf,
      form_token: opened.formToken,
      password: NEW_PASSWORD,
      password_confirm: NEW_PASSWORD,
      ...fields,
    },
    { cookie },
  );
}

async function signIn(c: TeamConsole, email: string, password: string): Promise<Reply> {
  const page = await getPage(c, "/sign-in", "");
  const csrf = /pulse_console_csrf=([^;]*)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? "";
  return postForm(
    c,
    "/sign-in",
    { csrf, form_token: formTokenOf(page.body, "/sign-in"), email, password, next: "/" },
    { cookie: `pulse_console_csrf=${csrf}` },
  );
}

describe("making a reset link", () => {
  test("an Admin makes a Member link: confirmation, link page once, digest, event, no sign-out", async () => {
    const c = await team();
    const confirm = await getPage(c, `/team/reset-link?user=${c.ids.member}`, c.cookies.admin);
    expect(confirm.status).toBe(200);
    expect(confirm.body).toContain(
      "Make a password reset link for Mo Member? Using it signs Mo Member out everywhere.",
    );
    const { reply, token } = await makeLink(c, "member");
    expect(reply.status).toBe(200);
    expect(reply.body).toContain(`value="${c.base}/reset/${token}"`);
    expect(reply.body).toContain(
      "It works once and expires on 1970-01-02 02:30 UTC. Using it signs Mo Member out everywhere.",
    );
    const digest = createHash("sha256").update(token).digest("hex");
    expect(
      c.db.query("SELECT token_digest, kind, target_role, expires_at FROM reset_links").all(),
    ).toEqual([
      { token_digest: digest, kind: "team", target_role: "member", expires_at: START + 86400000 },
    ]);
    expect(count(c.db, "people_events WHERE action = 'user.reset-link'")).toBe(1);
    expect(count(c.db, "sessions WHERE user_id = ?", c.ids.member)).toBe(1);
    expect(c.logs.join("\n")).not.toContain(token);
  });

  test("the Owner target is 403 for everyone; an Admin target only for the Owner", async () => {
    const c = await team();
    const denied = [
      ["owner", "owner"],
      ["owner", "admin"],
      ["admin", "admin"],
      ["viewer", "member"],
    ] as const;
    for (const [target, as] of denied) {
      const page = await getPage(c, `/team/reset-link?user=${c.ids[target]}`, c.cookies[as]);
      expect(page.status).toBe(403);
    }
    expect((await makeLink(c, "admin", "owner")).reply.status).toBe(200);
    expect(count(c.db, "reset_links")).toBe(1);
  });

  test("a new link replaces the unused one", async () => {
    const c = await team();
    const first = await makeLink(c, "member");
    const second = await makeLink(c, "member");
    expect((await getPage(c, `/reset/${first.token}`, "")).status).toBe(404);
    expect((await getPage(c, `/reset/${second.token}`, "")).status).toBe(200);
    expect(count(c.db, "reset_links")).toBe(1);
  });
});

describe("using a reset link", () => {
  test("valid at +86399999 ms, 404 at +86400000 ms", async () => {
    const c = await team();
    const { token } = await makeLink(c, "member");
    c.setNow(START + 86399999);
    const open = await getPage(c, `/reset/${token}`, "");
    expect(open.status).toBe(200);
    expect(open.body).toContain("<p>Email: member@example.com</p>");
    c.setNow(START + 86400000);
    const late = await getPage(c, `/reset/${token}`, "");
    expect(late.status).toBe(404);
    expect(late.body).toContain(LINK_NOT_VALID);
    expect(late.headers.get("set-cookie")).toBeNull();
  });

  test("a reset sets the password, ends sessions, keeps factors and starts no session", async () => {
    const c = await team();
    const { token } = await makeLink(c, "admin", "owner");
    const opened = await openLink(c, token);
    const reply = await redeem(
      c,
      token,
      opened,
      {},
      `pulse_console_csrf=${opened.csrf}; ${c.cookies.member}`,
    );
    expect(reply.status).toBe(303);
    expect(reply.headers.get("location")).toBe("/sign-in?reset=done");
    expect(reply.headers.get("set-cookie")).toBeNull();
    expect(count(c.db, "sessions WHERE user_id = ?", c.ids.admin)).toBe(0);
    expect(count(c.db, "sessions WHERE user_id = ?", c.ids.member)).toBe(1);
    expect(count(c.db, "authenticators WHERE user_id = ?", c.ids.admin)).toBe(1);
    expect(
      c.db
        .query(
          "SELECT actor_user_id, target_id, value FROM people_events WHERE action = 'user.password-reset'",
        )
        .all(),
    ).toEqual([{ actor_user_id: c.ids.admin, target_id: c.ids.admin, value: "team" }]);
    const notice = await getPage(c, "/sign-in?reset=done", "");
    expect(notice.body).toContain("Your password is set. Sign in.");
    const signedIn = await signIn(c, "admin@example.com", NEW_PASSWORD);
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get("location")).toBe("/sign-in/factor");
    // The used link answers 404 again, before the form token, with no refusal log line.
    const again = await redeem(c, token, opened);
    expect(again.status).toBe(404);
    expect(c.logs.some((l) => l.includes("form token refused"))).toBe(false);
    expect(c.logs.join("\n")).not.toContain(token);
  });

  test("a field error is 422 and leaves the link valid", async () => {
    const c = await team();
    const { token } = await makeLink(c, "member");
    const opened = await openLink(c, token);
    const reply = await redeem(c, token, opened, { password_confirm: "different-password-1" });
    expect(reply.status).toBe(422);
    expect((await getPage(c, `/reset/${token}`, "")).status).toBe(200);
  });

  test("a missing CSRF cookie is 403 and changes nothing", async () => {
    const c = await team();
    const { token } = await makeLink(c, "member");
    const opened = await openLink(c, token);
    const reply = await redeem(c, token, opened, {}, "");
    expect(reply.status).toBe(403);
    expect(count(c.db, "reset_links WHERE used_at IS NULL")).toBe(1);
  });

  test("a role change or the issuer's removal invalidates the link", async () => {
    const c = await team();
    const roleChanged = await makeLink(c, "member");
    c.db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(c.ids.member);
    expect((await getPage(c, `/reset/${roleChanged.token}`, "")).status).toBe(404);
    const byIssuer = await makeLink(c, "viewer");
    c.db.query("DELETE FROM users WHERE id = ?").run(c.ids.admin);
    expect((await getPage(c, `/reset/${byIssuer.token}`, "")).status).toBe(404);
  });

  test("a field error does not use the form token", async () => {
    const c = await team();
    const { token } = await makeLink(c, "member");
    const opened = await openLink(c, token);
    expect((await redeem(c, token, opened, { password_confirm: "x" })).status).toBe(422);
    // The 422 did not use the token; a field error is checked before it.
    const used = await redeem(c, token, opened);
    expect(used.status).toBe(303);
  });
});
