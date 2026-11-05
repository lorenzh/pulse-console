import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { connect } from "node:net";
import { formTokenOf, getPage, postForm } from "../test/signed-in-console.ts";
import { sessionIdOf, startTeamConsole, type TeamConsole } from "../test/team-console.ts";
import { sessionDigest } from "./account-store.ts";

const START = 9_000_000;
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

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
    expect(r.body).toContain('<a href="/team" aria-current="page">Team</a>');
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
