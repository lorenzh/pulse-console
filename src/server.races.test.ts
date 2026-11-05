// Acceptance 5a: credential races, made deterministic with a gated hash and verifier. The n-th
// fake hash of p is `fake$<n>$<p>`; the verifier accepts p for a hash ending in `$<p>`. A held
// call waits until the test releases it. No timer is used.

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import { formTokenOf, getPage, postForm, type Reply } from "../test/signed-in-console.ts";
import { sessionIdOf, startTeamConsole, type TeamConsole } from "../test/team-console.ts";
import { sessionDigest } from "./account-store.ts";
import type { CredentialVerifier } from "./passwords.ts";
import type { ConsoleRole } from "./roles.ts";

const START = 9_000_000;
const P0 = "password-zero-0000";
const P1 = "password-one-11111";
const P2 = "password-two-22222";
const P3 = "password-three-333";
const CHANGED_WHILE = "Your password or session changed while this was saved. Nothing was changed.";
const SECOND_SESSION = "second-session-for-races-0123456789abcdefg".slice(0, 43);

type Kind = "hash" | "verify";
type Hold = { reached: Promise<void>; release: () => void };

/** The gated fakes; `hold` makes the next call of `kind` with text `p` wait. */
function gatedPasswords(): {
  hashPassword: (p: string) => Promise<string>;
  verifier: CredentialVerifier;
  hold: (kind: Kind, p: string) => Hold;
} {
  let n = 0;
  const holds = new Map<string, { reach: () => void; wait: Promise<void> }>();
  const gate = async (kind: Kind, p: string): Promise<void> => {
    const key = `${kind}:${p}`;
    const held = holds.get(key);
    if (held === undefined) return;
    holds.delete(key);
    held.reach();
    await held.wait;
  };
  return {
    hashPassword: async (p) => {
      n += 1;
      const hash = `fake$${n}$${p}`;
      await gate("hash", p);
      return hash;
    },
    verifier: {
      verify: async (p, stored) => {
        await gate("verify", p);
        return stored?.endsWith(`$${p}`) === true;
      },
    },
    hold: (kind, p) => {
      let reach = (): void => undefined;
      let release = (): void => undefined;
      const reached = new Promise<void>((resolve) => {
        reach = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.set(`${kind}:${p}`, { reach, wait });
      return { reached, release };
    },
  };
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

type Race = TeamConsole & { hold: (kind: Kind, p: string) => Hold };

async function race(): Promise<Race> {
  const fakes = gatedPasswords();
  const c = await startTeamConsole({
    apiUrl: "http://127.0.0.1:9",
    hashPassword: fakes.hashPassword,
    verifier: fakes.verifier,
    extra: (db, ids) => {
      db.run(`UPDATE users SET password_hash = 'fake$0$${P0}'`);
      db.query(
        "INSERT INTO sessions (id_digest, user_id, csrf_token, created_at, last_seen_at, stage) VALUES (?, ?, 'second-csrf', ?, ?, 'full')",
      ).run(sessionDigest(SECOND_SESSION), ids.admin, START, START);
    },
  });
  cleanups.push(() => c.close());
  return { ...c, hold: fakes.hold };
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

function revision(c: TeamConsole, id: number): string {
  const row = c.db
    .query<{ created_at: number; role: string }, [number]>(
      "SELECT created_at, role FROM users WHERE id = ?",
    )
    .get(id);
  return `${row?.created_at}-${row?.role}`;
}

/** A team POST of `path?user=<id>` as `as`, after its GET. */
async function teamPost(
  c: TeamConsole,
  as: ConsoleRole,
  path: string,
  id: number,
  fields: Record<string, string> = {},
): Promise<Reply> {
  const action = `${path}?user=${id}`;
  const page = await getPage(c, action, c.cookies[as]);
  return postForm(
    c,
    action,
    {
      csrf: c.csrfs[as],
      form_token: formTokenOf(page.body, action),
      revision: revision(c, id),
      ...fields,
    },
    { cookie: c.cookies[as] },
  );
}

type OpenLink = { path: string; fields: Record<string, string>; cookie: string };

/** Makes a reset link for `id` as `as` and opens its form. */
async function openReset(
  c: TeamConsole,
  as: ConsoleRole,
  id: number,
  password: string,
): Promise<OpenLink> {
  const made = await teamPost(c, as, "/team/reset-link", id);
  expect(made.status).toBe(200);
  const token = /\/reset\/([A-Za-z0-9_-]{43})/.exec(made.body)?.[1] ?? "";
  const path = `/reset/${token}`;
  const page = await getPage(c, path, "");
  const csrf =
    /pulse_console_csrf=([A-Za-z0-9_-]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? "";
  return {
    path,
    cookie: `pulse_console_csrf=${csrf}`,
    fields: {
      csrf,
      form_token: formTokenOf(page.body, path),
      password,
      password_confirm: password,
    },
  };
}

function redeem(c: TeamConsole, link: OpenLink): Promise<Reply> {
  return postForm(c, link.path, link.fields, { cookie: link.cookie });
}

async function reset(c: TeamConsole, as: ConsoleRole, id: number, password: string): Promise<void> {
  expect((await redeem(c, await openReset(c, as, id, password))).status).toBe(303);
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

/** Opens the own password form of `cookie` and starts a change P0 to `to` (not awaited). */
async function startChange(
  c: TeamConsole,
  cookie: string,
  csrf: string,
  to: string,
): Promise<() => Promise<Reply>> {
  const page = await getPage(c, "/account/password", cookie);
  const fields = {
    csrf,
    form_token: formTokenOf(page.body, "/account/password"),
    password: P0,
    new_password: to,
    new_password_confirm: to,
  };
  return () => postForm(c, "/account/password", fields, { cookie });
}

async function startAccountPost(
  c: TeamConsole,
  role: ConsoleRole,
  path: string,
  fields: Record<string, string>,
): Promise<() => Promise<Reply>> {
  const page = await getPage(c, path, c.cookies[role]);
  const all = { csrf: c.csrfs[role], form_token: formTokenOf(page.body, path), ...fields };
  return () => postForm(c, path, all, { cookie: c.cookies[role] });
}

function events(c: TeamConsole, action: string): number {
  return count(c, "people_events WHERE action = ?", action);
}

describe("sign-in during a credential change", () => {
  test("a sign-in held in verification after a reset is 401 with 0 sessions", async () => {
    const c = await race();
    const held = c.hold("verify", P0);
    const pending = signIn(c, "member@example.com", P0);
    await held.reached;
    await reset(c, "admin", c.ids.member, P1);
    held.release();
    const r = await pending;
    expect(r.status).toBe(401);
    expect(r.body).toContain("Wrong email or password.");
    expect(r.headers.get("set-cookie") ?? "").not.toContain("pulse_console_session=");
    expect(count(c, "sessions WHERE user_id = ?", c.ids.member)).toBe(0);
    expect(
      c.logs.some((l) => l.includes('"sign-in failed"') && l.includes('"reason":"credentials"')),
    ).toBe(true);
    expect((await signIn(c, "member@example.com", P1)).status).toBe(303);
  });

  test("a sign-in held in verification after a removal is 401, not 500", async () => {
    const c = await race();
    const held = c.hold("verify", P0);
    const pending = signIn(c, "member@example.com", P0);
    await held.reached;
    const removed = await teamPost(c, "admin", "/team/remove", c.ids.member, {
      confirm_name: "Mo Member",
    });
    expect(removed.status).toBe(303);
    held.release();
    expect((await pending).status).toBe(401);
  });
});

describe("own password change during other changes", () => {
  for (const kind of ["hash", "verify"] as const) {
    test(`a change held at ${kind} after a reset is 409 and keeps the reset hash`, async () => {
      const c = await race();
      const send = await startChange(c, c.cookies.member, c.csrfs.member, P2);
      const held = c.hold(kind, kind === "hash" ? P2 : P0);
      const pending = send();
      await held.reached;
      await reset(c, "admin", c.ids.member, P1);
      const resetHash = hashOf(c, c.ids.member);
      expect(resetHash).toEndWith(`$${P1}`);
      held.release();
      const r = await pending;
      expect(r.status).toBe(409);
      expect(r.body).toContain(CHANGED_WHILE);
      expect(hashOf(c, c.ids.member)).toBe(resetHash);
      expect(events(c, "user.password-reset")).toBe(1);
      expect(events(c, "user.password-change")).toBe(0);
    });
  }

  test("two changes from one session held while hashing: 303, then 409", async () => {
    const c = await race();
    const first = await startChange(c, c.cookies.member, c.csrfs.member, P2);
    const second = await startChange(c, c.cookies.member, c.csrfs.member, P3);
    const h2 = c.hold("hash", P2);
    const h3 = c.hold("hash", P3);
    const p2 = first();
    const p3 = second();
    await h2.reached;
    await h3.reached;
    h2.release();
    expect((await p2).status).toBe(303);
    h3.release();
    expect((await p3).status).toBe(409);
    expect(hashOf(c, c.ids.member)).toEndWith(`$${P2}`);
  });

  test("a change held while the Owner changes the role is 409 with the hash unchanged", async () => {
    const c = await race();
    const send = await startChange(c, c.cookies.member, c.csrfs.member, P2);
    const held = c.hold("hash", P2);
    const pending = send();
    await held.reached;
    expect(
      (await teamPost(c, "owner", "/team/role", c.ids.member, { role: "viewer" })).status,
    ).toBe(303);
    held.release();
    expect((await pending).status).toBe(409);
    expect(hashOf(c, c.ids.member)).toBe(`fake$0$${P0}`);
  });

  test("a reset held while hashing still wins after an own change commits", async () => {
    const c = await race();
    const link = await openReset(c, "admin", c.ids.member, P1);
    const held = c.hold("hash", P1);
    const pending = redeem(c, link);
    await held.reached;
    const send = await startChange(c, c.cookies.member, c.csrfs.member, P2);
    expect((await send()).status).toBe(303);
    held.release();
    expect((await pending).status).toBe(303);
    expect(hashOf(c, c.ids.member)).toEndWith(`$${P1}`);
  });

  test("a second reset POST with the same form token while the first hashes is Already submitted", async () => {
    const c = await race();
    const link = await openReset(c, "admin", c.ids.member, P1);
    const held = c.hold("hash", P1);
    const first = redeem(c, link);
    await held.reached;
    const second = await redeem(c, link);
    expect(second.status).toBe(409);
    expect(second.body).toContain("Already submitted");
    expect(second.body).toContain('href="/sign-in"');
    expect(second.body).not.toContain(link.path);
    held.release();
    expect((await first).status).toBe(303);
  });
});

describe("guarded account writes", () => {
  function codeDigests(c: TeamConsole, id: number): string[] {
    return c.db
      .query<{ d: string }, [number]>("SELECT digest AS d FROM recovery_codes WHERE user_id = ?")
      .all(id)
      .map((r) => r.d)
      .sort((a, b) => a.localeCompare(b));
  }

  /** The Admin has 10 codes written through the unguarded store function. */
  function seedCodes(c: Race): string[] {
    const digests = Array.from({ length: 10 }, (_, i) =>
      createHash("sha256").update(`code-${i}`).digest("hex"),
    );
    c.db.query("DELETE FROM recovery_codes WHERE user_id = ?").run(c.ids.admin);
    for (const d of digests) {
      c.db.query("INSERT INTO recovery_codes (user_id, digest) VALUES (?, ?)").run(c.ids.admin, d);
    }
    return [...digests].sort((a, b) => a.localeCompare(b));
  }

  async function heldNewCodes(c: Race): Promise<{ held: Hold; pending: Promise<Reply> }> {
    const send = await startAccountPost(c, "admin", "/account/recovery-codes", { password: P0 });
    const held = c.hold("verify", P0);
    return { held, pending: send() };
  }

  function expectNoCodes(c: TeamConsole, r: Reply): void {
    expect(r.status).toBe(409);
    expect(r.body).toContain(CHANGED_WHILE);
    expect(r.body).not.toContain('id="recovery-codes"');
    expect(r.body.split('<header class="sidebar">')).toHaveLength(2);
    expect(r.body).toContain(
      'Signed in as Ada Admin <span class="account-email">(admin@example.com)</span>',
    );
    expect(r.body).toContain('<a class="cancel" href="/account/security">Cancel</a>');
    expect(c.logs.some((l) => l.includes('"recovery codes created"'))).toBe(false);
  }

  test("new codes held while the Admin's reset link is used are 409 and unchanged", async () => {
    const c = await race();
    const before = seedCodes(c);
    const { held, pending } = await heldNewCodes(c);
    await held.reached;
    await reset(c, "owner", c.ids.admin, P1);
    held.release();
    expectNoCodes(c, await pending);
    expect(codeDigests(c, c.ids.admin)).toEqual(before);
  });

  test("new codes held during the Admin's 2FA reset are 409 with 0 codes", async () => {
    const c = await race();
    seedCodes(c);
    const { held, pending } = await heldNewCodes(c);
    await held.reached;
    expect((await teamPost(c, "owner", "/team/reset-2fa", c.ids.admin)).status).toBe(303);
    held.release();
    expectNoCodes(c, await pending);
    expect(count(c, "recovery_codes WHERE user_id = ?", c.ids.admin)).toBe(0);
    expect(count(c, "authenticators WHERE user_id = ?", c.ids.admin)).toBe(0);
  });

  test("new codes held during an own change from another session are 409 and unchanged", async () => {
    const c = await race();
    const before = seedCodes(c);
    const { held, pending } = await heldNewCodes(c);
    await held.reached;
    const other = `pulse_console_session=${SECOND_SESSION}`;
    const send = await startChange(c, other, "second-csrf", P2);
    expect((await send()).status).toBe(303);
    held.release();
    expectNoCodes(c, await pending);
    expect(codeDigests(c, c.ids.admin)).toEqual(before);
  });

  test("authenticator setup held at the password during a reset is 409 with 0 pending rows", async () => {
    const c = await race();
    const send = await startAccountPost(c, "member", "/account/authenticator", {
      action: "new",
      password: P0,
    });
    const held = c.hold("verify", P0);
    const pending = send();
    await held.reached;
    await reset(c, "admin", c.ids.member, P1);
    held.release();
    const r = await pending;
    expect(r.status).toBe(409);
    expect(r.body).toContain(CHANGED_WHILE);
    expect(count(c, "pending_authenticators WHERE user_id = ?", c.ids.member)).toBe(0);
  });

  test("sign out all with a held body after a reset is 409 and keeps the new session", async () => {
    const c = await race();
    const page = await getPage(c, "/account/sessions/sign-out-all", c.cookies.member);
    const body = new URLSearchParams({
      csrf: c.csrfs.member,
      form_token: formTokenOf(page.body, "/account/sessions/sign-out-all"),
    }).toString();
    const url = new URL(c.base);
    const socket = connect(Number(url.port), "127.0.0.1");
    await once(socket, "connect");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    const ended = once(socket, "end");
    const half = Math.floor(body.length / 2);
    socket.write(
      `POST /account/sessions/sign-out-all HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${c.base}\r\nCookie: ${c.cookies.member}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body.slice(0, half)}`,
    );
    await reset(c, "admin", c.ids.member, P1);
    const again = await signIn(c, "member@example.com", P1);
    expect(again.status).toBe(303);
    const s2 = /pulse_console_session=([^;]+)/.exec(again.headers.get("set-cookie") ?? "")?.[1];
    socket.write(body.slice(half));
    await ended;
    const text = Buffer.concat(chunks).toString("utf8");
    expect(Number(text.split(" ")[1])).toBe(409);
    expect(text).toContain(CHANGED_WHILE);
    expect(text.split('<header class="sidebar">')).toHaveLength(2);
    expect(text).toContain(
      'Signed in as Mo Member <span class="account-email">(member@example.com)</span>',
    );
    expect(text).toContain('<a class="cancel" href="/account/sessions">Cancel</a>');
    expect(count(c, "sessions WHERE id_digest = ?", sessionDigest(s2 ?? ""))).toBe(1);
    expect(text).not.toContain(sessionIdOf("member"));
  });
});
