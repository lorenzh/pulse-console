import { afterEach, describe, expect, test } from "bun:test";
import { getPage } from "../test/signed-in-console.ts";
import { startTeamConsole, type TeamConsole } from "../test/team-console.ts";

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
