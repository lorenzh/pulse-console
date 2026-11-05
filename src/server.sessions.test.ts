import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  Client,
  type Console,
  closeAll,
  count,
  csrfIn,
  enrolledConsole,
  PASSWORD,
  SESSION,
  STEP_MS,
  startConsole,
  stepAt,
  totpCode,
} from "./two-factor-harness.ts";

afterEach(closeAll);

/** Password, then the TOTP code of a step that no earlier sign-in used. */
async function fullClient(c: Console, seed: Buffer): Promise<Client> {
  c.clock.now += STEP_MS;
  const client = new Client(c);
  expect((await client.password()).headers.get("location")).toBe("/sign-in/factor");
  const res = await client.factor({ code: totpCode(seed, stepAt(c.clock.now)) });
  expect(res.status).toBe(303);
  return client;
}

/** An enrolled owner without the session of the enrolling browser. */
async function freshEnrolled(): Promise<{ c: Console; seed: Buffer }> {
  const { c, seed } = await enrolledConsole();
  const db = new Database(c.dbPath);
  db.run("DELETE FROM sessions");
  db.close();
  return { c, seed };
}

function digestOf(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

type Row = { id_digest: string; csrf_token: string; user_id: number; last_seen_at: number };

function sessionRows(dbPath: string): Row[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .query<Row, []>(
      "SELECT id_digest, csrf_token, user_id, last_seen_at FROM sessions ORDER BY id_digest",
    )
    .all();
  db.close();
  return rows;
}

/** A second user with one live `full` session, written as fixture rows. */
function addSecondUser(dbPath: string, now: number): string {
  const db = new Database(dbPath);
  db.run(
    "INSERT INTO users (email, name, password_hash, role, created_at) VALUES ('second@example.com', 'Second', 'x', 'member', ?)",
    [now],
  );
  const id = "second-user-session-id";
  db.run(
    "INSERT INTO sessions (id_digest, user_id, csrf_token, created_at, last_seen_at, stage) VALUES (?, (SELECT id FROM users WHERE email = 'second@example.com'), 'second-csrf', ?, ?, 'full')",
    [digestOf(id), now, now],
  );
  db.close();
  return digestOf(id);
}

function tableRows(body: string): string[] {
  return [...body.matchAll(/<tr><td>[^\n]*?<\/tr>/g)].map((m) => m[0]);
}

describe("sign out all other sessions", () => {
  test("a pause after the confirmation page leaves the row and cookie unchanged", async () => {
    const { c, seed } = await freshEnrolled();
    const a = await fullClient(c, seed);
    const aId = a.jar.get(SESSION) ?? "";
    const confirm = await a.get("/account/sessions/sign-out-all");
    const before = sessionRows(c.dbPath).find((r) => r.id_digest === digestOf(aId));
    c.clock.now += 60000;
    const done = await a.post("/account/sessions/sign-out-all", { csrf: csrfIn(confirm.body) });
    expect(done.status).toBe(303);
    expect(done.headers.getSetCookie()).toEqual([]);
    const after = sessionRows(c.dbPath).find((r) => r.id_digest === digestOf(aId));
    expect(after?.last_seen_at).toBe(before?.last_seen_at ?? -1);
  });

  test("ends B, C and D in every stage and keeps A unchanged", async () => {
    const { c, seed } = await freshEnrolled();
    const a = await fullClient(c, seed);
    const b = await fullClient(c, seed);
    const d = await fullClient(c, seed);
    const secondDigest = addSecondUser(c.dbPath, c.clock.now);
    const dPage = await d.get("/account/authenticator");
    const dNew = await d.post("/account/authenticator", {
      csrf: csrfIn(dPage.body),
      action: "new",
      password: PASSWORD,
    });
    expect(dNew.status).toBe(303);
    expect(count(c.dbPath, "SELECT count(*) AS n FROM pending_authenticators")).toBe(1);
    const cBrowser = new Client(c);
    expect((await cBrowser.password()).headers.get("location")).toBe("/sign-in/factor");

    const list = await a.get("/account/sessions");
    expect(list.status).toBe(200);
    expect(tableRows(list.body)).toHaveLength(3);
    expect(list.body.split("This browser")).toHaveLength(2);
    const aId = a.jar.get(SESSION) ?? "";
    const bId = b.jar.get(SESSION) ?? "";
    for (const secret of [bId, d.jar.get(SESSION) ?? "", aId, digestOf(bId)]) {
      expect(list.body).not.toContain(secret);
    }
    const bCsrf = csrfIn((await b.get("/account/sessions")).body);
    expect(list.body).not.toContain(bCsrf);

    const confirm = await a.get("/account/sessions/sign-out-all");
    expect(confirm.status).toBe(200);
    expect(confirm.body).toContain("Sign out all other sessions? This browser stays signed in.");
    const aCsrf = csrfIn(confirm.body);
    const before = sessionRows(c.dbPath).find((r) => r.id_digest === digestOf(aId));

    expect((await a.post("/account/sessions/sign-out-all", {})).status).toBe(403);
    expect((await a.post("/account/sessions/sign-out-all", { csrf: bCsrf })).status).toBe(403);
    expect((await b.get("/")).status).toBe(200);

    const done = await a.post("/account/sessions/sign-out-all", { csrf: aCsrf });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/account/sessions?signed-out=others");
    expect(done.headers.getSetCookie()).toEqual([]);
    expect(
      c.logs.some((l) => l.includes("signed out other sessions") && l.includes('"sessions":3')),
    ).toBe(true);

    for (const other of [b, d]) {
      const res = await other.get("/");
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/sign-in?next=%2F");
    }
    const cFactor = await cBrowser.post("/sign-in/factor", {
      csrf: "any",
      code: totpCode(seed, stepAt(c.clock.now) + 1),
    });
    expect(cFactor.status).toBe(303);
    expect(cFactor.headers.get("location")).toBe("/sign-in");

    const home = await a.get("/");
    expect(home.status).toBe(200);
    expect(home.body).toContain("Signed in as");
    const after = await a.get("/account/sessions?signed-out=others");
    expect(after.status).toBe(200);
    expect(after.body).toContain("All other sessions are signed out.");
    expect(tableRows(after.body)).toHaveLength(1);
    expect(after.body).toContain("This browser");
    expect(csrfIn(after.body)).toBe(aCsrf);
    expect((await a.post("/account/sessions/sign-out-all", { csrf: aCsrf })).status).toBe(303);

    const rows = sessionRows(c.dbPath);
    const own = rows.filter((r) => r.id_digest !== secondDigest);
    expect(own).toHaveLength(1);
    expect(own[0]?.id_digest).toBe(before?.id_digest ?? "missing");
    expect(own[0]?.csrf_token).toBe(before?.csrf_token ?? "missing");
    expect(rows.filter((r) => r.id_digest === secondDigest)).toHaveLength(1);
    expect(count(c.dbPath, "SELECT count(*) AS n FROM pending_authenticators")).toBe(0);

    const restarted = await startConsole({ dbPath: c.dbPath, clock: c.clock });
    for (const client of [a, b, cBrowser, d]) client.c = restarted;
    expect((await a.get("/")).status).toBe(200);
    for (const other of [b, d]) expect((await other.get("/")).status).toBe(303);
    const again = await cBrowser.post("/sign-in/factor", {
      csrf: "any",
      code: totpCode(seed, stepAt(c.clock.now) + 1),
    });
    expect(again.headers.get("location")).toBe("/sign-in");
  });

  test("Sign out ends only this browser", async () => {
    const { c, seed } = await freshEnrolled();
    const a = await fullClient(c, seed);
    const b = await fullClient(c, seed);
    const aId = a.jar.get(SESSION) ?? "";
    const page = await a.get("/account/sessions");
    const out = await a.post("/sign-out", { csrf: csrfIn(page.body) });
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/sign-in");
    a.jar.set(SESSION, aId);
    const stale = await a.get("/");
    expect(stale.status).toBe(303);
    expect(stale.headers.get("location")).toBe("/sign-in?next=%2F");
    expect((await b.get("/")).status).toBe(200);
    expect(count(c.dbPath, "SELECT count(*) AS n FROM sessions")).toBe(1);
  });

  test("the security page links the account pages and the landing page links it", async () => {
    const { c, seed } = await freshEnrolled();
    const a = await fullClient(c, seed);
    const home = await a.get("/");
    expect(home.body).toContain('<a href="/account/security">Account security</a>');
    const page = await a.get("/account/security");
    expect(page.status).toBe(200);
    expect(page.body).toContain("10 of 10 recovery codes left");
    expect(page.body).toContain("Authenticator added 2023-11-14 22:13 UTC");
    for (const link of [
      '<a href="/account/authenticator">Replace authenticator</a>',
      '<a href="/account/recovery-codes">New recovery codes</a>',
      '<a href="/account/sessions">Sessions</a>',
    ]) {
      expect(page.body).toContain(link);
    }
  });
});
