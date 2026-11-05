import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { createLogger } from "@lorenzh/pulse-kit";
import {
  formTokenOf,
  getPage,
  postForm,
  type Reply,
  replyOf,
  START,
} from "../test/signed-in-console.ts";
import { sessionIdOf, startTeamConsole, type TeamConsole } from "../test/team-console.ts";
import { createAccountStore } from "./account-store.ts";
import { openDatabase } from "./database.ts";
import { createFactorStore } from "./factor-store.ts";
import { createMetrics } from "./metrics.ts";
import { createCredentialVerifier, PASSWORD_HASH_OPTIONS } from "./passwords.ts";
import type { ConsoleRole } from "./roles.ts";
import { createConsoleServer, listen } from "./server.ts";
import { createTeamStore } from "./team-store.ts";

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const LINK_NOT_VALID =
  "This link is not valid. It may have expired or been used. Ask an admin for a new one.";
const PASSWORD = "invited-person-password-1";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function team(isRequiredForAll = false): Promise<TeamConsole> {
  const c = await startTeamConsole({ apiUrl: "http://127.0.0.1:9", isRequiredForAll });
  cleanups.push(() => c.close());
  return c;
}

function count(db: Database, sql: string, ...args: (string | number)[]): number {
  return (
    db.query<{ n: number }, (string | number)[]>(`SELECT count(*) AS n FROM ${sql}`).get(...args)
      ?.n ?? -1
  );
}

/** Creates an invite through the Team page as `as` and returns its token. */
async function createInvite(
  c: TeamConsole,
  options: { role?: string; email?: string; as?: ConsoleRole } = {},
): Promise<{ token: string; reply: Reply }> {
  const as = options.as ?? "admin";
  const page = await getPage(c, "/team", c.cookies[as]);
  const reply = await postForm(
    c,
    "/team/invites",
    {
      csrf: c.csrfs[as],
      form_token: formTokenOf(page.body, "/team/invites"),
      email: options.email ?? "new@example.com",
      role: options.role ?? "member",
    },
    { cookie: c.cookies[as] },
  );
  const token = /\/invite\/([A-Za-z0-9_-]{43})/.exec(reply.body)?.[1] ?? "";
  return { token, reply };
}

type Opened = { reply: Reply; csrf: string; formToken: string; cookie: string };

function csrfCookieOf(reply: Reply): string | undefined {
  const header = reply.headers.get("set-cookie") ?? "";
  return /pulse_console_csrf=([A-Za-z0-9_-]+)/.exec(header)?.[1];
}

/** GET of the link; the anonymous CSRF cookie is the one it sets, else the one sent. */
async function openLink(c: TeamConsole, token: string, cookie = ""): Promise<Opened> {
  const reply = await getPage(c, `/invite/${token}`, cookie);
  const sent = /pulse_console_csrf=([A-Za-z0-9_-]+)/.exec(cookie)?.[1];
  const csrf = csrfCookieOf(reply) ?? sent ?? "";
  const formToken = formTokenOf(reply.body, `/invite/${token}`);
  return { reply, csrf, formToken, cookie: `pulse_console_csrf=${csrf}` };
}

function accept(
  c: TeamConsole,
  token: string,
  opened: Opened,
  options: { fields?: Record<string, string>; cookie?: string; origin?: string } = {},
): Promise<Reply> {
  return postForm(
    c,
    `/invite/${token}`,
    {
      csrf: opened.csrf,
      form_token: opened.formToken,
      name: "Newt Person",
      password: PASSWORD,
      password_confirm: PASSWORD,
      ...options.fields,
    },
    { cookie: options.cookie ?? opened.cookie, origin: options.origin ?? c.base },
  );
}

function sessionValueOf(reply: Reply): string {
  return /pulse_console_session=([^;]+)/.exec(reply.headers.get("set-cookie") ?? "")?.[1] ?? "";
}

describe("create and the link page", () => {
  test("an Admin creates a Member invite: 200 link page, digest stored, one event", async () => {
    const c = await team();
    const { token, reply } = await createInvite(c);
    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-security-policy")).toBe(CSP);
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(reply.body).toContain(`value="${c.base}/invite/${token}"`);
    expect(reply.body).toContain("<p>Email: new@example.com</p>");
    expect(reply.body).toContain("<p>Role: Member</p>");
    expect(reply.body).toContain(
      "<p>It works once and expires on 1970-01-08 02:30 UTC. It is shown only now.</p>",
    );
    expect(reply.body).not.toContain("SMTP");
    const expected = createHash("sha256").update(token).digest("hex");
    expect(c.db.query("SELECT token_digest FROM invites").all()).toEqual([
      { token_digest: expected },
    ]);
    expect(count(c.db, "people_events WHERE action = 'invite.create'")).toBe(1);
    expect(
      c.logs.some((l) => l.includes('"msg":"team change"') && l.includes("invite.create")),
    ).toBe(true);
    // The plain token is in no database file and no log line.
    const path = c.db.filename;
    c.db.run("PRAGMA wal_checkpoint(FULL)");
    for (const file of [path, `${path}-wal`]) {
      if (existsSync(file)) expect(readFileSync(file).includes(token)).toBe(false);
    }
    expect(c.logs.join("\n")).not.toContain(token);
    expect(c.metrics.render()).toContain(
      'pulse_console_http_requests_total{path="/team/invites",code="200"} 1',
    );
  });

  test("a browser reload re-sends the used form token and gets 409, never the link again", async () => {
    const c = await team();
    const page = await getPage(c, "/team", c.cookies.admin);
    const fields = {
      csrf: c.csrfs.admin,
      form_token: formTokenOf(page.body, "/team/invites"),
      email: "new@example.com",
      role: "member",
    };
    expect((await postForm(c, "/team/invites", fields, { cookie: c.cookies.admin })).status).toBe(
      200,
    );
    const again = await postForm(c, "/team/invites", fields, { cookie: c.cookies.admin });
    expect(again.status).toBe(409);
    expect(again.body).toContain("Already submitted");
    expect(again.body).not.toContain("/invite/");
  });

  test("field, role and duplicate answers: 422, 403 naming Owner, 409", async () => {
    const c = await team();
    expect((await createInvite(c, { role: "owner", as: "owner" })).reply.status).toBe(422);
    const bad = await createInvite(c, { role: "superuser", email: "x@" });
    expect(bad.reply.status).toBe(422);
    expect(bad.reply.body).toContain("Choose admin, member or viewer.");
    expect(bad.reply.body).toContain("Enter a valid email address.");
    const admin = await createInvite(c, { role: "admin" });
    expect(admin.reply.status).toBe(403);
    expect(admin.reply.body).toContain("needs the Owner role");
    const exists = await createInvite(c, { email: " Member@Example.com " });
    expect(exists.reply.status).toBe(409);
    expect(exists.reply.body).toContain("An account with this email exists.");
    expect((await createInvite(c, { email: "ann@example.com" })).reply.status).toBe(200);
    const pending = await createInvite(c, { email: "Ann@Example.com " });
    expect(pending.reply.status).toBe(409);
    expect(pending.reply.body).toContain(
      "An invite for this email is pending. Revoke it to make a new one.",
    );
    expect(count(c.db, "invites")).toBe(1);
    expect(count(c.db, "people_events")).toBe(1);
  });

  test("the Team page lists the invite with a Revoke link the actor may use", async () => {
    const c = await team();
    await createInvite(c, { role: "admin", email: "boss@example.com", as: "owner" });
    await createInvite(c, { email: "new@example.com" });
    const admin = await getPage(c, "/team", c.cookies.admin);
    expect(admin.body).toContain('<a href="/team/invites/revoke?invite=2">Revoke');
    expect(admin.body).not.toContain('<a href="/team/invites/revoke?invite=1">');
    expect(admin.body).not.toContain('<option value="admin"');
    const owner = await getPage(c, "/team", c.cookies.owner);
    expect(owner.body).toContain('<a href="/team/invites/revoke?invite=1">Revoke');
    expect(owner.body).toContain('<option value="admin">Admin</option>');
    expect(owner.body).toMatch(
      /name="csrf" value="[^"]*">\n<input type="hidden" name="form_token"/,
    );
  });
});

describe("revoke", () => {
  test("GET confirms, POST revokes with one event and 303; again 404", async () => {
    const c = await team();
    await createInvite(c);
    const page = await getPage(c, "/team/invites/revoke?invite=1", c.cookies.admin);
    expect(page.status).toBe(200);
    expect(page.body).toContain("The invite for new@example.com (Member) stops working.");
    expect(page.body).toMatch(
      /name="csrf" value="admin-csrf">\n<input type="hidden" name="form_token"/,
    );
    const fields = {
      csrf: c.csrfs.admin,
      form_token: formTokenOf(page.body, "/team/invites/revoke?invite=1"),
    };
    const r = await postForm(c, "/team/invites/revoke?invite=1", fields, {
      cookie: c.cookies.admin,
    });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/team");
    expect(count(c.db, "invites WHERE revoked_at IS NOT NULL")).toBe(1);
    expect(count(c.db, "people_events WHERE action = 'invite.revoke'")).toBe(1);
    expect((await getPage(c, "/team/invites/revoke?invite=1", c.cookies.admin)).status).toBe(404);
  });

  test("an Admin may not revoke an Admin invite; bad and unknown ids are 404", async () => {
    const c = await team();
    await createInvite(c, { role: "admin", as: "owner" });
    const denied = await getPage(c, "/team/invites/revoke?invite=1", c.cookies.admin);
    expect(denied.status).toBe(403);
    expect(denied.body).toContain("This page needs the Owner role or higher. Your role is Admin.");
    for (const query of ["?invite=0", "?invite=01", "?invite=abc", "?invite=9", ""]) {
      expect((await getPage(c, `/team/invites/revoke${query}`, c.cookies.owner)).status).toBe(404);
    }
    expect((await getPage(c, "/team/invites/revoke?invite=1", c.cookies.member)).status).toBe(403);
    expect(count(c.db, "invites WHERE revoked_at IS NULL")).toBe(1);
  });

  test("a revoked invite link answers 404", async () => {
    const c = await team();
    const { token } = await createInvite(c);
    const opened = await openLink(c, token);
    const page = await getPage(c, "/team/invites/revoke?invite=1", c.cookies.owner);
    await postForm(
      c,
      "/team/invites/revoke?invite=1",
      { csrf: c.csrfs.owner, form_token: formTokenOf(page.body, "/team/invites/revoke?invite=1") },
      { cookie: c.cookies.owner },
    );
    expect((await getPage(c, `/invite/${token}`)).status).toBe(404);
    const r = await accept(c, token, opened);
    expect(r.status).toBe(404);
    expect(r.body).toContain(LINK_NOT_VALID);
  });
});

describe("accept", () => {
  test("live at +604799999 ms, 404 at +604800000 ms for GET and POST", async () => {
    const c = await team();
    const first = await createInvite(c, { email: "one@example.com" });
    const second = await createInvite(c, { email: "two@example.com" });
    const openedSecond = await openLink(c, second.token);
    c.setNow(START + 604_799_999);
    const openedFirst = await openLink(c, first.token);
    expect(openedFirst.reply.status).toBe(200);
    expect((await accept(c, first.token, openedFirst)).status).toBe(303);
    c.setNow(START + 604_800_000);
    const late = await getPage(c, `/invite/${second.token}`, "");
    expect(late.status).toBe(404);
    expect(late.body).toContain("<h1>Link not valid</h1>");
    expect(late.body).toContain(LINK_NOT_VALID);
    expect(late.body).not.toContain("two@example.com");
    expect((await accept(c, second.token, openedSecond)).status).toBe(404);
  });

  test("the accept form: bound email as text, no script, csrf then form_token", async () => {
    const c = await team();
    const { token } = await createInvite(c);
    const opened = await openLink(c, token);
    const r = opened.reply;
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBe(CSP);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("same-origin");
    expect(r.headers.get("set-cookie") ?? "").toMatch(/^pulse_console_csrf=/);
    expect(r.body).not.toContain("<script");
    expect(r.body).toContain("<p>Email: new@example.com</p>");
    expect(r.body).not.toContain('name="email"');
    expect(r.body).toContain(
      `<input type="hidden" name="csrf" value="${opened.csrf}">\n<input type="hidden" name="form_token"`,
    );
    expect(c.metrics.render()).toContain(
      'pulse_console_http_requests_total{path="/invite/:token",code="200"} 1',
    );
    expect(c.metrics.render()).not.toContain(token);
  });

  test("a 422 leaves the invite live; a later valid POST makes the account; used is 404", async () => {
    const c = await team();
    const { token } = await createInvite(c);
    const opened = await openLink(c, token);
    const short = await accept(c, token, opened, {
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- an 11-character test input
      fields: { password: "elevenchars", password_confirm: "elevenchars" },
    });
    expect(short.status).toBe(422);
    expect(short.body).toContain("The password must have at least 12 characters.");
    const fresh = formTokenOf(short.body, `/invite/${token}`);
    const ok = await accept(
      c,
      token,
      { ...opened, formToken: fresh },
      {
        fields: { email: "evil@example.com", role: "admin" },
      },
    );
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/");
    expect(
      c.db.query("SELECT email, name, role FROM users WHERE name = 'Newt Person'").all(),
    ).toEqual([{ email: "new@example.com", name: "Newt Person", role: "member" }]);
    expect(count(c.db, "people_events WHERE action = 'invite.accept'")).toBe(1);
    expect((await getPage(c, `/invite/${token}`)).status).toBe(404);
    // The new session works.
    const cookie = `pulse_console_session=${sessionValueOf(ok)}`;
    expect((await getPage(c, "/", cookie)).status).not.toBe(303);
  });

  test("a malformed or unknown token is the plain 404; an unknown one sets no cookie", async () => {
    const c = await team();
    const unknown = await getPage(c, `/invite/${"A".repeat(43)}`, "");
    expect(unknown.status).toBe(404);
    expect(unknown.body).toContain(LINK_NOT_VALID);
    expect(unknown.headers.get("set-cookie")).toBeNull();
    const short = await getPage(c, `/invite/${"A".repeat(42)}`, "");
    expect(short.status).toBe(404);
    expect(short.body).toBe("not found\n");
    const r = await fetch(`${c.base}/invite/${"A".repeat(43)}`, { method: "PUT" });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET, HEAD, POST");
  });

  test("malformed link paths are the plain 404 with or without a session", async () => {
    const c = await team();
    const paths = [
      `/invite/${"A".repeat(43)}/`,
      `/invite/${"A".repeat(42)}`,
      `/invite/${"A".repeat(44)}`,
      "/invite/%2e%2e",
      `//invite/${"A".repeat(43)}`,
      `/invite/${"A".repeat(43)}/x`,
      "/invite/",
      `/reset/${"A".repeat(43)}/`,
      `/reset/${"A".repeat(42)}`,
      `//reset/${"A".repeat(43)}`,
    ];
    for (const path of paths) {
      for (const cookie of ["", c.cookies.admin, c.cookies.member]) {
        const page = await rawGet(c.base, path, cookie);
        expect({ path, ...page }).toEqual({
          path,
          status: 404,
          body: "not found\n",
        });
      }
    }
  });

  test("an invite of a removed or demoted creator answers 404", async () => {
    const c = await team();
    const { token } = await createInvite(c);
    c.db.query("UPDATE users SET role = 'member' WHERE id = ?").run(c.ids.admin);
    expect((await getPage(c, `/invite/${token}`)).status).toBe(404);
  });

  test("two concurrent valid POSTs: one 303, one 404, one new user", async () => {
    const c = await team();
    const { token } = await createInvite(c);
    const a = await openLink(c, token);
    const b = await openLink(c, token, a.cookie);
    const users = count(c.db, "users");
    const replies = await Promise.all([accept(c, token, a), accept(c, token, b)]);
    expect(replies.map((r) => r.status).sort((x, y) => x - y)).toEqual([303, 404]);
    expect(count(c.db, "users")).toBe(users + 1);
  });

  test("an Admin invite starts enrolment; so does a Member invite with the switch on", async () => {
    const c = await team();
    const { token } = await createInvite(c, {
      role: "admin",
      email: "boss@example.com",
      as: "owner",
    });
    const r = await accept(c, token, await openLink(c, token));
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/account/authenticator");
    const cookie = `pulse_console_session=${sessionValueOf(r)}`;
    const teamPage = await getPage(c, "/team", cookie);
    expect(teamPage.status).toBe(303);
    expect(teamPage.headers.get("location")).toBe("/account/authenticator");

    const s = await team(true);
    const member = await createInvite(s);
    const m = await accept(s, member.token, await openLink(s, member.token));
    expect(m.headers.get("location")).toBe("/account/authenticator");
  });
});

describe("anonymous CSRF, form token and replay", () => {
  test("missing cookie, wrong csrf or a foreign Origin is 403 and changes nothing", async () => {
    const c = await team();
    const { token } = await createInvite(c);
    const opened = await openLink(c, token);
    const users = count(c.db, "users");
    const refusals = [
      await accept(c, token, opened, { cookie: "" }),
      await accept(c, token, opened, { fields: { csrf: "other" } }),
      await accept(c, token, opened, { origin: "http://evil.example" }),
    ];
    for (const r of refusals) {
      expect(r.status).toBe(403);
      expect(r.body).toContain("Request refused");
    }
    // A session cookie of another user with that session's csrf and no anonymous cookie.
    const foreign = await accept(
      c,
      token,
      { ...opened, csrf: c.csrfs.viewer },
      {
        cookie: c.cookies.viewer,
      },
    );
    expect(foreign.status).toBe(403);
    expect(count(c.db, "users")).toBe(users);
    expect((await accept(c, token, opened)).status).toBe(303);
  });

  test("a successful POST sent again is 404 with no form-token log line", async () => {
    const c = await team();
    const { token } = await createInvite(c);
    const opened = await openLink(c, token);
    expect((await accept(c, token, opened)).status).toBe(303);
    const again = await accept(c, token, opened);
    expect(again.status).toBe(404);
    expect(again.body).toContain(LINK_NOT_VALID);
    expect(c.logs.some((l) => l.includes("form token refused"))).toBe(false);
  });

  test("a used form token on a still-live link is 409 Already submitted linking to /sign-in", async () => {
    const c = await team();
    const { token } = await createInvite(c);
    const opened = await openLink(c, token);
    c.db
      .query(
        "INSERT INTO users (email, name, password_hash, role, created_at) VALUES ('new@example.com', 'Late', 'h', 'viewer', 1)",
      )
      .run();
    const first = await accept(c, token, opened);
    expect(first.status).toBe(409);
    expect(first.body).toContain("An account with this email exists.");
    const second = await accept(c, token, opened);
    expect(second.status).toBe(409);
    expect(second.body).toContain("Already submitted");
    expect(second.body).toContain('href="/sign-in"');
    expect(second.body).not.toContain(token);
    expect(count(c.db, "invites WHERE used_at IS NULL")).toBe(1);
    const refused = c.logs.filter((l) => l.includes("form token refused"));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain('"path":"/invite/:token"');
    expect(refused.join("\n")).not.toContain(token);
  });

  test("accepting with an Admin session S removes S and starts exactly 1 Member session", async () => {
    const c = await team();
    const { token } = await createInvite(c);
    const opened = await openLink(c, token, c.cookies.admin);
    expect(opened.reply.status).toBe(200);
    const r = await accept(c, token, opened, { cookie: `${c.cookies.admin}; ${opened.cookie}` });
    expect(r.status).toBe(303);
    const adminDigest = createHash("sha256").update(sessionIdOf("admin")).digest("hex");
    expect(count(c.db, "sessions WHERE id_digest = ?", adminDigest)).toBe(0);
    const memberId =
      c.db.query<{ id: number }, []>("SELECT id FROM users WHERE email = 'new@example.com'").get()
        ?.id ?? 0;
    const digests = c.db
      .query<{ id_digest: string }, [number]>("SELECT id_digest FROM sessions WHERE user_id = ?")
      .all(memberId);
    const expected = createHash("sha256").update(sessionValueOf(r)).digest("hex");
    expect(digests).toEqual([{ id_digest: expected }]);

    const other = await createInvite(c, { email: "other@example.com", as: "owner" });
    const o = await openLink(c, other.token);
    const unknown = await accept(c, other.token, o, {
      cookie: `pulse_console_session=${"Z".repeat(43)}; ${o.cookie}`,
    });
    expect(unknown.status).toBe(303);
  });
});

describe("People log and restart", () => {
  test("a failed People-log insert answers 500 and leaves every table unchanged", async () => {
    const c = await team();
    const { token } = await createInvite(c);
    const opened = await openLink(c, token);
    const page = await getPage(c, "/team", c.cookies.owner);
    c.db.run(
      "CREATE TRIGGER fail_people BEFORE INSERT ON people_events BEGIN SELECT RAISE(ABORT, 'test'); END",
    );
    const tables = (): number[] =>
      ["users", "invites", "people_events", "sessions"].map((t) => count(c.db, t));
    const before = tables();
    const create = await postForm(
      c,
      "/team/invites",
      {
        csrf: c.csrfs.owner,
        form_token: formTokenOf(page.body, "/team/invites"),
        email: "z@example.com",
        role: "viewer",
      },
      { cookie: c.cookies.owner },
    );
    expect(create.status).toBe(500);
    expect(create.body).toContain("The change could not be saved.");
    const acc = await accept(c, token, opened);
    expect(acc.status).toBe(500);
    expect(tables()).toEqual(before);
    expect(count(c.db, "invites WHERE used_at IS NULL")).toBe(1);
    const failed = c.logs.filter((l) => l.includes("team change could not be saved"));
    expect(failed).toHaveLength(2);
    expect(failed.join("\n")).toContain('"error":"PeopleLogError"');
  });

  test("after a restart on the same file the link still works", async () => {
    const c = await team();
    const { token } = await createInvite(c);
    const path = c.db.filename;
    const db = openDatabase(path, {
      createFile: (p, mode) => closeSync(openSync(p, "wx", mode)),
      chmod: chmodSync,
    });
    const hash = (pw: string): Promise<string> => Bun.password.hash(pw, PASSWORD_HASH_OPTIONS);
    const server: Server = createConsoleServer({
      instanceName: "pulse Console",
      metrics: createMetrics(),
      log: createLogger({ level: "error", write: () => undefined }),
      mode: "loopback",
      publicOrigin: undefined,
      defaultApiUrl: "http://127.0.0.1:9",
      adminToken: undefined,
      store: createAccountStore(db),
      factorStore: createFactorStore(db),
      teamStore: createTeamStore(db),
      secretKey: undefined,
      gate: undefined,
      now: () => START,
      randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
      hashPassword: hash,
      verifier: await createCredentialVerifier({
        hash,
        verify: (pw, h) => Bun.password.verify(pw, h),
        dummySecret: "dummy secret for tests",
      }),
      fetch,
    });
    const port = await listen(server, "127.0.0.1", 0);
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            db.close();
            resolve();
          });
          server.closeAllConnections();
        }),
    );
    const r = await fetch(`http://127.0.0.1:${port}/invite/${token}`).then(replyOf);
    expect(r.status).toBe(200);
    expect(r.body).toContain("<p>Email: new@example.com</p>");
  });
});

/** A GET that sends the path verbatim; fetch would normalise `%2e%2e`. */
function rawGet(
  base: string,
  path: string,
  cookie: string,
): Promise<{ status: number; body: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: url.hostname, port: url.port, path, headers: cookie === "" ? {} : { cookie } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
