import { afterEach, describe, expect, test } from "bun:test";
import { escapeHtml } from "@lorenzh/pulse-kit";
import { checkConfig, checkStates, REVISION } from "../test/check-fixtures.ts";
import {
  type FakeApi,
  type FakeReply,
  jsonReply,
  startFakeApi,
  WIRE_HEADERS,
} from "../test/fake-api.ts";
import { expectCalloutsOnly } from "../test/rendered-audit.ts";
import {
  formTokenOf,
  getPage,
  postForm,
  type Reply,
  type SignedInOptions,
} from "../test/signed-in-console.ts";
import { startTeamConsole, type TeamConsole } from "../test/team-console.ts";
import type { ConsoleRole } from "./roles.ts";

const TOKEN = "checks-write-admin-token-sentinel-0123456789";
const HEADER_SECRET = "literal-header-value-sentinel";
const BODY_SECRET = "request-body-sentinel";
const HEARTBEAT_SECRET = "heartbeatSecretSentinel01";
const REV_A = "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACTION = "/checks/new?type=http";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function fakeApi(): FakeApi {
  const api = startFakeApi();
  cleanups.push(() => api.stop());
  api.reply("/admin/config", jsonReply(checkConfig));
  api.reply("/checks", jsonReply(checkStates));
  return api;
}

async function teamConsole(
  api: FakeApi,
  options: Partial<Omit<SignedInOptions, "prepare" | "roleOf">> = {},
): Promise<TeamConsole> {
  const c = await startTeamConsole({ apiUrl: api.url, adminToken: TOKEN, ...options });
  cleanups.push(() => c.close());
  return c;
}

const HTTP_FIELDS: Record<string, string> = {
  type: "http",
  revision: "",
  id: "new-web",
  name: "New web",
  url: "https://example.com/",
  method: "GET",
  interval_ms: "60000",
};

async function openCreate(c: TeamConsole, role: ConsoleRole, type = "http"): Promise<string> {
  const page = await getPage(c, `/checks/new?type=${type}`, c.cookies[role]);
  expect(page.status).toBe(200);
  return formTokenOf(page.body, `/checks/new?type=${type}`);
}

async function create(
  c: TeamConsole,
  fields: Record<string, string>,
  role: ConsoleRole = "member",
): Promise<Reply> {
  const token = await openCreate(c, role, fields.type ?? "http");
  return postForm(
    c,
    `/checks/new?type=${fields.type ?? "http"}`,
    { csrf: c.csrfs[role], form_token: token, ...fields },
    { cookie: c.cookies[role] },
  );
}

function writes(api: FakeApi): string[] {
  return api.seen.filter((s) => s.method !== "GET").map((s) => `${s.method} ${s.rawPath}`);
}

type PeopleRow = { action: string; target_kind: string; target_id: null; target_name: string };

function peopleRows(c: TeamConsole): Array<PeopleRow & { value: string }> {
  return c.db
    .query<PeopleRow & { value: string }, []>(
      "SELECT action, target_kind, target_id, target_name, value FROM people_events WHERE action LIKE 'check.%' ORDER BY id",
    )
    .all();
}

function row(value: string): PeopleRow & { value: string } {
  return {
    action: "check.create",
    target_kind: "check",
    target_id: null,
    target_name: "new-web",
    value,
  };
}

describe("GET /checks/new", () => {
  test("without a type shows the six choices", async () => {
    const c = await teamConsole(fakeApi());
    const res = await getPage(c, "/checks/new", c.cookies.member);
    expect(res.status).toBe(200);
    const labels = {
      http: "HTTP",
      tls: "TLS",
      tcp: "TCP",
      dns: "DNS",
      domain: "Domain",
      heartbeat: "Heartbeat",
    };
    for (const [type, label] of Object.entries(labels)) {
      expect(res.body).toContain(
        `<li class="panel"><a href="/checks/new?type=${type}">${label}</a>: `,
      );
    }
    expectCalloutsOnly(res.body);
    const unknown = await getPage(c, "/checks/new?type=ftp", c.cookies.member);
    expect(unknown.body).toContain('<a href="/checks/new?type=heartbeat">');
    expect(unknown.body).not.toContain('<form method="post" action="/checks/new');
  });

  test("with a type shows its form and sends no api request", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await getPage(c, "/checks/new?type=tls", c.cookies.member);
    expect(res.status).toBe(200);
    expect(res.body).toContain('action="/checks/new?type=tls"');
    expect(res.body).toContain('<input type="hidden" name="type" value="tls">');
    expect(api.seen).toEqual([]);
  });
});

describe("roles of /checks/new", () => {
  const cases: Array<[ConsoleRole, number]> = [
    ["viewer", 403],
    ["member", 200],
    ["admin", 200],
    ["owner", 200],
  ];
  for (const [role, status] of cases) {
    test(`${role} GET and HEAD answer ${status}`, async () => {
      const c = await teamConsole(fakeApi());
      expect((await getPage(c, "/checks/new?type=http", c.cookies[role])).status).toBe(status);
      const head = await fetch(`${c.base}/checks/new?type=http`, {
        method: "HEAD",
        headers: { cookie: c.cookies[role] },
      });
      expect(head.status).toBe(status);
    });
  }

  test("a viewer POST answers 403 and reaches no api", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await postForm(
      c,
      ACTION,
      { csrf: c.csrfs.viewer, form_token: "x", ...HTTP_FIELDS },
      { cookie: c.cookies.viewer },
    );
    expect(res.status).toBe(403);
    expect(api.seen).toEqual([]);
  });

  for (const role of ["member", "owner"] as const) {
    test(`a ${role} POST creates the check`, async () => {
      const api = fakeApi();
      api.replyTo("POST", "/admin/checks", {
        status: 201,
        body: "{}",
        headers: { ...WIRE_HEADERS, etag: `"${REV_A}"` },
      });
      const c = await teamConsole(api);
      const res = await create(c, HTTP_FIELDS, role);
      expect(res.status).toBe(303);
      expect(writes(api)).toEqual(["POST /admin/checks"]);
    });
  }
});

describe("POST /checks/new", () => {
  test("saves: If-Match of the fresh read, 303 to the detail, one People row", async () => {
    const api = fakeApi();
    api.replyTo("POST", "/admin/checks", {
      status: 201,
      body: "{}",
      headers: { ...WIRE_HEADERS, etag: `"${REV_A}"` },
    });
    api.reply("/uptime", jsonReply([]));
    const c = await teamConsole(api);
    const res = await create(c, HTTP_FIELDS);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/checks/check?id=new-web&saved=1");
    const post = api.seen.find((s) => s.method === "POST");
    expect(post?.headers["if-match"]).toBe(`"${REVISION}"`);
    expect(post?.headers["content-type"]).toBe("application/json");
    expect(post?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(post?.body ?? "")).toEqual({
      id: "new-web",
      name: "New web",
      url: "https://example.com/",
      method: "GET",
      intervalMs: 60000,
    });
    expect(api.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "GET /admin/config",
      "POST /admin/checks",
    ]);
    expect(peopleRows(c)).toEqual([row(REV_A)]);
    const info = c.logs.filter((line) => line.includes('"check change"'));
    expect(info).toHaveLength(1);
    expect(JSON.parse(info[0] ?? "{}")).toMatchObject({
      action: "check.create",
      checkId: "new-web",
      outcome: "saved",
      actorId: c.ids.member,
    });
  });

  test("the detail page after a save says Check saved.", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await getPage(c, "/checks/check?id=web&saved=1", c.cookies.member);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<section class="callout callout-success" role="status">');
    expect(res.body).toContain("<p>Check saved.</p>");
  });

  test("an existing id answers 409 at the id field without a write", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await create(c, { ...HTTP_FIELDS, id: "web" });
    expect(res.status).toBe(409);
    expect(res.body).toContain("A check with this id exists.");
    expect(res.body).toContain('href="#field-id"');
    expect(writes(api)).toEqual([]);
  });

  test("a shadowed id also exists", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const shadowedId = checkConfig.shadowed[0]?.id ?? "";
    const res = await create(c, { ...HTTP_FIELDS, id: shadowedId });
    expect(res.status).toBe(409);
    expect(writes(api)).toEqual([]);
  });

  test("field errors answer 422 before any api request", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await create(c, { ...HTTP_FIELDS, id: "my check" });
    expect(res.status).toBe(422);
    expect(api.seen).toEqual([]);
  });

  test("free Accept and ACCEPT rows answer 422 at header_1_name with no request", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await create(c, {
      ...HTTP_FIELDS,
      header_0_name: "Accept",
      header_0_kind: "plain",
      header_0_value: "a",
      header_1_name: "ACCEPT",
      header_1_kind: "plain",
      header_1_value: "b",
    });
    expect(res.status).toBe(422);
    expect(res.body).toContain(
      escapeHtml("This header is already set in another row (names are compared without case)."),
    );
    expect(res.body).toContain('href="#field-header_1_name"');
    expect(api.seen.map((s) => `${s.method} ${s.path}`)).toEqual([]);
  });

  test("__proto__ is refused; __Proto__ and X-Proto are sent as own keys", async () => {
    const api = fakeApi();
    api.replyTo("POST", "/admin/checks", { status: 201, body: "{}", headers: WIRE_HEADERS });
    const c = await teamConsole(api);
    const refused = await create(c, {
      ...HTTP_FIELDS,
      header_0_name: "__proto__",
      header_0_kind: "plain",
      header_0_value: "x",
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toContain("__proto__ is not an allowed header name.");
    expect(writes(api)).toEqual([]);
    const sent = await create(c, {
      ...HTTP_FIELDS,
      header_0_name: "__Proto__",
      header_0_kind: "plain",
      header_0_value: "x",
      header_1_name: "X-Proto",
      header_1_kind: "plain",
      header_1_value: "y",
    });
    expect(sent.status).toBe(303);
    const post = api.seen.find((s) => s.method === "POST");
    expect(post?.body).toContain('"headers":{"__Proto__":"x","X-Proto":"y"}');
  });

  test("a 65536-byte body of 32768 'é' characters is saved", async () => {
    const api = fakeApi();
    api.replyTo("POST", "/admin/checks", { status: 201, body: "{}", headers: WIRE_HEADERS });
    const c = await teamConsole(api);
    const body = "é".repeat(32768);
    const res = await create(c, { ...HTTP_FIELDS, method: "POST", body });
    expect(res.status).toBe(303);
    const post = api.seen.find((s) => s.method === "POST");
    expect(JSON.parse(post?.body ?? "{}").body).toBe(body);
  });
});

describe("form size limits", () => {
  function sizedBody(c: TeamConsole, token: string, total: number): string {
    const head = new URLSearchParams({
      csrf: c.csrfs.member,
      form_token: token,
      type: "http",
      id: "",
    }).toString();
    const prefix = `${head}&pad=`;
    return prefix + "x".repeat(total - prefix.length);
  }

  function post(c: TeamConsole, path: string, body: string): Promise<Reply> {
    return fetch(c.base + path, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: c.cookies.member,
        origin: c.base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    }).then(async (res) => ({ status: res.status, headers: res.headers, body: await res.text() }));
  }

  test("524288 bytes reach the field checks; 524289 answer 413; no api request", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const token = await openCreate(c, "member");
    const fits = sizedBody(c, token, 524288);
    expect(fits).toHaveLength(524288);
    const ok = await post(c, ACTION, fits);
    expect(ok.status).toBe(422);
    const token2 = await openCreate(c, "member");
    const over = sizedBody(c, token2, 524289);
    const refused = await post(c, ACTION, over);
    expect(refused.status).toBe(413);
    expect(api.seen).toEqual([]);
  });

  test("other routes keep 8192: 9000 bytes to /team/invites answer 413", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await post(c, "/team/invites", `csrf=${c.csrfs.member}&pad=${"x".repeat(9000)}`);
    expect(res.status).toBe(413);
  });
});

describe("request guards of POST /checks/new", () => {
  test("missing CSRF, a foreign Origin and a repeated field never reach the api", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const token = await openCreate(c, "member");
    const noCsrf = await postForm(
      c,
      ACTION,
      { form_token: token, ...HTTP_FIELDS },
      { cookie: c.cookies.member },
    );
    expect(noCsrf.status).toBe(403);
    const foreign = await postForm(
      c,
      ACTION,
      { csrf: c.csrfs.member, form_token: token, ...HTTP_FIELDS },
      { cookie: c.cookies.member, origin: "http://evil.example" },
    );
    expect(foreign.status).toBe(403);
    const repeated = await fetch(c.base + ACTION, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: c.cookies.member,
        origin: c.base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `csrf=${c.csrfs.member}&form_token=${token}&id=a&id=b`,
    });
    expect(repeated.status).toBe(400);
    expect(api.seen).toEqual([]);
  });

  test("a replayed token answers 409 Already submitted with the create link", async () => {
    const api = fakeApi();
    api.replyTo("POST", "/admin/checks", { status: 201, body: "{}", headers: WIRE_HEADERS });
    const c = await teamConsole(api);
    const token = await openCreate(c, "member");
    const fields = { csrf: c.csrfs.member, form_token: token, ...HTTP_FIELDS };
    expect((await postForm(c, ACTION, fields, { cookie: c.cookies.member })).status).toBe(303);
    const again = await postForm(c, ACTION, fields, { cookie: c.cookies.member });
    expect(again.status).toBe(409);
    expect(again.body).toContain("Already submitted");
    expect(again.body).toContain('<a href="/checks/new">Open the page again</a>');
    expect(writes(api)).toEqual(["POST /admin/checks"]);
  });

  test("an expired token renders the posted type with kept non-secret input", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await postForm(
      c,
      "/checks/new?type=heartbeat",
      {
        csrf: c.csrfs.member,
        form_token: "expired",
        type: "heartbeat",
        id: "kept-id",
        name: "Kept name",
        period_ms: "60000",
        secret: HEARTBEAT_SECRET,
      },
      { cookie: c.cookies.member },
    );
    expect(res.status).toBe(409);
    expect(res.body).toContain("This form has expired.");
    expect(res.body).toContain('action="/checks/new?type=heartbeat"');
    expect(res.body).toContain('value="kept-id"');
    expect(res.body).toContain('value="Kept name"');
    expect(res.body).toContain("Not kept for safety: enter it again.");
    expect(res.body).not.toContain(HEARTBEAT_SECRET);
    expect(api.seen).toEqual([]);
  });

  test("an expired token with an unknown type shows the choices", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await postForm(
      c,
      ACTION,
      { csrf: c.csrfs.member, form_token: "expired", type: "ftp", id: "x" },
      { cookie: c.cookies.member },
    );
    expect(res.status).toBe(409);
    expect(res.body).toContain("This form has expired.");
    expect(res.body).toContain('<a href="/checks/new?type=dns">');
    expect(api.seen).toEqual([]);
  });

  test("session removed while the config read waits: 409 Not saved, no write", async () => {
    const api = fakeApi();
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    api.replyTo("GET", "/admin/config", { ...jsonReply(checkConfig), gate });
    const c = await teamConsole(api);
    const pending = create(c, HTTP_FIELDS);
    await api.received("/admin/config");
    c.db.run("DELETE FROM sessions WHERE user_id = ?", [c.ids.member]);
    open();
    const res = await pending;
    expect(res.status).toBe(409);
    expect(res.body).toContain("Not saved");
    expect(writes(api)).toEqual([]);
    expect(peopleRows(c)).toEqual([]);
  });

  test("stored role lowered while the config read waits: 403, no write", async () => {
    const api = fakeApi();
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    api.replyTo("GET", "/admin/config", { ...jsonReply(checkConfig), gate });
    const c = await teamConsole(api);
    const pending = create(c, HTTP_FIELDS);
    await api.received("/admin/config");
    c.db.run("UPDATE users SET role = 'viewer' WHERE id = ?", [c.ids.member]);
    open();
    const res = await pending;
    expect(res.status).toBe(403);
    expect(writes(api)).toEqual([]);
  });

  test("a failed config read answers 502 with the state and no write", async () => {
    const api = fakeApi();
    api.replyTo("GET", "/admin/config", { status: 503, headers: WIRE_HEADERS });
    const c = await teamConsole(api);
    const res = await create(c, HTTP_FIELDS);
    expect(res.status).toBe(502);
    expect(res.body).toContain("pulse-api answered 503.");
    expect(writes(api)).toEqual([]);
  });
});

describe("kept input on create failures before the write", () => {
  const gated = (): { api: ReturnType<typeof fakeApi>; open: () => void } => {
    const api = fakeApi();
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    api.replyTo("GET", "/admin/config", { ...jsonReply(checkConfig), gate });
    return { api, open: () => open() };
  };
  const cases: { name: string; status: number; run: () => Promise<Reply> }[] = [
    {
      name: "config read fails",
      status: 502,
      run: async () => {
        const api = fakeApi();
        api.replyTo("GET", "/admin/config", { status: 503, headers: WIRE_HEADERS });
        return create(await teamConsole(api), HTTP_FIELDS);
      },
    },
    {
      name: "session removed",
      status: 409,
      run: async () => {
        const { api, open } = gated();
        const c = await teamConsole(api);
        const pending = create(c, HTTP_FIELDS);
        await api.received("/admin/config");
        c.db.run("DELETE FROM sessions WHERE user_id = ?", [c.ids.member]);
        open();
        return pending;
      },
    },
    {
      name: "role lowered",
      status: 403,
      run: async () => {
        const { api, open } = gated();
        const c = await teamConsole(api);
        const pending = create(c, HTTP_FIELDS);
        await api.received("/admin/config");
        c.db.run("UPDATE users SET role = 'viewer' WHERE id = ?", [c.ids.member]);
        open();
        return pending;
      },
    },
  ];
  for (const item of cases) {
    test(`${item.name}: ${item.status} keeps id, name and url`, async () => {
      const res = await item.run();
      expect(res.status).toBe(item.status);
      expect(res.body).toContain("<h2>Your input</h2>");
      expect(res.body).toContain("<dt>id</dt><dd>new-web</dd>");
      expect(res.body).toContain("<dt>name</dt><dd>New web</dd>");
      expect(res.body).toContain("<dt>url</dt><dd>https://example.com/</dd>");
    });
  }
});

describe("text failure pages name the dropped write-only values", () => {
  const HB = {
    type: "heartbeat",
    id: "hb-new",
    name: "HB new",
    period_ms: "60000",
    secret: HEARTBEAT_SECRET,
  };
  const cases: {
    name: string;
    status: number;
    arrange: (api: ReturnType<typeof fakeApi>) => void;
  }[] = [
    {
      name: "config read fails",
      status: 502,
      arrange: (api) => api.replyTo("GET", "/admin/config", { status: 503, headers: WIRE_HEADERS }),
    },
    {
      name: "write answers 412",
      status: 412,
      arrange: (api) =>
        api.replyTo("POST", "/admin/checks", { status: 412, headers: WIRE_HEADERS }),
    },
  ];
  for (const item of cases) {
    test(`${item.name}: secret shows the not-kept notice`, async () => {
      const api = fakeApi();
      item.arrange(api);
      const res = await create(await teamConsole(api), HB);
      expect(res.body).toContain("<dt>name</dt><dd>HB new</dd>");
      expect(res.body).toContain("<dt>secret</dt><dd>Not kept for safety: enter it again.</dd>");
      expect(res.body).not.toContain(HEARTBEAT_SECRET);
      expect(res.status).toBe(item.status);
    });
  }
});

const BIG = 5 * 1024 * 1024 + 1;

type OutcomeCase = {
  name: string;
  reply: FakeReply;
  status: number;
  text: string;
  rows: string[];
};

const outcomeCases: OutcomeCase[] = [
  {
    name: "200, wire, strong ETag, oversized body",
    reply: {
      status: 200,
      body: "x".repeat(BIG),
      headers: { ...WIRE_HEADERS, etag: `"${REV_A}"` },
    },
    status: 303,
    text: "",
    rows: [REV_A],
  },
  {
    name: "201, wire, body not json",
    reply: { status: 201, body: "not json", headers: WIRE_HEADERS },
    status: 303,
    text: "",
    rows: ["unknown"],
  },
  {
    name: "200, wire, weak ETag",
    reply: { status: 200, body: "{}", headers: { ...WIRE_HEADERS, etag: 'W/"x"' } },
    status: 303,
    text: "",
    rows: ["unknown"],
  },
  {
    name: "204, wire",
    reply: { status: 204, body: "", headers: WIRE_HEADERS },
    status: 303,
    text: "",
    rows: ["unknown"],
  },
  {
    name: "401, wire",
    reply: { status: 401, headers: WIRE_HEADERS },
    status: 502,
    text: "pulse-api rejected the console token",
    rows: [],
  },
  {
    name: "403, wire",
    reply: { status: 403, headers: WIRE_HEADERS },
    status: 502,
    text: "The console token lacks the admin or checks scope. Saving checks needs both.",
    rows: [],
  },
  {
    name: "404, wire",
    reply: { status: 404, headers: WIRE_HEADERS },
    status: 404,
    text: "This check no longer exists.",
    rows: [],
  },
  {
    name: "409, wire, message",
    reply: { status: 409, body: '{"error":"check exists"}', headers: WIRE_HEADERS },
    status: 409,
    text: "check exists",
    rows: [],
  },
  {
    name: "412, wire",
    reply: { status: 412, headers: WIRE_HEADERS },
    status: 412,
    text: "Changed since you opened it",
    rows: [],
  },
  {
    name: "413, wire",
    reply: { status: 413, body: '{"error":"too big"}', headers: WIRE_HEADERS },
    status: 422,
    text: "too big",
    rows: [],
  },
  {
    name: "422, wire, 6 MiB error body",
    reply: { status: 422, body: "x".repeat(6291456), headers: WIRE_HEADERS },
    status: 422,
    text: "pulse-api gave no reason.",
    rows: [],
  },
  {
    name: "429, wire",
    reply: { status: 429, headers: WIRE_HEADERS },
    status: 503,
    text: "pulse-api is throttling the console. Try again in a minute.",
    rows: [],
  },
  {
    name: "400, wire",
    reply: { status: 400, body: '{"error":"bad"}', headers: WIRE_HEADERS },
    status: 502,
    text: "pulse-api refused the request (400): bad Nothing was changed.",
    rows: [],
  },
  {
    name: "428, wire, message",
    reply: { status: 428, body: '{"error":"If-Match is required"}', headers: WIRE_HEADERS },
    status: 502,
    text: "pulse-api refused the request (428): If-Match is required Nothing was changed.",
    rows: [],
  },
  {
    name: "500, wire",
    reply: { status: 500, headers: WIRE_HEADERS },
    status: 502,
    text: "pulse-api could not save the change (500). Nothing was changed.",
    rows: [],
  },
  {
    name: "502, wire",
    reply: { status: 502, headers: WIRE_HEADERS },
    status: 502,
    text: "pulse-api could not save the change (502). Nothing was changed.",
    rows: [],
  },
  {
    name: "302, wire, location",
    reply: { status: 302, headers: { ...WIRE_HEADERS, location: "/admin/checks/web" } },
    status: 502,
    text: "pulse-api answered with a redirect (302); redirects are not followed. The result is unknown: open the check to see whether the change was saved. Check that PULSE_API_URL points at pulse-api itself.",
    rows: ["unknown"],
  },
  {
    name: "302 without wire",
    reply: { status: 302, headers: { location: "/admin/checks/web" } },
    status: 502,
    text: "pulse-api answered with a redirect (302)",
    rows: ["unknown"],
  },
  {
    name: "502 without wire (proxy page)",
    reply: { status: 502, body: "<html>proxy</html>", headers: {} },
    status: 502,
    text: "The answer did not come from a matching pulse-api (502). The result is unknown: open the check to see whether the change was saved.",
    rows: ["unknown"],
  },
  {
    name: "200 with wire 2",
    reply: { status: 200, body: "{}", headers: { ...WIRE_HEADERS, "x-pulse-contract": "2" } },
    status: 502,
    text: "The answer did not come from a matching pulse-api (200).",
    rows: ["unknown"],
  },
  {
    name: "200 without wire",
    reply: { status: 200, body: "{}", headers: { "content-type": "application/json" } },
    status: 502,
    text: "The answer did not come from a matching pulse-api (200).",
    rows: ["unknown"],
  },
  {
    name: "202, wire",
    reply: { status: 202, body: "{}", headers: WIRE_HEADERS },
    status: 502,
    text: "The answer did not come from a matching pulse-api (202).",
    rows: ["unknown"],
  },
];

describe("write outcomes (R8 rows)", () => {
  for (const item of outcomeCases) {
    test(item.name, async () => {
      const api = fakeApi();
      api.replyTo("POST", "/admin/checks", item.reply);
      const c = await teamConsole(api);
      const res = await create(c, HTTP_FIELDS);
      expect(res.status).toBe(item.status);
      if (item.text !== "") expect(res.body).toContain(escapeHtml(item.text));
      if (item.status === 404) {
        expect(res.body).toContain('<section class="callout callout-error" role="alert">\n');
      }
      expectCalloutsOnly(res.body);
      expect(writes(api)).toEqual(["POST /admin/checks"]);
      expect(peopleRows(c)).toEqual(item.rows.map(row));
      expect(res.headers.get("location")).toBe(
        item.status === 303 ? "/checks/check?id=new-web&saved=1" : null,
      );
      const info = c.logs.filter((line) => line.includes('"check change"'));
      expect(info).toHaveLength(1);
    });
  }

  test("an unreadable saved answer logs one warning with call write and its kind", async () => {
    const api = fakeApi();
    api.replyTo("POST", "/admin/checks", {
      status: 200,
      body: "x".repeat(BIG),
      headers: { ...WIRE_HEADERS, etag: `"${REV_A}"` },
    });
    const c = await teamConsole(api);
    expect((await create(c, HTTP_FIELDS)).status).toBe(303);
    const warn = c.logs.filter((line) => line.includes("api answer unreadable"));
    expect(warn).toHaveLength(1);
    expect(JSON.parse(warn[0] ?? "{}")).toMatchObject({ call: "write", kind: "too-large" });
  });

  test("a refused write logs its status", async () => {
    const api = fakeApi();
    api.replyTo("POST", "/admin/checks", { status: 500, headers: WIRE_HEADERS });
    const c = await teamConsole(api);
    await create(c, HTTP_FIELDS);
    const info = c.logs.filter((line) => line.includes('"check change"'));
    expect(JSON.parse(info[0] ?? "{}")).toMatchObject({ outcome: "refused", status: 500 });
  });

  test("no answer within 5000 ms: 504, one unknown row, exactly one POST", async () => {
    const api = fakeApi();
    api.replyTo("POST", "/admin/checks", { status: 201, isHeld: true });
    const pending = new Set<() => void>();
    const c = await teamConsole(api, {
      schedule: (fn) => {
        pending.add(fn);
        return () => pending.delete(fn);
      },
    });
    const res = create(c, HTTP_FIELDS);
    await api.received("/admin/checks");
    while (pending.size !== 1) await new Promise((resolve) => setImmediate(resolve));
    for (const fn of pending) fn();
    const answer = await res;
    expect(answer.status).toBe(504);
    expect(answer.body).toContain(
      "The result is unknown. Open the check to see whether the change was saved.",
    );
    expect(peopleRows(c)).toEqual([row("unknown")]);
    expect(writes(api)).toEqual(["POST /admin/checks"]);
  });

  test("a failed People insert after a save says so and logs the error name only", async () => {
    const api = fakeApi();
    api.replyTo("POST", "/admin/checks", { status: 201, body: "{}", headers: WIRE_HEADERS });
    const c = await teamConsole(api);
    c.db.run(
      "CREATE TRIGGER check_row_fail BEFORE INSERT ON people_events BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    const res = await create(c, HTTP_FIELDS);
    expect(res.status).toBe(200);
    expect(res.body).toContain("Saved in pulse-api. The People log row could not be written.");
    expect(res.body).toContain('<section class="callout callout-warning" role="alert">');
    expectCalloutsOnly(res.body);
    const errors = c.logs.filter((line) => line.includes("check change not logged"));
    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0] ?? "{}")).toMatchObject({ error: "PeopleLogError" });
    expect(errors[0]).not.toContain("injected");
  });
});

describe("leaks on the create route", () => {
  test("literal header values, bodies, secrets and the token never reach pages or logs", async () => {
    const api = fakeApi();
    api.replyTo("POST", "/admin/checks", {
      status: 422,
      body: '{"error":"refused"}',
      headers: WIRE_HEADERS,
    });
    const c = await teamConsole(api);
    const fields = {
      ...HTTP_FIELDS,
      method: "POST",
      body: BODY_SECRET,
      header_0_name: "X-Key",
      header_0_kind: "plain",
      header_0_value: HEADER_SECRET,
    };
    const pages: Reply[] = [];
    pages.push(await create(c, fields));
    pages.push(await create(c, { ...fields, interval_ms: "x" }));
    pages.push(await create(c, { ...fields, id: "web" }));
    pages.push(
      await postForm(
        c,
        ACTION,
        { csrf: c.csrfs.member, form_token: "expired", ...fields },
        { cookie: c.cookies.member },
      ),
    );
    pages.push(
      await create(c, {
        type: "heartbeat",
        id: "hb",
        name: "HB",
        period_ms: "60000",
        secret: HEARTBEAT_SECRET,
      }),
    );
    for (const page of pages) {
      const rest = page.body
        .replace(/<input type="hidden" name="csrf" value="[^"]*">/g, "")
        .replace(/<input type="hidden" name="form_token" value="[^"]*">/g, "");
      const headers = [...page.headers.entries()]
        .filter(([name]) => name !== "set-cookie")
        .map(([name, value]) => `${name}: ${value}`)
        .join("\n");
      for (const sentinel of [HEADER_SECRET, BODY_SECRET, HEARTBEAT_SECRET, TOKEN]) {
        expect(rest).not.toContain(sentinel);
        expect(headers).not.toContain(sentinel);
      }
    }
    const logs = c.logs.join("\n");
    const metrics = await fetch(`${c.base}/metrics`).then((res) => res.text());
    for (const sentinel of [HEADER_SECRET, BODY_SECRET, HEARTBEAT_SECRET, TOKEN]) {
      expect(logs).not.toContain(sentinel);
      expect(metrics).not.toContain(sentinel);
    }
  });
});
