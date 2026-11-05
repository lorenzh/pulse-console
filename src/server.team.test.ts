import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import {
  completeSignIn,
  formTokenOf,
  getPage,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  postForm,
  type Reply,
} from "../test/signed-in-console.ts";
import { sessionIdOf, startTeamConsole, type TeamConsole } from "../test/team-console.ts";
import { sessionDigest } from "./account-store.ts";

const START = 9_000_000;
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function team(isRequiredForAll = false): Promise<TeamConsole> {
  // No api request is expected; an unreachable url makes any request fail loudly.
  const c = await startTeamConsole({ apiUrl: "http://127.0.0.1:9", isRequiredForAll });
  cleanups.push(() => c.close());
  return c;
}

describe("GET /team", () => {
  test("the Owner sees every person, the 2FA state and the organisation switch state", async () => {
    const c = await team();
    const r = await getPage(c, "/team", c.cookies.owner);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBe(CSP);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body).toContain(
      '<a class="nav-item" href="/team" aria-current="page"><svg class="icon"',
    );
    expect(r.body).toContain("<h1");
    for (const row of [
      "<td>Owner</td>\n<td>owner@example.com</td>\n<td>Owner</td>\n<td>2FA: on</td>",
      "<td>Ada Admin</td>\n<td>admin@example.com</td>\n<td>Admin</td>\n<td>2FA: on</td>",
      "<td>Mo Member</td>\n<td>member@example.com</td>\n<td>Member</td>\n<td>2FA: off</td>",
      "<td>Vi Viewer</td>\n<td>viewer@example.com</td>\n<td>Viewer</td>\n<td>2FA: off</td>",
    ]) {
      expect(r.body).toContain(row);
    }
    expect(r.body).toContain("<p>No pending invites.</p>");
    expect(r.body).toContain('<h2 id="org-2fa-heading">Organisation 2FA</h2>');
    expect(r.body).toContain("<p>Two-factor sign-in for everyone: off.</p>");
    expect(r.body.match(/<script/g)).toHaveLength(1);
    expect(c.metrics.render()).toContain(
      'pulse_console_http_requests_total{path="/team",code="200"} 1',
    );
  });

  test("an Admin sees the People list but not the organisation switch", async () => {
    const c = await team();
    const r = await getPage(c, "/team", c.cookies.admin);
    expect(r.status).toBe(200);
    expect(r.body).toContain("<td>Mo Member</td>");
    expect(r.body).not.toContain("Organisation 2FA");
  });

  test("pending invites show state, expiry and a removed creator; used and revoked are hidden", async () => {
    const c = await startTeamConsole({
      apiUrl: "http://127.0.0.1:9",
      extra: (db, ids) => {
        const insert = db.query(
          "INSERT INTO invites (token_digest, email, role, created_by, created_at, expires_at, used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        );
        insert.run(
          "d1",
          "new@example.com",
          "member",
          ids.admin,
          START,
          1_700_000_000_000,
          null,
          null,
        );
        insert.run("d2", "late@example.com", "viewer", null, START, START + 500, null, null);
        insert.run(
          "d3",
          "used@example.com",
          "viewer",
          ids.owner,
          START,
          1_700_000_000_000,
          START,
          null,
        );
        insert.run(
          "d4",
          "gone@example.com",
          "viewer",
          ids.owner,
          START,
          1_700_000_000_000,
          null,
          START,
        );
        db.run("UPDATE users SET name = '<script>alert(1)</script>' WHERE role = 'viewer'");
      },
    });
    cleanups.push(() => c.close());
    c.setNow(START + 1000);
    const r = await getPage(c, "/team", c.cookies.admin);
    expect(r.status).toBe(200);
    expect(r.body).toContain(
      "<td>new@example.com</td>\n<td>Member</td>\n<td>Ada Admin</td>\n<td>2023-11-14 22:13 UTC</td>\n<td>pending</td>",
    );
    expect(r.body).toContain(
      "<td>late@example.com</td>\n<td>Viewer</td>\n<td>removed</td>\n<td>1970-01-01 02:30 UTC</td>\n<td>expired</td>",
    );
    expect(r.body).not.toContain("used@example.com");
    expect(r.body).not.toContain("gone@example.com");
    expect(r.body).not.toContain("<script>alert");
    expect(r.body).toContain("<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>");
  });
});

describe("two-factor requirement", () => {
  test("a Member or Viewer without TOTP is gated on the next request once the switch is on", async () => {
    const c = await team(true);
    for (const role of ["member", "viewer"] as const) {
      const r = await getPage(c, "/", c.cookies[role]);
      expect(r.status).toBe(303);
      expect(r.headers.get("location")).toBe("/account/authenticator");
    }
    expect((await getPage(c, "/account/authenticator", c.cookies.member)).status).toBe(200);
  });

  test("with the switch on, the Owner and an enrolled Admin keep their full sessions", async () => {
    const c = await team(true);
    expect((await getPage(c, "/team", c.cookies.owner)).status).toBe(200);
    expect((await getPage(c, "/team", c.cookies.admin)).status).toBe(200);
  });

  test("an Admin without TOTP is gated even with the switch off", async () => {
    const c = await startTeamConsole({
      apiUrl: "http://127.0.0.1:9",
      extra: (db, ids) => db.query("DELETE FROM authenticators WHERE user_id = ?").run(ids.admin),
    });
    cleanups.push(() => c.close());
    const r = await getPage(c, "/team", c.cookies.admin);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/account/authenticator");
    expect((await getPage(c, "/", c.cookies.member)).status).not.toBe(303);
  });
});

const SECOND_ADMIN_SESSION = "admin-second-session-0123456789abcdefghijkl".slice(0, 43);

/** A POST whose body is sent in two parts over a raw connection; the server waits for all of it. */
async function heldPost(
  c: TeamConsole,
  path: string,
  cookie: string,
  fields: Record<string, string>,
): Promise<{ finish: () => Promise<{ status: number; head: string; body: string }> }> {
  const body = new URLSearchParams(fields).toString();
  const url = new URL(c.base);
  const socket = connect(Number(url.port), "127.0.0.1");
  await once(socket, "connect");
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = once(socket, "end");
  const half = Math.floor(body.length / 2);
  socket.write(
    `POST ${path} HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${c.base}\r\nCookie: ${cookie}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body.slice(0, half)}`,
  );
  return {
    finish: async () => {
      socket.write(body.slice(half));
      await ended;
      const text = Buffer.concat(chunks).toString("utf8");
      const [head = "", rest = ""] = text.split("\r\n\r\n", 2);
      return { status: Number(head.split(" ")[1]), head, body: rest };
    },
  };
}

describe("team commits from a revoked session (acceptance 5b)", () => {
  async function withSecondAdminSession(): Promise<TeamConsole> {
    const c = await startTeamConsole({
      apiUrl: "http://127.0.0.1:9",
      extra: (db, ids) => {
        db.query(
          "INSERT INTO sessions (id_digest, user_id, csrf_token, created_at, last_seen_at, stage) VALUES (?, ?, 'admin-csrf-2', ?, ?, 'full')",
        ).run(sessionDigest(SECOND_ADMIN_SESSION), ids.admin, START, START);
      },
    });
    cleanups.push(() => c.close());
    return c;
  }

  async function heldInvite(c: TeamConsole) {
    const page = await getPage(c, "/team", c.cookies.admin);
    return heldPost(c, "/team/invites", c.cookies.admin, {
      csrf: c.csrfs.admin,
      form_token: formTokenOf(page.body, "/team/invites"),
      email: "new@example.com",
      role: "member",
    });
  }

  function rows(c: TeamConsole, table: string): number {
    return c.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1;
  }

  test("an invite admitted before sign out all from another session is 409 Not saved", async () => {
    const c = await withSecondAdminSession();
    const held = await heldInvite(c);
    const other = `pulse_console_session=${SECOND_ADMIN_SESSION}`;
    const confirm = await getPage(c, "/account/sessions/sign-out-all", other);
    const out = await postForm(
      c,
      "/account/sessions/sign-out-all",
      {
        csrf: "admin-csrf-2",
        form_token: formTokenOf(confirm.body, "/account/sessions/sign-out-all"),
      },
      { cookie: other },
    );
    expect(out.status).toBe(303);
    const r = await held.finish();
    expect(r.status).toBe(409);
    expect(r.body).toContain("<h2>Not saved</h2>");
    expect(r.body).toContain(
      "Your password or session changed while this was saved. Nothing was changed.",
    );
    expect(r.body).toContain('role="alert"');
    expect(r.body).toContain('<a href="/team">Reload</a>');
    expect(r.body).not.toContain("/invite/");
    expect(r.head.toLowerCase()).not.toContain("set-cookie");
    expect(rows(c, "invites")).toBe(0);
    expect(rows(c, "people_events")).toBe(0);
    expect(c.logs.some((l) => l.includes('"msg":"team change"'))).toBe(false);
    expect(c.logs.join("\n")).not.toContain(sessionIdOf("admin"));
    expect(r.body).not.toContain(sessionIdOf("admin"));
  });

  test("control: the same held invite with no change in between is 200 with the link", async () => {
    const c = await withSecondAdminSession();
    const held = await heldInvite(c);
    const r = await held.finish();
    expect(r.status).toBe(200);
    expect(r.body).toContain("/invite/");
    expect(rows(c, "invites")).toBe(1);
  });

  test("a cookie revoked before dispatch keeps the 303 sign-in gate", async () => {
    const c = await withSecondAdminSession();
    const page = await getPage(c, "/team", c.cookies.admin);
    c.db.query("DELETE FROM sessions WHERE id_digest = ?").run(sessionDigest(sessionIdOf("admin")));
    const r = await postForm(
      c,
      "/team/invites",
      {
        csrf: c.csrfs.admin,
        form_token: formTokenOf(page.body, "/team/invites"),
        email: "new@example.com",
        role: "member",
      },
      { cookie: c.cookies.admin },
    );
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/sign-in?next=%2Fteam%2Finvites");
    expect(rows(c, "invites")).toBe(0);
  });
});

// ---- Role change, removal, 2FA reset, transfer and the organisation switch (T3) ----

const SECOND_OWNER_SESSION = "owner-second-session-0123456789abcdefghijkl".slice(0, 43);
const SECOND_OWNER = `pulse_console_session=${SECOND_OWNER_SESSION}`;

async function actions(
  extra?: (db: TeamConsole["db"], ids: Readonly<TeamConsole["ids"]>) => void,
): Promise<TeamConsole> {
  const c = await startTeamConsole({
    apiUrl: "http://127.0.0.1:9",
    extra: (db, ids) => {
      db.query(
        "INSERT INTO sessions (id_digest, user_id, csrf_token, created_at, last_seen_at, stage) VALUES (?, ?, 'owner-csrf-2', ?, ?, 'full')",
      ).run(sessionDigest(SECOND_OWNER_SESSION), ids.owner, START, START);
      extra?.(db, ids);
    },
  });
  cleanups.push(() => c.close());
  return c;
}

function count(c: TeamConsole, sql: string, ...args: (string | number)[]): number {
  return (
    c.db.query<{ n: number }, (string | number)[]>(`SELECT count(*) AS n FROM ${sql}`).get(...args)
      ?.n ?? -1
  );
}

function revision(c: TeamConsole, id: number): string {
  const row = c.db
    .query<{ created_at: number; role: string }, [number]>(
      "SELECT created_at, role FROM users WHERE id = ?",
    )
    .get(id);
  return `${row?.created_at}-${row?.role}`;
}

function everyRow(c: TeamConsole): unknown[] {
  return [
    "users",
    "invites",
    "reset_links",
    "sessions",
    "authenticators",
    "recovery_codes",
    "people_events",
    "instance",
  ].map((t) => c.db.query(`SELECT * FROM ${t} ORDER BY rowid`).all());
}

/** The GET of `path` as `as`, then a POST with its csrf, form token and the target revision. */
async function submit(
  c: TeamConsole,
  as: keyof TeamConsole["ids"],
  path: string,
  userId: number,
  fields: Record<string, string>,
  cookie = c.cookies[as],
  tokenFrom = userId,
): Promise<Reply> {
  const action = `${path}?user=${userId}`;
  // The token binds to the path without the query, so a page of another target issues it too.
  const from = `${path}?user=${tokenFrom}`;
  const page = await getPage(c, from, cookie);
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? "";
  return postForm(
    c,
    action,
    { csrf, form_token: formTokenOf(page.body, from), revision: revision(c, userId), ...fields },
    { cookie },
  );
}

function sessionCookieOf(r: Reply): string {
  const value = /pulse_console_session=([^;]*)/.exec(r.headers.get("set-cookie") ?? "")?.[1] ?? "";
  return `pulse_console_session=${value}`;
}

/** A password sign-in; the answer of the password step. */
async function passwordSignIn(c: TeamConsole, email: string, next = "/"): Promise<Reply> {
  const page = await getPage(c, "/sign-in", "");
  const csrf = /pulse_console_csrf=([^;]*)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? "";
  return postForm(
    c,
    "/sign-in",
    { csrf, form_token: formTokenOf(page.body, "/sign-in"), email, password: OWNER_PASSWORD, next },
    { cookie: `pulse_console_csrf=${csrf}` },
  );
}

/** Gives a seeded person the fixture Owner's password, so a test can sign them in. */
function knownPassword(c: TeamConsole, id: number): void {
  c.db
    .query(
      "UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE role = 'owner') WHERE id = ?",
    )
    .run(id);
}

function events(c: TeamConsole): {
  action: string;
  from_role: string | null;
  to_role: string | null;
  value: string | null;
  target_email: string | null;
  target_name: string | null;
}[] {
  return c.db
    .query<
      {
        action: string;
        from_role: string | null;
        to_role: string | null;
        value: string | null;
        target_email: string | null;
        target_name: string | null;
      },
      []
    >(
      "SELECT action, from_role, to_role, value, target_email, target_name FROM people_events ORDER BY id",
    )
    .all();
}

describe("Team page action links", () => {
  test("the Owner gets links on every other person, an Admin none on Admin rows", async () => {
    const c = await actions();
    const owner = await getPage(c, "/team", c.cookies.owner);
    for (const path of ["/team/role", "/team/reset-2fa", "/team/remove"]) {
      expect(owner.body).toContain(`<a href="${path}?user=${c.ids.admin}">`);
      expect(owner.body).toContain(`<a href="${path}?user=${c.ids.member}">`);
      expect(owner.body).not.toContain(`<a href="${path}?user=${c.ids.owner}">`);
    }
    expect(owner.body).toContain(`<a href="/team/transfer?user=${c.ids.admin}">Make owner`);
    expect(owner.body).not.toContain(`<a href="/team/transfer?user=${c.ids.member}">`);
    const admin = await getPage(c, "/team", c.cookies.admin);
    expect(admin.body).toContain(`<a href="/team/remove?user=${c.ids.viewer}">Remove`);
    expect(admin.body).toContain(`<a href="/team/reset-2fa?user=${c.ids.viewer}">Reset 2FA`);
    expect(admin.body).not.toContain(`/team/role?user=`);
    expect(admin.body).not.toContain(`?user=${c.ids.admin}"`);
    expect(admin.body).not.toContain(`?user=${c.ids.owner}"`);
    expect(admin.body).not.toContain("/team/transfer");
  });

  test("a team of 60 holds 2 action forms plus sign-out, and both tokens still submit", async () => {
    const c = await actions((db) => {
      const insert = db.query(
        "INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, 'h', 'member', ?)",
      );
      for (let i = 0; i < 56; i += 1) insert.run(`p${i}@example.com`, `Person ${i}`, START);
    });
    expect(count(c, "users")).toBe(60);
    const page = await getPage(c, "/team", c.cookies.owner);
    const actionsOf = [...page.body.matchAll(/<form method="post" action="([^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(actionsOf).toEqual(["/sign-out", "/team/invites", "/team/require-2fa"]);
    expect(page.body.match(/<form/g)).toHaveLength(3);
    const csrf = c.csrfs.owner;
    const invite = await postForm(
      c,
      "/team/invites",
      {
        csrf,
        form_token: formTokenOf(page.body, "/team/invites"),
        email: "new@example.com",
        role: "member",
      },
      { cookie: c.cookies.owner },
    );
    expect(invite.status).toBe(200);
    const flip = await postForm(
      c,
      "/team/require-2fa",
      { csrf, form_token: formTokenOf(page.body, "/team/require-2fa"), value: "on" },
      { cookie: c.cookies.owner },
    );
    expect(flip.status).toBe(303);
  });
});

describe("role change", () => {
  test("a promoted Member loses every session; sign-in leads to enrolment before Team", async () => {
    const c = await actions();
    knownPassword(c, c.ids.member);
    const r = await submit(c, "owner", "/team/role", c.ids.member, { role: "admin" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/team");
    expect(count(c, "sessions WHERE user_id = ?", c.ids.member)).toBe(0);
    const old = await getPage(c, "/team", c.cookies.member);
    expect(old.status).toBe(303);
    expect(old.headers.get("location")).toBe("/sign-in?next=%2Fteam");
    const signIn = await passwordSignIn(c, "member@example.com", "/team");
    expect(signIn.status).toBe(303);
    expect(signIn.headers.get("location")).toBe("/account/authenticator");
    const gated = await getPage(c, "/team", sessionCookieOf(signIn));
    expect(gated.status).toBe(303);
    expect(gated.headers.get("location")).toBe("/account/authenticator");
    expect(events(c)).toEqual([
      {
        action: "user.role-change",
        from_role: "member",
        to_role: "admin",
        value: null,
        target_email: "member@example.com",
        target_name: "Mo Member",
      },
    ]);
    expect(
      c.logs.some((l) => l.includes('"msg":"team change"') && l.includes("user.role-change")),
    ).toBe(true);
  });

  test("refused role changes answer 422, 409, 404 or 400 and change nothing", async () => {
    const c = await actions();
    const before = everyRow(c);
    const cases: [Record<string, string>, number, string][] = [
      [{ role: "owner" }, 422, "Choose admin, member or viewer."],
      [{ role: "Admin" }, 422, "Choose admin, member or viewer."],
      [{ role: "member" }, 422, "Choose a different role."],
      [{ role: "viewer", revision: "1-member" }, 409, "Changed since you opened it"],
    ];
    for (const [fields, status, text] of cases) {
      const r = await submit(c, "owner", "/team/role", c.ids.member, fields);
      expect([fields, r.status]).toEqual([fields, status]);
      expect(r.body).toContain(text);
    }
    for (const id of ["01", "1e3", "-1", "", "12345678901234567", "999"]) {
      expect([id, (await getPage(c, `/team/role?user=${id}`, c.cookies.owner)).status]).toEqual([
        id,
        404,
      ]);
    }
    const roleAction = `/team/role?user=${c.ids.member}`;
    const page = await getPage(c, roleAction, c.cookies.owner);
    const token = formTokenOf(page.body, roleAction);
    const body = `csrf=${c.csrfs.owner}&form_token=${token}&role=member&role=admin&revision=${revision(c, c.ids.member)}`;
    const repeated = await fetch(`${c.base}/team/role?user=${c.ids.member}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: c.cookies.owner,
        origin: c.base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    expect(repeated.status).toBe(400);
    const owner = await submit(
      c,
      "owner",
      "/team/role",
      c.ids.owner,
      { role: "admin" },
      c.cookies.owner,
      c.ids.member,
    );
    expect(owner.status).toBe(403);
    expect(owner.body).toContain("No one can change the owner account in the console.");
    expect(everyRow(c)).toEqual(before);
  });

  test("a stale page after another tab promoted the person is 409 and the role stays admin", async () => {
    const c = await actions();
    const action = `/team/role?user=${c.ids.member}`;
    const page = await getPage(c, action, c.cookies.owner);
    const old = revision(c, c.ids.member);
    expect(
      (await submit(c, "owner", "/team/role", c.ids.member, { role: "admin" }, SECOND_OWNER))
        .status,
    ).toBe(303);
    const r = await postForm(
      c,
      action,
      {
        csrf: c.csrfs.owner,
        form_token: formTokenOf(page.body, action),
        role: "viewer",
        revision: old,
      },
      { cookie: c.cookies.owner },
    );
    expect(r.status).toBe(409);
    expect(
      c.db
        .query<{ role: string }, [number]>("SELECT role FROM users WHERE id = ?")
        .get(c.ids.member)?.role,
    ).toBe("admin");
  });
});

describe("removal", () => {
  const TOKEN = "B".repeat(43);

  test("the page warns that API tokens survive; an empty name is 422", async () => {
    const c = await actions();
    const page = await getPage(c, `/team/remove?user=${c.ids.viewer}`, c.cookies.admin);
    expect(page.status).toBe(200);
    expect(page.body).toContain(
      "Vi Viewer loses access to the console now. Their invites stop working. API tokens are not tied to people: tokens that Vi Viewer created or copied stay valid until someone revokes them in pulse-api.",
    );
    expect(page.body).toMatch(/name="csrf" value="[^"]+">\n<input type="hidden" name="form_token"/);
    expect(page.body.match(/<script/g)).toHaveLength(1);
    const r = await submit(c, "admin", "/team/remove", c.ids.viewer, { confirm_name: "" });
    expect(r.status).toBe(422);
    expect(r.body).toContain("Type the name to confirm.");
    expect(count(c, "users WHERE id = ?", c.ids.viewer)).toBe(1);
  });

  test("removal ends sessions, deletes reset links, keeps history and stops the person's invites", async () => {
    const c = await actions((db, ids) => {
      db.query(
        "INSERT INTO reset_links (token_digest, kind, user_id, target_role, issued_by, created_at, expires_at) VALUES ('r1', 'team', ?, 'admin', ?, ?, ?)",
      ).run(ids.admin, ids.owner, START, START + 86_400_000);
      db.query(
        "INSERT INTO invites (token_digest, email, role, created_by, created_at, expires_at) VALUES (?, 'new@example.com', 'viewer', ?, ?, ?)",
      ).run(
        createHash("sha256").update(TOKEN).digest("hex"),
        ids.admin,
        START,
        START + 604_800_000,
      );
    });
    expect((await getPage(c, `/invite/${TOKEN}`, "")).status).toBe(200);
    const r = await submit(c, "owner", "/team/remove", c.ids.admin, {
      confirm_name: " Ada Admin ",
    });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/team");
    expect(count(c, "users WHERE id = ?", c.ids.admin)).toBe(0);
    expect(count(c, "sessions WHERE user_id = ?", c.ids.admin)).toBe(0);
    expect(count(c, "reset_links")).toBe(0);
    expect(count(c, "authenticators WHERE user_id = ?", c.ids.admin)).toBe(0);
    const old = await getPage(c, "/team", c.cookies.admin);
    expect(old.status).toBe(303);
    expect(old.headers.get("location")).toBe("/sign-in?next=%2Fteam");
    expect(events(c)).toEqual([
      {
        action: "user.remove",
        from_role: "admin",
        to_role: null,
        value: null,
        target_email: "admin@example.com",
        target_name: "Ada Admin",
      },
    ]);
    expect((await getPage(c, `/invite/${TOKEN}`, "")).status).toBe(404);
    expect((await getPage(c, `/team/remove?user=${c.ids.admin}`, c.cookies.owner)).status).toBe(
      404,
    );
  });

  test("a stale removal form after the id was reused is 409 and the new user stays", async () => {
    const c = await actions();
    const action = `/team/remove?user=${c.ids.viewer}`;
    const page = await getPage(c, action, c.cookies.admin);
    const old = revision(c, c.ids.viewer);
    c.db.query("UPDATE users SET created_at = ? WHERE id = ?").run(START + 5, c.ids.viewer);
    const r = await postForm(
      c,
      action,
      {
        csrf: c.csrfs.admin,
        form_token: formTokenOf(page.body, action),
        confirm_name: "Vi Viewer",
        revision: old,
      },
      { cookie: c.cookies.admin },
    );
    expect(r.status).toBe(409);
    expect(count(c, "users WHERE id = ?", c.ids.viewer)).toBe(1);
    expect(events(c)).toEqual([]);
  });
});

describe("2FA reset", () => {
  test("a Member's reset deletes factors and sessions; the next sign-in has no factor step", async () => {
    const c = await actions((db, ids) => {
      db.query(
        "INSERT INTO authenticators (user_id, secret, last_step, confirmed_at) VALUES (?, 's', -1, ?)",
      ).run(ids.member, START);
      db.query("INSERT INTO recovery_codes (user_id, digest) VALUES (?, ?)").run(
        ids.member,
        "a".repeat(64),
      );
    });
    knownPassword(c, c.ids.member);
    const page = await getPage(c, `/team/reset-2fa?user=${c.ids.member}`, c.cookies.admin);
    expect(page.body).toContain(
      "Reset two-factor sign-in for Mo Member? Their authenticator and recovery codes stop working and they are signed out. They set up two-factor sign-in again if their role needs it.",
    );
    const r = await submit(c, "admin", "/team/reset-2fa", c.ids.member, {});
    expect(r.status).toBe(303);
    for (const table of [
      "authenticators",
      "recovery_codes",
      "sessions",
      "pending_authenticators",
    ]) {
      expect([table, count(c, `${table} WHERE user_id = ?`, c.ids.member)]).toEqual([table, 0]);
    }
    const old = await getPage(c, "/", c.cookies.member);
    expect(old.status).toBe(303);
    expect(old.headers.get("location")).toBe("/sign-in?next=%2F");
    const signIn = await passwordSignIn(c, "member@example.com");
    expect(signIn.status).toBe(303);
    expect(signIn.headers.get("location")).toBe("/");
    expect(events(c).map((e) => e.action)).toEqual(["user.2fa-reset"]);
  });

  test("an Admin's reset by the Owner sends the next password sign-in to enrolment", async () => {
    const c = await actions();
    knownPassword(c, c.ids.admin);
    expect((await submit(c, "owner", "/team/reset-2fa", c.ids.admin, {})).status).toBe(303);
    const signIn = await passwordSignIn(c, "admin@example.com");
    expect(signIn.headers.get("location")).toBe("/account/authenticator");
  });
});

describe("ownership transfer", () => {
  test("a wrong name, a Member and an Admin without an authenticator are 422, 403 and 409", async () => {
    const c = await actions();
    const before = everyRow(c);
    const wrong = await submit(c, "owner", "/team/transfer", c.ids.admin, {
      confirm_name: "ada admin",
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body).toContain("The name does not match. Type Ada Admin exactly.");
    const member = await submit(
      c,
      "owner",
      "/team/transfer",
      c.ids.member,
      { confirm_name: "Mo Member" },
      c.cookies.owner,
      c.ids.admin,
    );
    expect(member.status).toBe(403);
    expect(member.body).toContain("Only an admin can become the owner.");
    expect(everyRow(c)).toEqual(before);
    c.db.query("DELETE FROM authenticators WHERE user_id = ?").run(c.ids.admin);
    const after = everyRow(c);
    const bare = await submit(c, "owner", "/team/transfer", c.ids.admin, {
      confirm_name: "Ada Admin",
    });
    expect(bare.status).toBe(409);
    expect(bare.body).toContain("Ada Admin has not set up two-factor sign-in yet.");
    expect(everyRow(c)).toEqual(after);
  });

  test("a transfer leaves one Owner, ends both people's sessions and clears the cookie", async () => {
    const c = await actions();
    const page = await getPage(c, `/team/transfer?user=${c.ids.admin}`, c.cookies.owner);
    expect(page.body).toContain(
      "Make Ada Admin the owner? You become an admin. Both of you are signed out and sign in again.",
    );
    const r = await submit(c, "owner", "/team/transfer", c.ids.admin, {
      confirm_name: "Ada Admin",
    });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/sign-in?transfer=done");
    expect(r.headers.get("set-cookie")).toContain("pulse_console_session=;");
    expect(count(c, "users WHERE role = 'owner'")).toBe(1);
    expect(
      c.db.query<{ role: string }, [number]>("SELECT role FROM users WHERE id = ?").get(c.ids.owner)
        ?.role,
    ).toBe("admin");
    expect(
      c.db.query<{ role: string }, [number]>("SELECT role FROM users WHERE id = ?").get(c.ids.admin)
        ?.role,
    ).toBe("owner");
    expect(count(c, "sessions WHERE user_id IN (?, ?)", c.ids.owner, c.ids.admin)).toBe(0);
    const old = await getPage(c, "/team", c.cookies.owner);
    expect(old.status).toBe(303);
    expect(old.headers.get("location")).toBe("/sign-in?next=%2Fteam");
    const notice = await getPage(c, "/sign-in?transfer=done", "");
    expect(notice.body).toContain("Ownership is transferred. Sign in again.");
    expect(events(c)).toEqual([
      {
        action: "owner.transfer",
        from_role: "admin",
        to_role: "owner",
        value: null,
        target_email: "admin@example.com",
        target_name: "Ada Admin",
      },
    ]);
    const full = await completeSignIn(c, await passwordSignIn(c, OWNER_EMAIL, "/team"));
    expect(full.status).toBe(303);
    const cookie = sessionCookieOf(full);
    const team = await getPage(c, "/team", cookie);
    expect(team.status).toBe(200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(team.body)?.[1] ?? "";
    const flip = await postForm(
      c,
      "/team/require-2fa",
      { csrf, form_token: formTokenOf(team.body, "/team/invites"), value: "on" },
      { cookie },
    );
    expect(flip.status).toBe(403);
  });

  test("two concurrent transfers leave exactly one Owner; the second commit is 409 Not saved", async () => {
    const c = await actions((db) => {
      const row = db
        .query<{ id: number }, [number]>(
          "INSERT INTO users (email, name, password_hash, role, created_at) VALUES ('b@example.com', 'Bea Admin', 'h', 'admin', ?) RETURNING id",
        )
        .get(START);
      db.query(
        "INSERT INTO authenticators (user_id, secret, last_step, confirmed_at) VALUES (?, 's', -1, ?)",
      ).run(row?.id ?? 0, START);
    });
    const bea =
      c.db.query<{ id: number }, []>("SELECT id FROM users WHERE email = 'b@example.com'").get()
        ?.id ?? 0;
    const holds = [];
    for (const [id, name] of [
      [c.ids.admin, "Ada Admin"],
      [bea, "Bea Admin"],
    ] as const) {
      const action = `/team/transfer?user=${id}`;
      const page = await getPage(c, action, c.cookies.owner);
      holds.push(
        await heldPost(c, action, c.cookies.owner, {
          csrf: c.csrfs.owner,
          form_token: formTokenOf(page.body, action),
          revision: revision(c, id),
          confirm_name: name,
        }),
      );
    }
    const [first, second] = holds;
    const a = await first?.finish();
    const b = await second?.finish();
    expect(a?.status).toBe(303);
    expect(b?.status).toBe(409);
    expect(b?.body).toContain(
      "Your password or session changed while this was saved. Nothing was changed.",
    );
    expect(count(c, "users WHERE role = 'owner'")).toBe(1);
    expect(events(c).map((e) => e.action)).toEqual(["owner.transfer"]);
  });
});

describe("organisation 2FA switch", () => {
  async function flip(c: TeamConsole, value: string): Promise<Reply> {
    const page = await getPage(c, "/team", c.cookies.owner);
    return postForm(
      c,
      "/team/require-2fa",
      { csrf: c.csrfs.owner, form_token: formTokenOf(page.body, "/team/require-2fa"), value },
      { cookie: c.cookies.owner },
    );
  }

  test("on gates a factorless Viewer's live cookie, off lets it through; no session ends", async () => {
    const c = await actions();
    const sessions = count(c, "sessions");
    const page = await getPage(c, "/team", c.cookies.owner);
    expect(page.body).toMatch(
      /action="\/team\/require-2fa">\n<input type="hidden" name="csrf" value="[^"]+">\n<input type="hidden" name="form_token"/,
    );
    expect(page.body).toContain('<input type="hidden" name="value" value="on">');
    expect((await flip(c, "on")).status).toBe(303);
    const gated = await getPage(c, "/", c.cookies.viewer);
    expect(gated.status).toBe(303);
    expect(gated.headers.get("location")).toBe("/account/authenticator");
    expect((await getPage(c, "/team", c.cookies.owner)).body).toContain(
      "Two-factor sign-in for everyone: on.",
    );
    expect((await flip(c, "off")).status).toBe(303);
    expect((await getPage(c, "/", c.cookies.viewer)).status).toBe(200);
    expect(count(c, "sessions")).toBe(sessions);
    expect(events(c).map((e) => [e.action, e.value])).toEqual([
      ["team.require-2fa", "on"],
      ["team.require-2fa", "off"],
    ]);
  });

  test("a value other than on or off is 422 and changes nothing", async () => {
    const c = await actions();
    const before = everyRow(c);
    const r = await flip(c, "yes");
    expect(r.status).toBe(422);
    expect(r.body).toContain("Choose on or off.");
    expect(everyRow(c)).toEqual(before);
  });
});

describe("a failed People-log insert rolls the change back", () => {
  test.each([
    ["invite", "/team/invites"],
    ["role change", "/team/role"],
    ["removal", "/team/remove"],
  ] as const)("%s answers 500 and every other table is unchanged", async (_name, path) => {
    const c = await actions();
    c.db.run(
      "CREATE TRIGGER test_fail BEFORE INSERT ON people_events BEGIN SELECT RAISE(ABORT, 'no'); END",
    );
    const before = everyRow(c);
    let r: Reply;
    if (path === "/team/invites") {
      const page = await getPage(c, "/team", c.cookies.owner);
      r = await postForm(
        c,
        path,
        {
          csrf: c.csrfs.owner,
          form_token: formTokenOf(page.body, path),
          email: "new@example.com",
          role: "member",
        },
        { cookie: c.cookies.owner },
      );
    } else {
      const fields = path === "/team/role" ? { role: "viewer" } : { confirm_name: "Mo Member" };
      r = await submit(c, "owner", path, c.ids.member, fields);
    }
    expect(r.status).toBe(500);
    expect(r.body).toContain("The change could not be saved.");
    expect(everyRow(c)).toEqual(before);
    expect(c.logs.some((l) => l.includes("team change could not be saved"))).toBe(true);
  });
});

describe("team mutations from a revoked session (section 3)", () => {
  type Case = {
    name: string;
    as: "owner" | "admin";
    path: string;
    target: (c: TeamConsole) => number | undefined;
    fields: Record<string, string>;
  };
  const LOG_ACTIONS: Record<string, string> = {
    "/team/role": "user.role-change",
    "/team/remove": "user.remove",
    "/team/reset-2fa": "user.2fa-reset",
    "/team/transfer": "owner.transfer",
    "/team/require-2fa": "team.require-2fa",
  };
  const CASES: Case[] = [
    {
      name: "role change",
      as: "owner",
      path: "/team/role",
      target: (c) => c.ids.member,
      fields: { role: "viewer" },
    },
    {
      name: "removal",
      as: "admin",
      path: "/team/remove",
      target: (c) => c.ids.viewer,
      fields: { confirm_name: "Vi Viewer" },
    },
    {
      name: "2FA reset",
      as: "admin",
      path: "/team/reset-2fa",
      target: (c) => c.ids.viewer,
      fields: {},
    },
    {
      name: "transfer",
      as: "owner",
      path: "/team/transfer",
      target: (c) => c.ids.admin,
      fields: { confirm_name: "Ada Admin" },
    },
    {
      name: "switch",
      as: "owner",
      path: "/team/require-2fa",
      target: () => undefined,
      fields: { value: "on" },
    },
  ];

  async function open(
    c: TeamConsole,
    k: Case,
  ): Promise<{ action: string; fields: Record<string, string> }> {
    const id = k.target(c);
    const action = id === undefined ? k.path : `${k.path}?user=${id}`;
    const page = await getPage(c, id === undefined ? "/team" : action, c.cookies[k.as]);
    const fields: Record<string, string> = {
      csrf: c.csrfs[k.as],
      form_token: formTokenOf(page.body, action),
      ...k.fields,
    };
    if (id !== undefined) fields.revision = revision(c, id);
    return { action, fields };
  }

  /** Ends the actor's held session through normal requests of another session. */
  async function endActorSession(c: TeamConsole, k: Case): Promise<void> {
    if (k.as === "owner") {
      const confirm = await getPage(c, "/account/sessions/sign-out-all", SECOND_OWNER);
      const out = await postForm(
        c,
        "/account/sessions/sign-out-all",
        {
          csrf: "owner-csrf-2",
          form_token: formTokenOf(confirm.body, "/account/sessions/sign-out-all"),
        },
        { cookie: SECOND_OWNER },
      );
      expect(out.status).toBe(303);
      return;
    }
    // The Owner demotes the Admin, which deletes every session of the Admin.
    expect(
      (await submit(c, "owner", "/team/role", c.ids.admin, { role: "member" }, SECOND_OWNER))
        .status,
    ).toBe(303);
  }

  test.each(CASES)(
    "$name admitted before its session was deleted is 409 Not saved with 0 changes",
    async (k) => {
      const c = await actions();
      const { action, fields } = await open(c, k);
      const held = await heldPost(c, action, c.cookies[k.as], fields);
      await endActorSession(c, k);
      const eventsBefore = events(c).length;
      const users = c.db.query("SELECT id, role FROM users ORDER BY id").all();
      const factors = count(c, "authenticators");
      const r = await held.finish();
      expect(r.status).toBe(409);
      expect(r.body).toContain(
        "Your password or session changed while this was saved. Nothing was changed.",
      );
      expect(r.head.toLowerCase()).not.toContain("set-cookie");
      expect(events(c)).toHaveLength(eventsBefore);
      expect(c.db.query("SELECT id, role FROM users ORDER BY id").all()).toEqual(users);
      expect(count(c, "authenticators")).toBe(factors);
      expect(
        c.db.query<{ v: number }, []>("SELECT require_2fa_all AS v FROM instance").get()?.v,
      ).toBe(0);
      const logAction = LOG_ACTIONS[k.path];
      expect(
        c.logs.some((l) => l.includes('"msg":"team change"') && l.includes(`"${logAction}"`)),
      ).toBe(false);
    },
  );

  test.each(CASES)(
    "$name with its session deleted before admission is 303 to sign-in",
    async (k) => {
      const c = await actions();
      const { action, fields } = await open(c, k);
      const sessionId = k.as === "owner" ? undefined : sessionIdOf(k.as);
      if (sessionId === undefined)
        c.db
          .query("DELETE FROM sessions WHERE user_id = ? AND id_digest != ?")
          .run(c.ids.owner, sessionDigest(SECOND_OWNER_SESSION));
      else c.db.query("DELETE FROM sessions WHERE id_digest = ?").run(sessionDigest(sessionId));
      const before = everyRow(c);
      const r = await postForm(c, action, fields, { cookie: c.cookies[k.as] });
      expect(r.status).toBe(303);
      expect(r.headers.get("location")).toStartWith("/sign-in?next=");
      expect(everyRow(c)).toEqual(before);
    },
  );
});

describe("a deleted session answers 409 before any target-rule 403", () => {
  type Held = { name: string; open: (c: TeamConsole) => Promise<HeldRequest[]> };
  type HeldRequest = Awaited<ReturnType<typeof heldPost>>;

  async function heldTransfer(c: TeamConsole): Promise<HeldRequest> {
    const action = `/team/transfer?user=${c.ids.admin}`;
    const page = await getPage(c, action, c.cookies.owner);
    return heldPost(c, action, c.cookies.owner, {
      csrf: c.csrfs.owner,
      form_token: formTokenOf(page.body, action),
      revision: revision(c, c.ids.admin),
      confirm_name: "Ada Admin",
    });
  }

  const CASES: Held[] = [
    {
      name: "a second transfer to the same Admin after the first ended both sessions",
      open: async (c) => [await heldTransfer(c), await heldTransfer(c)],
    },
    {
      name: "an Admin inviting an Admin after the Owner demoted it",
      open: async (c) => {
        const page = await getPage(c, "/team", c.cookies.admin);
        const held = await heldPost(c, "/team/invites", c.cookies.admin, {
          csrf: c.csrfs.admin,
          form_token: formTokenOf(page.body, "/team/invites"),
          email: "new@example.com",
          role: "admin",
        });
        const demoted = await submit(c, "owner", "/team/role", c.ids.admin, { role: "member" });
        expect(demoted.status).toBe(303);
        return [held];
      },
    },
  ];

  test.each(CASES)("$name is 409 Not saved", async (k) => {
    const c = await actions();
    const held = await k.open(c);
    const last = held.pop();
    for (const first of held) expect((await first.finish()).status).toBe(303);
    const before = everyRow(c);
    const r = await last?.finish();
    expect(r?.status).toBe(409);
    expect(r?.body).toContain(
      "Your password or session changed while this was saved. Nothing was changed.",
    );
    expect(everyRow(c)).toEqual(before);
    expect(count(c, "users WHERE role = 'owner'")).toBe(1);
  });
});

describe("the field format comes before the target lookup", () => {
  test.each(["owner", "boss", ""])("role=%p for an unknown user is 422", async (role) => {
    const c = await actions();
    const before = everyRow(c);
    const r = await submit(c, "owner", "/team/role", 999, { role }, c.cookies.owner, c.ids.member);
    expect(r.status).toBe(422);
    expect(r.body).toContain("Choose admin, member or viewer.");
    expect(everyRow(c)).toEqual(before);
  });
});

describe("acceptance 5b: the four held team commits and the control", () => {
  const NOT_SAVED = "Your password or session changed while this was saved. Nothing was changed.";

  /** The Owner makes a reset link for `id` and it is used. */
  async function resetPasswordOf(c: TeamConsole, id: number): Promise<void> {
    const made = await submit(c, "owner", "/team/reset-link", id, {}, SECOND_OWNER);
    expect(made.status).toBe(200);
    const token = /\/reset\/([A-Za-z0-9_-]{43})/.exec(made.body)?.[1] ?? "";
    const page = await getPage(c, `/reset/${token}`, "");
    const csrf =
      /pulse_console_csrf=([A-Za-z0-9_-]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? "";
    const password = "a-reset-password-for-5b";
    const used = await postForm(
      c,
      `/reset/${token}`,
      {
        csrf,
        form_token: formTokenOf(page.body, `/reset/${token}`),
        password,
        password_confirm: password,
      },
      { cookie: `pulse_console_csrf=${csrf}` },
    );
    expect(used.status).toBe(303);
  }

  async function heldMemberPost(
    c: TeamConsole,
    as: "admin" | "owner",
    path: string,
    id: number,
    fields: Record<string, string>,
  ): ReturnType<typeof heldPost> {
    const action = `${path}?user=${id}`;
    const page = await getPage(c, action, c.cookies[as]);
    return heldPost(c, action, c.cookies[as], {
      csrf: c.csrfs[as],
      form_token: formTokenOf(page.body, action),
      revision: revision(c, id),
      ...fields,
    });
  }

  /** No team change log line of the refused action. */
  function noTeamChangeLog(c: TeamConsole, action: string): void {
    expect(c.logs.some((l) => l.includes('"msg":"team change"') && l.includes(`"${action}"`))).toBe(
      false,
    );
  }

  test("an Admin invite held during the Admin's 2FA reset is 409 with 0 invites", async () => {
    const c = await actions();
    const page = await getPage(c, "/team", c.cookies.admin);
    const held = await heldPost(c, "/team/invites", c.cookies.admin, {
      csrf: c.csrfs.admin,
      form_token: formTokenOf(page.body, "/team/invites"),
      email: "new@example.com",
      role: "member",
    });
    expect(
      (await submit(c, "owner", "/team/reset-2fa", c.ids.admin, {}, SECOND_OWNER)).status,
    ).toBe(303);
    const r = await held.finish();
    expect(r.status).toBe(409);
    expect(r.body).toContain(NOT_SAVED);
    expect(r.body).not.toContain("/invite/");
    expect(count(c, "invites")).toBe(0);
    expect(events(c).map((e) => e.action)).toEqual(["user.2fa-reset"]);
    noTeamChangeLog(c, "invite.create");
  });

  test("a reset link held during the actor's demotion is 409, not 403, with 0 links", async () => {
    const c = await actions();
    const held = await heldMemberPost(c, "admin", "/team/reset-link", c.ids.member, {});
    expect(
      (await submit(c, "owner", "/team/role", c.ids.admin, { role: "member" }, SECOND_OWNER))
        .status,
    ).toBe(303);
    const r = await held.finish();
    expect(r.status).toBe(409);
    expect(r.body).toContain(NOT_SAVED);
    expect(r.body).not.toContain("/reset/");
    expect(count(c, "reset_links WHERE user_id = ?", c.ids.member)).toBe(0);
    noTeamChangeLog(c, "user.reset-link");
  });

  test("a removal held during the actor's password reset is 409 and the Viewer stays", async () => {
    const c = await actions();
    const held = await heldMemberPost(c, "admin", "/team/remove", c.ids.viewer, {
      confirm_name: "Vi Viewer",
    });
    await resetPasswordOf(c, c.ids.admin);
    const r = await held.finish();
    expect(r.status).toBe(409);
    expect(r.body).toContain(NOT_SAVED);
    expect(count(c, "users WHERE id = ?", c.ids.viewer)).toBe(1);
    expect(count(c, "sessions WHERE user_id = ?", c.ids.viewer)).toBe(1);
    expect(count(c, "people_events WHERE action = 'user.remove'")).toBe(0);
    noTeamChangeLog(c, "user.remove");
  });

  test("the switch held during the Owner's sign out all is 409 and stays off", async () => {
    const c = await actions();
    const page = await getPage(c, "/team", c.cookies.owner);
    const held = await heldPost(c, "/team/require-2fa", c.cookies.owner, {
      csrf: c.csrfs.owner,
      form_token: formTokenOf(page.body, "/team/require-2fa"),
      value: "on",
    });
    const confirm = await getPage(c, "/account/sessions/sign-out-all", SECOND_OWNER);
    const out = await postForm(
      c,
      "/account/sessions/sign-out-all",
      {
        csrf: "owner-csrf-2",
        form_token: formTokenOf(confirm.body, "/account/sessions/sign-out-all"),
      },
      { cookie: SECOND_OWNER },
    );
    expect(out.status).toBe(303);
    const r = await held.finish();
    expect(r.status).toBe(409);
    expect(r.body).toContain(NOT_SAVED);
    expect(
      c.db.query<{ v: number }, []>("SELECT require_2fa_all AS v FROM instance").get()?.v,
    ).toBe(0);
    expect(count(c, "people_events WHERE action = 'team.require-2fa'")).toBe(0);
    noTeamChangeLog(c, "team.require-2fa");
  });

  test("control: a held invite with no change in between is 200 with 1 invite", async () => {
    const c = await actions();
    const page = await getPage(c, "/team", c.cookies.admin);
    const held = await heldPost(c, "/team/invites", c.cookies.admin, {
      csrf: c.csrfs.admin,
      form_token: formTokenOf(page.body, "/team/invites"),
      email: "new@example.com",
      role: "member",
    });
    const r = await held.finish();
    expect(r.status).toBe(200);
    expect(r.body).toContain("/invite/");
    expect(count(c, "invites")).toBe(1);
  });
});
