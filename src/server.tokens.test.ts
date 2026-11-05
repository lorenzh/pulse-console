import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { TokenMetadata } from "@lorenzh/pulse-contract";
import {
  type FakeApi,
  type FakeReply,
  jsonReply,
  startFakeApi,
  WIRE_HEADERS,
} from "../test/fake-api.ts";
import { formTokenOf, getPage, postForm, type Reply, START } from "../test/signed-in-console.ts";
import { startTeamConsole, type TeamConsole } from "../test/team-console.ts";
import { adminToken, FAKE_SECRET, probeToken, SELF_ID, selfToken } from "../test/token-fixtures.ts";
import type { ConsoleRole } from "./roles.ts";

const TOKEN = "tokens-admin-token-sentinel-0123456789";
const OPS_ID = "tok_ad0000000000000000000002";
const OTHER_ID = "tok_0e4e00000000000000000004";
const ROTATED_SECRET = "pulse_rotatedSecretValue9876543210fedcba";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

type Api = FakeApi & { setTokens: (tokens: TokenMetadata[]) => void };

function tokenApi(tokens: TokenMetadata[], self: TokenMetadata = selfToken()): Api {
  const api = startFakeApi();
  cleanups.push(() => api.stop());
  api.reply("/admin/tokens/self", jsonReply(self));
  const setTokens = (rows: TokenMetadata[]): void => {
    api.replyTo("GET", "/admin/tokens", jsonReply({ tokens: rows }));
    for (const row of rows) api.replyTo("GET", `/admin/tokens/${row.id}`, jsonReply(row));
  };
  setTokens(tokens);
  return { ...api, setTokens };
}

function created(token: TokenMetadata, status = 201): FakeReply {
  return {
    status,
    body: JSON.stringify({ token, secret: FAKE_SECRET, previousValidUntil: null }),
    headers: WIRE_HEADERS,
  };
}

async function tokensConsole(api: FakeApi): Promise<TeamConsole> {
  const c = await startTeamConsole({ apiUrl: api.url, adminToken: TOKEN });
  cleanups.push(() => c.close());
  return c;
}

function writes(api: FakeApi): string[] {
  return api.seen.filter((s) => s.method !== "GET").map((s) => `${s.method} ${s.path}`);
}

const self = selfToken();
const ops = adminToken();
const other = adminToken({ id: OTHER_ID, name: "deploy", scopes: ["read"] });
const probe = probeToken("eu");

async function postNew(
  c: TeamConsole,
  fields: Record<string, string>,
  role: ConsoleRole = "admin",
): Promise<Reply> {
  const page = await getPage(c, "/tokens/new", c.cookies[role]);
  return postForm(
    c,
    "/tokens/new",
    { csrf: c.csrfs[role], form_token: formTokenOf(page.body, "/tokens/new"), ...fields },
    { cookie: c.cookies[role] },
  );
}

function revisionOf(html: string): string {
  return /name="revision" value="([^"]*)"/.exec(html)?.[1] ?? "";
}

async function openChange(
  c: TeamConsole,
  change: "rotate" | "revoke",
  id: string,
): Promise<{ page: Reply; formToken: string; revision: string }> {
  const page = await getPage(c, `/tokens/${change}?id=${id}`, c.cookies.admin);
  return {
    page,
    formToken: formTokenOf(page.body, `/tokens/${change}?id=${id}`),
    revision: revisionOf(page.body),
  };
}

function postChange(
  c: TeamConsole,
  change: "rotate" | "revoke",
  id: string,
  fields: Record<string, string>,
): Promise<Reply> {
  return postForm(
    c,
    `/tokens/${change}?id=${id}`,
    { csrf: c.csrfs.admin, ...fields },
    { cookie: c.cookies.admin },
  );
}

describe("GET /tokens", () => {
  test("Owner and Admin see both tables in api order with every column", async () => {
    const revoked = adminToken({
      id: "tok_de4d00000000000000000005",
      name: "old",
      revokedAt: START - 5000,
    });
    const expired = adminToken({
      id: "tok_e0e000000000000000000006",
      name: "gone",
      expiresAt: START - 1000,
    });
    const api = tokenApi([self, ops, probe, revoked, other, expired]);
    const c = await tokensConsole(api);
    for (const role of ["owner", "admin"] as const) {
      const res = await getPage(c, "/tokens", c.cookies[role]);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = res.body;
      const active = body.slice(
        body.indexOf("<h2>Active</h2>"),
        body.indexOf("<h2>Revoked or expired</h2>"),
      );
      expect(active.indexOf(SELF_ID)).toBeLessThan(active.indexOf(OPS_ID));
      expect(active.indexOf(OPS_ID)).toBeLessThan(active.indexOf(OTHER_ID));
      expect(active).not.toContain("probe eu");
      const inactive = body.slice(body.indexOf("<h2>Revoked or expired</h2>"));
      expect(inactive).toContain("Revoked 1970-01-01 02:29:55 UTC");
      expect(inactive).toContain("Expired 1970-01-01 02:29:59 UTC");
      expect(inactive).not.toContain('href="/tokens/revoke');
      expect(body).toContain("<td>Manage checks</td>");
      expect(body).toContain("<td>Imported from a token file</td>");
      expect(body).toContain("<td>Created in pulse-api</td>");
      expect(body).toContain("<td>Never</td>");
      expect(body).toContain("<td>Active</td>");
      expect(body).toContain('Probe tokens are on the <a href="/probes">Probes page</a> (1).');
      expect(body).toContain("<strong>This console</strong>");
      expect(body).not.toContain(`/tokens/rotate?id=${SELF_ID}`);
      expect(body).not.toContain(`/tokens/revoke?id=${SELF_ID}`);
      expect(body).toContain(`href="/tokens/rotate?id=${OPS_ID}"`);
      expect(body).toContain(`href="/tokens/revoke?id=${OTHER_ID}"`);
      expect(body).toContain('href="/tokens/new"');
    }
    expect(api.seen.every((s) => s.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  test("the empty list has a create action", async () => {
    const c = await tokensConsole(tokenApi([]));
    const res = await getPage(c, "/tokens", c.cookies.admin);
    expect(res.body).toContain("No tokens");
    expect(res.body).toContain('<a href="/tokens/new">Create a token</a>');
  });

  test("a token with the console's name but another id is not protected", async () => {
    const twin = adminToken({ id: OTHER_ID, name: "console" });
    const c = await tokensConsole(tokenApi([self, twin, ops]));
    const res = await getPage(c, "/tokens", c.cookies.admin);
    expect(res.body).toContain(`href="/tokens/revoke?id=${OTHER_ID}"`);
    const open = await openChange(c, "revoke", OTHER_ID);
    expect(open.page.status).toBe(200);
  });

  test("the last active admin token has no Revoke and its expiry is a banner", async () => {
    const expiredSelf = selfToken({ expiresAt: START - 1 });
    const last = adminToken({ expiresAt: START + 86_400_000 });
    const api = tokenApi([expiredSelf, last, other], expiredSelf);
    const c = await tokensConsole(api);
    const res = await getPage(c, "/tokens", c.cookies.admin);
    expect(res.body).toContain("Last active admin token: it cannot be revoked.");
    expect(res.body).not.toContain(`href="/tokens/revoke?id=${OPS_ID}"`);
    expect(res.body).toContain(
      "The last active admin token expires at 1970-01-02 02:30:00 UTC. After that nobody can manage pulse-api tokens.",
    );
    const get = await getPage(c, `/tokens/revoke?id=${OPS_ID}`, c.cookies.admin);
    expect(get.status).toBe(409);
    expect(get.body).not.toContain('<form method="post" action="/tokens');
    const token = (await openChange(c, "revoke", OTHER_ID)).formToken;
    const revision = (await openChange(c, "rotate", OPS_ID)).revision;
    const forged = await postChange(c, "revoke", OPS_ID, {
      form_token: token,
      revision,
      confirm_name: "ops",
    });
    expect(forged.status).toBe(409);
    expect(forged.body).toContain("Last active admin token: it cannot be revoked.");
    expect(writes(api)).toEqual([]);
  });
});

describe("roles", () => {
  for (const role of ["member", "viewer"] as const) {
    test(`${role} gets 403 on every GET and forged POST, with 0 writes`, async () => {
      const api = tokenApi([self, ops]);
      const c = await tokensConsole(api);
      for (const path of [
        "/tokens",
        "/tokens/new",
        `/tokens/rotate?id=${OPS_ID}`,
        `/tokens/revoke?id=${OPS_ID}`,
      ]) {
        expect((await getPage(c, path, c.cookies[role])).status).toBe(403);
      }
      for (const path of [
        "/tokens/new",
        `/tokens/rotate?id=${OPS_ID}`,
        `/tokens/revoke?id=${OPS_ID}`,
      ]) {
        const res = await postForm(
          c,
          path,
          {
            csrf: c.csrfs[role],
            form_token: "x",
            name: "n",
            preset: "read",
            revision: "r",
            confirm_name: "ops",
          },
          { cookie: c.cookies[role] },
        );
        expect(res.status).toBe(403);
      }
      expect(writes(api)).toEqual([]);
      expect(api.seen).toEqual([]);
    });
  }

  test("navigation shows Tokens to Admin and Owner only, never Probes", async () => {
    const c = await tokensConsole(tokenApi([self]));
    for (const role of ["owner", "admin"] as const) {
      const res = await getPage(c, "/tokens", c.cookies[role]);
      expect(res.body).toContain('href="/tokens" aria-current="page"');
      expect(res.body).not.toContain('href="/probes"></a>');
    }
    const member = await getPage(c, "/checks", c.cookies.member);
    expect(member.body).not.toContain('href="/tokens"');
  });
});

describe("POST /tokens/new", () => {
  const presets: Array<[string, string[]]> = [
    ["read", ["read"]],
    ["checks", ["read", "checks", "admin"]],
    ["incidents", ["read", "incidents", "admin"]],
    ["full", ["read", "checks", "incidents", "admin"]],
  ];
  for (const [preset, scopes] of presets) {
    test(`preset ${preset} sends exactly its scopes and no expiresAt`, async () => {
      const api = tokenApi([self]);
      const row = adminToken({
        id: OTHER_ID,
        name: "new one",
        scopes: scopes as TokenMetadata["scopes"],
      });
      api.replyTo("POST", "/admin/tokens", created(row));
      const c = await tokensConsole(api);
      const res = await postNew(c, { name: "  new one ", preset });
      expect(res.status).toBe(200);
      const post = api.seen.filter((s) => s.method === "POST");
      expect(post).toHaveLength(1);
      expect(JSON.parse(post[0]?.body ?? "")).toEqual({ name: "new one", scopes });
      expect(post[0]?.headers["content-type"]).toBe("application/json");
    });
  }

  test("create shows the secret once, no-store, and logs a People row without it", async () => {
    const api = tokenApi([self]);
    api.replyTo("POST", "/admin/tokens", created(adminToken({ id: OTHER_ID, name: "ci" })));
    const c = await tokensConsole(api);
    const res = await postNew(c, { name: "ci", preset: "checks" }, "owner");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toContain(`<pre id="token-secret" data-secret>${FAKE_SECRET}</pre>`);
    expect(res.body).toContain(
      '<button type="button" data-copy="token-secret" hidden>Copy</button>',
    );
    expect(res.body).toContain(
      "Copy it now. pulse-api keeps only a hash: this is the only time it is shown.",
    );
    expect(res.body).toContain("<h1>Token created</h1>");
    expect(res.body).toContain('<a href="/tokens">Back to Tokens</a>');
    expect(res.body).not.toContain("data-countdown");
    const rows = c.db
      .query(
        "SELECT action, target_kind, target_id, target_name, value FROM people_events WHERE action LIKE 'token.%'",
      )
      .all();
    expect(rows).toEqual([
      {
        action: "token.create",
        target_kind: "token",
        target_id: null,
        target_name: OTHER_ID,
        value: "scopes=read,checks,admin",
      },
    ]);
    const after = await getPage(c, "/tokens", c.cookies.owner);
    expect(after.body).not.toContain("pulse_");
  });

  test("a replayed create answers Already submitted with 1 api write", async () => {
    const api = tokenApi([self]);
    api.replyTo("POST", "/admin/tokens", created(adminToken({ id: OTHER_ID })));
    const c = await tokensConsole(api);
    const page = await getPage(c, "/tokens/new", c.cookies.admin);
    const fields = {
      csrf: c.csrfs.admin,
      form_token: formTokenOf(page.body, "/tokens/new"),
      name: "x",
      preset: "read",
    };
    expect((await postForm(c, "/tokens/new", fields, { cookie: c.cookies.admin })).status).toBe(
      200,
    );
    const again = await postForm(c, "/tokens/new", fields, { cookie: c.cookies.admin });
    expect(again.status).toBe(409);
    expect(again.body).toContain("Already submitted");
    expect(again.body).not.toContain(FAKE_SECRET);
    expect(writes(api)).toEqual(["POST /admin/tokens"]);
  });

  const bad: Array<[string, Record<string, string>]> = [
    ["no preset", { name: "x" }],
    ["preset admin", { name: "x", preset: "admin" }],
    ["empty name", { name: "  ", preset: "read" }],
    ["long name", { name: "n".repeat(101), preset: "read" }],
    ["control name", { name: "a\u0007b", preset: "read" }],
  ];
  for (const [label, fields] of bad) {
    test(`${label} answers 422 with 0 writes`, async () => {
      const api = tokenApi([self]);
      const c = await tokensConsole(api);
      const res = await postNew(c, fields);
      expect(res.status).toBe(422);
      expect(res.body).toContain("There is a problem");
      expect(writes(api)).toEqual([]);
    });
  }

  test("grant: a console token [read, admin] disables the scope presets and refuses full", async () => {
    const weak = selfToken({ scopes: ["read", "admin"] });
    const api = tokenApi([weak], weak);
    const c = await tokensConsole(api);
    const form = await getPage(c, "/tokens/new", c.cookies.admin);
    expect(form.body).toContain('value="read"> Read');
    expect(form.body).toContain('value="checks" disabled>');
    expect(form.body).toContain('value="incidents" disabled>');
    expect(form.body).toContain('value="full" disabled>');
    expect(form.body).toContain("The console token lacks checks.");
    expect(form.body).toContain("The console token lacks incidents.");
    expect(form.body).toContain(
      "Can also create, rotate and revoke tokens with the same or fewer scopes, and read the audit log.",
    );
    const res = await postNew(c, { name: "x", preset: "full" });
    expect(res.status).toBe(422);
    expect(res.body).toContain("The console token lacks checks.");
    expect(writes(api)).toEqual([]);
  });

  test("an answer 201 with an unreadable body is the lost answer, logged as unknown", async () => {
    const api = tokenApi([self]);
    api.replyTo("POST", "/admin/tokens", { status: 201, body: "{}", headers: WIRE_HEADERS });
    const c = await tokensConsole(api);
    const res = await postNew(c, { name: "x", preset: "read" });
    expect(res.status).toBe(502);
    expect(res.body).toContain("pulse-api made the change, but its answer could not be read");
    expect(writes(api)).toEqual(["POST /admin/tokens"]);
    const row = c.db
      .query<{ value: string; target_name: string }, []>(
        "SELECT value, target_name FROM people_events WHERE action = 'token.create'",
      )
      .get();
    expect(row).toEqual({ value: "scopes=read (unknown)", target_name: "unknown" });
  });

  const outcomes: Array<[string, FakeReply, number, string]> = [
    [
      "api 422",
      { status: 422, body: JSON.stringify({ error: "name taken" }), headers: WIRE_HEADERS },
      422,
      "name taken",
    ],
    [
      "api 401",
      { status: 401, body: JSON.stringify({ error: "x" }), headers: WIRE_HEADERS },
      502,
      "pulse-api rejected the console token",
    ],
    [
      "api 403",
      { status: 403, body: JSON.stringify({ error: "x" }), headers: WIRE_HEADERS },
      502,
      "pulse-api refused: the console token lacks a scope this token holds.",
    ],
    [
      "api 429",
      { status: 429, body: JSON.stringify({ error: "x" }), headers: WIRE_HEADERS },
      503,
      "pulse-api is throttling the console. Try again in a minute.",
    ],
    [
      "api 500",
      { status: 500, body: JSON.stringify({ error: "x" }), headers: WIRE_HEADERS },
      502,
      "pulse-api refused the request (500). Nothing was changed.",
    ],
    [
      "wire mismatch",
      {
        status: 201,
        body: "{}",
        headers: { "x-pulse-contract": "9", "content-type": "application/json" },
      },
      502,
      "The result is unknown.",
    ],
    [
      "redirect",
      { status: 302, body: "", headers: { location: "http://example.com/" } },
      502,
      "The result is unknown.",
    ],
  ];
  for (const [label, reply, status, text] of outcomes) {
    test(`${label} answers ${status}`, async () => {
      const api = tokenApi([self]);
      api.replyTo("POST", "/admin/tokens", reply);
      const c = await tokensConsole(api);
      const res = await postNew(c, { name: "x", preset: "read" });
      expect(res.status).toBe(status);
      expect(res.body).toContain(text);
      expect(res.body).not.toContain("Saved in pulse-api.");
      expect(writes(api)).toEqual(["POST /admin/tokens"]);
    });
  }

  test("a held create times out after 5000 ms with the unknown text", async () => {
    const api = tokenApi([self]);
    api.replyTo("POST", "/admin/tokens", { status: 201, isHeld: true });
    const timers: Array<() => void> = [];
    const c = await startTeamConsole({
      apiUrl: api.url,
      adminToken: TOKEN,
      schedule: (fn) => {
        timers.push(fn);
        return () => undefined;
      },
    });
    cleanups.push(() => c.close());
    const form = await getPage(c, "/tokens/new", c.cookies.admin);
    const pending = postForm(
      c,
      "/tokens/new",
      {
        csrf: c.csrfs.admin,
        form_token: formTokenOf(form.body, "/tokens/new"),
        name: "x",
        preset: "read",
      },
      { cookie: c.cookies.admin },
    );
    while (!api.seen.some((s) => s.method === "POST")) await Bun.sleep(1);
    // The reads are done; firing every timer only cuts the held write.
    for (const fire of timers.splice(0)) fire();
    const res = await pending;
    expect(res.status).toBe(504);
    expect(res.body).toContain("The result is unknown.");
    expect(writes(api)).toEqual(["POST /admin/tokens"]);
  });
});

describe("self failures", () => {
  const failures: Array<[string, FakeReply, string]> = [
    ["404", { status: 404, headers: WIRE_HEADERS, body: "{}" }, "pulse-api answered 404"],
    ["invalid", jsonReply({ id: "x" }), "pulse-api answered with an invalid body"],
    [
      "wire",
      {
        status: 200,
        body: JSON.stringify(self),
        headers: { "x-pulse-contract": "9", "content-type": "application/json" },
      },
      "pulse-api answered with wire version 9",
    ],
  ];
  for (const [label, reply, reason] of failures) {
    test(`self ${label} removes every action and every mutation answers 503 with 0 writes`, async () => {
      const api = tokenApi([self, ops]);
      const c = await tokensConsole(api);
      const open = await openChange(c, "rotate", OPS_ID);
      api.reply("/admin/tokens/self", reply);
      const list = await getPage(c, "/tokens", c.cookies.admin);
      expect(list.status).toBe(200);
      expect(list.body).toContain(
        `The console cannot tell which token it uses (${reason}). Changes are off until it can. pulse-api needs GET /admin/tokens/self.`,
      );
      expect(list.body).toContain(OPS_ID);
      expect(list.body).not.toContain('href="/tokens/new"');
      expect(list.body).not.toContain('href="/tokens/rotate');
      expect(list.body).not.toContain('href="/tokens/revoke');
      for (const path of [
        "/tokens/new",
        `/tokens/rotate?id=${OPS_ID}`,
        `/tokens/revoke?id=${OPS_ID}`,
      ]) {
        const form = await getPage(c, path, c.cookies.admin);
        expect(form.body).not.toContain('<form method="post" action="/tokens');
      }
      const res = await postChange(c, "rotate", OPS_ID, {
        form_token: open.formToken,
        revision: open.revision,
      });
      expect(res.status).toBe(503);
      expect(res.body).toContain("The console cannot tell which token it uses");
      expect(writes(api)).toEqual([]);
    });
  }

  test("self unreachable gives the banner too", async () => {
    const api = tokenApi([self]);
    const c = await tokensConsole(api);
    api.reply("/admin/tokens/self", {
      status: 200,
      isHeld: false,
      body: "not json",
      headers: WIRE_HEADERS,
    });
    const list = await getPage(c, "/tokens", c.cookies.admin);
    expect(list.body).toContain("The console cannot tell which token it uses");
  });

  test("self 401 shows the token-rejected banner and no actions", async () => {
    const api = tokenApi([self, ops]);
    api.reply("/admin/tokens/self", { status: 401, body: "{}", headers: WIRE_HEADERS });
    const c = await tokensConsole(api);
    const list = await getPage(c, "/tokens", c.cookies.admin);
    expect(list.body).toContain("pulse-api rejected the console token");
    expect(list.body).not.toContain('href="/tokens/rotate');
  });
});

describe("rotate and revoke", () => {
  test("rotate shows the new secret and the countdown of the returned deadline", async () => {
    const api = tokenApi([self, ops]);
    const until = START + 59_000;
    api.replyTo("POST", `/admin/tokens/${OPS_ID}/rotate`, {
      status: 200,
      body: JSON.stringify({
        token: adminToken({ rotatedAt: START, previousValidUntil: until }),
        secret: ROTATED_SECRET,
        previousValidUntil: until,
      }),
      headers: WIRE_HEADERS,
    });
    const c = await tokensConsole(api);
    const open = await openChange(c, "rotate", OPS_ID);
    expect(open.page.status).toBe(200);
    const res = await postChange(c, "rotate", OPS_ID, {
      form_token: open.formToken,
      revision: open.revision,
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("<h1>Token rotated</h1>");
    expect(res.body).toContain(`<pre id="token-secret" data-secret>${ROTATED_SECRET}</pre>`);
    expect(res.body).toContain(
      'The old secret keeps working until 1970-01-01 02:30:59 UTC (<time data-countdown datetime="1970-01-01T02:30:59.000Z">00:59</time> left). Replace it everywhere before then.',
    );
    const post = api.seen.find((s) => s.method === "POST");
    expect(post?.body).toBe("{}");
    expect(writes(api)).toEqual([`POST /admin/tokens/${OPS_ID}/rotate`]);
  });

  test("rotate with a null deadline says the old secret no longer works", async () => {
    const api = tokenApi([self, ops]);
    api.replyTo("POST", `/admin/tokens/${OPS_ID}/rotate`, {
      status: 200,
      body: JSON.stringify({ token: ops, secret: ROTATED_SECRET, previousValidUntil: null }),
      headers: WIRE_HEADERS,
    });
    const c = await tokensConsole(api);
    const open = await openChange(c, "rotate", OPS_ID);
    const res = await postChange(c, "rotate", OPS_ID, {
      form_token: open.formToken,
      revision: open.revision,
    });
    expect(res.body).toContain("The old secret no longer works.");
    expect(res.body).not.toContain("data-countdown");
  });

  test("revoke with the typed name redirects with the notice", async () => {
    const api = tokenApi([self, ops, other]);
    api.replyTo("POST", `/admin/tokens/${OTHER_ID}/revoke`, jsonReply({ token: other }));
    const c = await tokensConsole(api);
    const open = await openChange(c, "revoke", OTHER_ID);
    const wrong = await postChange(c, "revoke", OTHER_ID, {
      form_token: open.formToken,
      revision: open.revision,
      confirm_name: "Deploy",
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body).toContain("The name does not match.");
    const again = formTokenOf(wrong.body, `/tokens/revoke?id=${OTHER_ID}`);
    const res = await postChange(c, "revoke", OTHER_ID, {
      form_token: again,
      revision: open.revision,
      confirm_name: " deploy ",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/tokens?revoked=${OTHER_ID}`);
    const list = await getPage(c, res.headers.get("location") ?? "", c.cookies.admin);
    expect(list.body).toContain(`Revoked deploy (${OTHER_ID}).`);
    expect(writes(api)).toEqual([`POST /admin/tokens/${OTHER_ID}/revoke`]);
    const row = c.db
      .query("SELECT action, target_name, value FROM people_events WHERE action = 'token.revoke'")
      .get();
    expect(row).toEqual({ action: "token.revoke", target_name: OTHER_ID, value: "scopes=read" });
  });

  test("an api 409 shows the confirmation again with its message, never Revoked", async () => {
    const api = tokenApi([self, ops, other]);
    api.replyTo("POST", `/admin/tokens/${OTHER_ID}/revoke`, {
      status: 409,
      body: JSON.stringify({ error: "cannot revoke the last active admin token" }),
      headers: WIRE_HEADERS,
    });
    const c = await tokensConsole(api);
    const open = await openChange(c, "revoke", OTHER_ID);
    const res = await postChange(c, "revoke", OTHER_ID, {
      form_token: open.formToken,
      revision: open.revision,
      confirm_name: "deploy",
    });
    expect(res.status).toBe(409);
    expect(res.body).toContain("cannot revoke the last active admin token");
    expect(res.body).toContain('<form method="post" action="/tokens/revoke');
    expect(res.body).not.toContain("Revoked deploy");
  });

  for (const change of ["rotate", "revoke"] as const) {
    test(`own token: GET ${change} has no form and a forged POST answers 409 with 0 writes`, async () => {
      const api = tokenApi([self, ops]);
      const c = await tokensConsole(api);
      const own = await getPage(c, `/tokens/${change}?id=${SELF_ID}`, c.cookies.admin);
      expect(own.status).toBe(409);
      expect(own.body).toContain("This is the console&#39;s own token. Nothing was changed.");
      expect(own.body).not.toContain('<form method="post" action="/tokens');
      const open = await openChange(c, change, OPS_ID);
      const forged = await postForm(
        c,
        `/tokens/${change}?id=${SELF_ID}`,
        {
          csrf: c.csrfs.admin,
          form_token: open.formToken,
          revision: open.revision,
          confirm_name: "console",
        },
        { cookie: c.cookies.admin },
      );
      expect(forged.status).toBe(409);
      expect(forged.body).toContain("This is the console&#39;s own token. Nothing was changed.");
      expect(writes(api)).toEqual([]);
    });

    test(`${change} of a probe token or unknown id is not found`, async () => {
      const api = tokenApi([self, probe]);
      const c = await tokensConsole(api);
      expect((await getPage(c, `/tokens/${change}?id=${probe.id}`, c.cookies.admin)).status).toBe(
        404,
      );
      expect((await getPage(c, `/tokens/${change}?id=tok_missing`, c.cookies.admin)).status).toBe(
        404,
      );
      expect((await getPage(c, `/tokens/${change}?id=self`, c.cookies.admin)).status).toBe(404);
      expect(writes(api)).toEqual([]);
    });

    test(`GET ${change} of a revoked or expired token answers 409 without a form`, async () => {
      const revoked = adminToken({ revokedAt: START - 1 });
      const api = tokenApi([self, revoked]);
      const c = await tokensConsole(api);
      const res = await getPage(c, `/tokens/${change}?id=${OPS_ID}`, c.cookies.admin);
      expect(res.status).toBe(409);
      expect(res.body).toContain("This token is already revoked or expired.");
      expect(res.body).not.toContain('<form method="post" action="/tokens');
    });
  }

  test("revoked between GET and POST is stale (step 5 before step 6), 0 writes", async () => {
    const api = tokenApi([self, ops, other]);
    const c = await tokensConsole(api);
    const open = await openChange(c, "revoke", OTHER_ID);
    api.setTokens([self, ops, { ...other, revokedAt: START }]);
    const res = await postChange(c, "revoke", OTHER_ID, {
      form_token: open.formToken,
      revision: open.revision,
      confirm_name: "deploy",
    });
    expect(res.status).toBe(409);
    expect(res.body).toContain("Changed since you opened it");
    expect(res.body).not.toContain("This token is already revoked or expired.");
    expect(writes(api)).toEqual([]);
  });

  test("expired between GET and POST with the shown revision is inactive, 0 writes", async () => {
    const soon = { ...other, expiresAt: START + 1000 };
    const api = tokenApi([self, ops, soon]);
    const c = await tokensConsole(api);
    const open = await openChange(c, "rotate", OTHER_ID);
    expect(open.page.status).toBe(200);
    c.setNow(START + 2000);
    const res = await postChange(c, "rotate", OTHER_ID, {
      form_token: open.formToken,
      revision: open.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body).toContain("This token is already revoked or expired.");
    expect(writes(api)).toEqual([]);
  });

  test("a forged POST with the revoked row's revision is inactive, 0 writes", async () => {
    const api = tokenApi([self, ops, other]);
    const c = await tokensConsole(api);
    const form = await openChange(c, "revoke", OTHER_ID);
    const revoked = { ...other, revokedAt: START };
    api.setTokens([self, ops, revoked]);
    api.reply("/admin/tokens/self", jsonReply(self));
    // The revision of the revoked row, as the server computes it (SHA-256 of the 7 fields).
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(
      JSON.stringify([
        revoked.id,
        revoked.name,
        revoked.scopes,
        revoked.location,
        revoked.expiresAt,
        revoked.revokedAt,
        revoked.rotatedAt,
      ]),
    );
    const res = await postChange(c, "revoke", OTHER_ID, {
      form_token: form.formToken,
      revision: hasher.digest("hex"),
      confirm_name: "deploy",
    });
    expect(res.status).toBe(409);
    expect(res.body).toContain("This token is already revoked or expired.");
    expect(writes(api)).toEqual([]);
  });

  test("lastUsedAt and previousValidUntil changes never make the confirmation stale", async () => {
    const api = tokenApi([self, ops]);
    api.replyTo("POST", `/admin/tokens/${OPS_ID}/rotate`, {
      status: 200,
      body: JSON.stringify({ token: ops, secret: ROTATED_SECRET, previousValidUntil: null }),
      headers: WIRE_HEADERS,
    });
    const c = await tokensConsole(api);
    const open = await openChange(c, "rotate", OPS_ID);
    api.setTokens([self, { ...ops, lastUsedAt: START, previousValidUntil: START + 1000 }]);
    const res = await postChange(c, "rotate", OPS_ID, {
      form_token: open.formToken,
      revision: open.revision,
    });
    expect(res.status).toBe(200);
  });

  test("grant: rotating a token whose scopes the console lacks answers 403, 0 writes", async () => {
    const weak = selfToken({ scopes: ["read", "admin"] });
    const api = tokenApi([weak, ops], weak);
    const c = await tokensConsole(api);
    const open = await openChange(c, "rotate", OPS_ID);
    const res = await postChange(c, "rotate", OPS_ID, {
      form_token: open.formToken,
      revision: open.revision,
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("The console token lacks checks.");
    expect(writes(api)).toEqual([]);
  });

  test("the role lowered between GET and POST: 403 with 0 writes", async () => {
    const api = tokenApi([self, ops]);
    const c = await tokensConsole(api);
    const open = await openChange(c, "rotate", OPS_ID);
    c.db.run("UPDATE users SET role = 'member' WHERE id = ?", [c.ids.admin]);
    const res = await postChange(c, "rotate", OPS_ID, {
      form_token: open.formToken,
      revision: open.revision,
    });
    expect(res.status).toBe(403);
    expect(writes(api)).toEqual([]);
  });

  test("a People insert failure after a confirmed revoke adds the not-logged text", async () => {
    const api = tokenApi([self, ops, other]);
    api.replyTo("POST", `/admin/tokens/${OTHER_ID}/revoke`, jsonReply({ token: other }));
    const c = await tokensConsole(api);
    const open = await openChange(c, "revoke", OTHER_ID);
    c.db.run("DROP TABLE people_events");
    const res = await postChange(c, "revoke", OTHER_ID, {
      form_token: open.formToken,
      revision: open.revision,
      confirm_name: "deploy",
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("Saved in pulse-api. The People log row could not be written.");
    expect(c.logs.some((l) => l.includes("token change not logged"))).toBe(true);
  });
});

describe("secrets", () => {
  test("no secret in the database, events, logs, metrics or later pages", async () => {
    const api = tokenApi([self, ops]);
    api.replyTo("POST", "/admin/tokens", created(adminToken({ id: OTHER_ID })));
    api.replyTo("POST", `/admin/tokens/${OPS_ID}/rotate`, {
      status: 200,
      body: JSON.stringify({
        token: ops,
        secret: ROTATED_SECRET,
        previousValidUntil: START + 600_000,
      }),
      headers: WIRE_HEADERS,
    });
    const c = await tokensConsole(api);
    expect((await postNew(c, { name: "x", preset: "read" })).body).toContain(FAKE_SECRET);
    const open = await openChange(c, "rotate", OPS_ID);
    const rotated = await postChange(c, "rotate", OPS_ID, {
      form_token: open.formToken,
      revision: open.revision,
    });
    expect(rotated.body).toContain("10:00</time> left");
    const file = c.db.filename;
    c.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const bytes = readFileSync(file).toString("latin1");
    const metrics = await (await fetch(`${c.base}/metrics`)).text();
    const later = await getPage(c, "/tokens", c.cookies.admin);
    const events = JSON.stringify(c.db.query("SELECT * FROM people_events").all());
    for (const secret of [FAKE_SECRET, ROTATED_SECRET, TOKEN]) {
      for (const text of [bytes, metrics, later.body, events, c.logs.join("\n")]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
