import { afterEach, describe, expect, test } from "bun:test";
import { checkConfig } from "../test/check-fixtures.ts";
import {
  type FakeApi,
  type FakeReply,
  jsonReply,
  STATUS_REVISION,
  startFakeApi,
  statusSettingsView,
  WIRE_HEADERS,
} from "../test/fake-api.ts";
import { formTokenOf, getPage, type Reply, replyOf } from "../test/signed-in-console.ts";
import { startTeamConsole, type TeamConsole } from "../test/team-console.ts";
import { parseForm } from "./forms.ts";
import type { ConsoleRole } from "./roles.ts";

const TOKEN = "status-page-admin-token-sentinel-0123456789";
const PATH = "/status-page";
const SETTINGS_PATH = "/admin/status/settings";
const NEW_REVISION = `sha256-${"6".repeat(64)}`;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function fakeApi(view: Record<string, unknown> = statusSettingsView()): FakeApi {
  const api = startFakeApi();
  cleanups.push(() => api.stop());
  api.replyTo("GET", SETTINGS_PATH, jsonReply(view));
  api.replyTo("PUT", SETTINGS_PATH, {
    status: 200,
    body: JSON.stringify(view),
    headers: { ...WIRE_HEADERS, etag: `"${NEW_REVISION}"` },
  });
  api.reply(
    "/admin/config",
    jsonReply({
      ...checkConfig,
      components: [
        { id: "site", name: "Site", checkIds: ["a"] },
        { id: "data", name: "Data", checkIds: ["b"] },
      ],
    }),
  );
  return api;
}

async function teamConsole(
  api: FakeApi,
  schedule?: (fn: () => void, ms: number) => () => void,
): Promise<TeamConsole> {
  const c = await startTeamConsole({ apiUrl: api.url, adminToken: TOKEN, schedule });
  cleanups.push(() => c.close());
  return c;
}

function writes(api: FakeApi): string[] {
  return api.seen.filter((s) => s.method !== "GET").map((s) => `${s.method} ${s.rawPath}`);
}

/** Posts a raw encoded body, as the browser does, with origin, CSRF and a fresh form token. */
async function postRaw(
  c: TeamConsole,
  build: (params: URLSearchParams) => void,
  options: { role?: ConsoleRole; origin?: string; csrf?: string; token?: string } = {},
): Promise<Reply> {
  const role = options.role ?? "owner";
  const token = options.token ?? formTokenOf((await getPage(c, PATH, c.cookies[role])).body, PATH);
  const params = new URLSearchParams();
  params.append("csrf", options.csrf ?? c.csrfs[role]);
  params.append("form_token", token);
  build(params);
  return sendBody(c, params.toString(), role, options.origin);
}

function sendBody(
  c: TeamConsole,
  body: string,
  role: ConsoleRole,
  origin?: string,
): Promise<Reply> {
  return fetch(c.base + PATH, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: c.cookies[role],
      origin: origin ?? c.base,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  }).then(replyOf);
}

function saveFields(fields: Record<string, string>): (params: URLSearchParams) => void {
  return (params) => {
    params.append("revision", STATUS_REVISION);
    for (const [name, value] of Object.entries(fields)) params.append(name, value);
  };
}

function putBody(api: FakeApi): unknown {
  const put = api.seen.find((s) => s.method === "PUT");
  return put === undefined ? undefined : JSON.parse(put.body);
}

function hiddenOrder(html: string): string | undefined {
  return /<input type="hidden" name="order" value="([^"]*)">/.exec(html)?.[1];
}

describe("access", () => {
  test.each(["admin", "member", "viewer"] as const)("%s gets 403 on GET and POST", async (role) => {
    const api = fakeApi();
    const c = await teamConsole(api);
    expect((await getPage(c, PATH, c.cookies[role])).status).toBe(403);
    const res = await sendBody(
      c,
      new URLSearchParams({ csrf: c.csrfs[role], form_token: "x", action: "save" }).toString(),
      role,
    );
    expect(res.status).toBe(403);
    expect(writes(api)).toEqual([]);
  });

  test("the owner sees the nav entry and the form; save is the first submit button", async () => {
    const c = await teamConsole(fakeApi(statusSettingsView({ componentOrder: ["web", "db"] })));
    const res = await getPage(c, PATH, c.cookies.owner);
    expect(res.status).toBe(200);
    expect(res.body).toContain('href="/status-page"');
    const form = res.body.slice(res.body.indexOf(`action="${PATH}"`));
    expect(/<button type="submit"[^>]*>([^<]*)</.exec(form)?.[1]).toBe("Save");
    expect(/<button type="submit" name="action" value="([^"]*)"/.exec(form)?.[1]).toBe("save");
    expect(form.match(/name="order"/g)).toHaveLength(1);
    expect(form).not.toMatch(/type="hidden" name="action"/);
    expect(hiddenOrder(form)).toBe("web,db");
    expect(form).toContain('<option value="" selected>Not set (default: Off)</option>');
    for (const key of ["light-bg", "dark-info-tint", "font-mono", "radius-pill"]) {
      expect(form).toContain(`name="${key}"`);
    }
  });

  test("bad origin and bad CSRF are 403, a replayed form token is 409", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const save = saveFields({ action: "save" });
    expect((await postRaw(c, save, { origin: "http://evil.example" })).status).toBe(403);
    expect((await postRaw(c, save, { csrf: "wrong" })).status).toBe(403);
    const token = formTokenOf((await getPage(c, PATH, c.cookies.owner)).body, PATH);
    expect((await postRaw(c, save, { token })).status).toBe(303);
    expect((await postRaw(c, save, { token })).status).toBe(409);
    expect(writes(api)).toEqual([`PUT ${SETTINGS_PATH}`]);
  });

  test("a role change between read and write is 403 and sends nothing", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const token = formTokenOf((await getPage(c, PATH, c.cookies.owner)).body, PATH);
    const demote: FakeReply = {
      ...jsonReply(statusSettingsView()),
      after: () => c.db.run("UPDATE users SET role = 'admin' WHERE id = ?", [c.ids.owner]),
    };
    api.replyTo("GET", SETTINGS_PATH, demote);
    const res = await postRaw(c, saveFields({ action: "save", name: "Acme" }), { token });
    expect(res.status).toBe(403);
    expect(writes(api)).toEqual([]);
  });
});

describe("component order", () => {
  test("order=web,db,cdn with action=save sends the literal list", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await postRaw(c, saveFields({ order: "web,db,cdn", action: "save" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/status-page?saved=1");
    expect(putBody(api)).toEqual({ componentOrder: ["web", "db", "cdn"] });
    const put = api.seen.find((s) => s.method === "PUT");
    expect(put?.headers["if-match"]).toBe(`"${STATUS_REVISION}"`);
    expect(put?.authorization).toBe(`Bearer ${TOKEN}`);
    const saved = await getPage(c, "/status-page?saved=1", c.cookies.owner);
    expect(saved.body).toContain("Status page settings saved.");
  });

  test.each([
    ["up:2", "web,cdn,db"],
    ["down:0", "db,web,cdn"],
    ["up:0", "web,db,cdn"],
    ["down:2", "web,db,cdn"],
    ["down:9", "web,db,cdn"],
  ])("%s re-renders unsaved with the moved order", async (action, expected) => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await postRaw(c, saveFields({ order: "web,db,cdn", action }));
    expect(res.status).toBe(200);
    expect(hiddenOrder(res.body)).toBe(expected);
    expect(writes(api)).toEqual([]);
  });

  test("reset-order lists the pulse-api components in their order, unsaved", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await postRaw(c, saveFields({ order: "db,web", action: "reset-order" }));
    expect(res.status).toBe(200);
    expect(hiddenOrder(res.body)).toBe("site,data");
    expect(writes(api)).toEqual([]);
  });

  test("a repeated order field is 400 and sends nothing", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await postRaw(c, (params) => {
      params.append("order", "web");
      params.append("order", "db");
      params.append("action", "save");
    });
    expect(res.status).toBe(400);
    expect(res.body).toBe("repeated form field\n");
    expect(writes(api)).toEqual([]);
  });

  test("the unchanged parser refuses a repeated order", () => {
    expect(parseForm("order=a&order=b", ["order"])).toEqual({ isOk: false, repeated: "order" });
  });

  const tooMany = Array.from({ length: 501 }, (_, i) => `c${i}`).join(",");
  test.each([["web,,db"], [",web,db"], ["web,db,"], ["Web"], [tooMany]])(
    "order %s shows the invalid text, keeps the input and sends nothing",
    async (order) => {
      const api = fakeApi();
      const c = await teamConsole(api);
      const res = await postRaw(c, saveFields({ order, action: "save" }));
      expect(res.status).toBe(422);
      expect(res.body).toContain("The component order is invalid.");
      expect(hiddenOrder(res.body)).toBe(order);
      expect(writes(api)).toEqual([]);
    },
  );

  test("duplicates and unknown ids reach the api, whose 422 is shown with the input kept", async () => {
    const api = fakeApi();
    api.replyTo("PUT", SETTINGS_PATH, {
      status: 422,
      body: JSON.stringify({ error: "settings.componentOrder[1]: must not repeat an id" }),
      headers: WIRE_HEADERS,
    });
    const c = await teamConsole(api);
    const res = await postRaw(c, saveFields({ order: "web,web", action: "save", name: "Acme" }));
    expect(res.status).toBe(422);
    expect(putBody(api)).toEqual({ name: "Acme", componentOrder: ["web", "web"] });
    expect(hiddenOrder(res.body)).toBe("web,web");
    expect(res.body).toContain('value="Acme"');
  });

  test("an empty order saves a document without componentOrder", async () => {
    const api = fakeApi(statusSettingsView({ componentOrder: ["web"] }));
    const c = await teamConsole(api);
    const res = await postRaw(c, saveFields({ order: "", action: "save" }));
    expect(res.status).toBe(303);
    expect(putBody(api)).toEqual({});
  });
});

describe("fields", () => {
  test("three-way switches and cleared fields keep absence", async () => {
    const api = fakeApi(statusSettingsView({ name: "Old", showChecks: true }));
    const c = await teamConsole(api);
    const res = await postRaw(
      c,
      saveFields({
        name: "",
        show_checks: "",
        show_latency: "off",
        show_slos: "on",
        "light-bg": "#ffffff",
        "font-sans": "Inter, sans-serif",
        action: "save",
      }),
    );
    expect(res.status).toBe(303);
    expect(putBody(api)).toEqual({
      showLatency: false,
      showSlos: true,
      theme: { light: { bg: "#ffffff" }, "font-sans": "Inter, sans-serif" },
    });
  });

  test("an invalid value is 422 with the input kept and nothing sent", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await postRaw(c, saveFields({ "light-bg": "red", action: "save" }));
    expect(res.status).toBe(422);
    expect(res.body).toContain("settings.theme.light.bg: must be a colour");
    expect(res.body).toContain('value="red"');
    expect(writes(api)).toEqual([]);
  });

  test("the largest valid form is below 47 000 bytes and saves; 65 537 bytes is 413", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const order = Array.from(
      { length: 500 },
      (_, i) => `c${String(i).padStart(3, "0")}${"a".repeat(60)}`,
    );
    const fields: Record<string, string> = {
      name: "\u{1F600}".repeat(30),
      logo_url: `https://example.com/${"!".repeat(2048 - 20)}`,
      "font-sans": '"'.repeat(200),
      "font-mono": '"'.repeat(200),
      "radius-sm": `${"1".repeat(30)}px`,
      "radius-md": `${"2".repeat(30)}px`,
      "radius-pill": `${"3".repeat(30)}px`,
      show_checks: "off",
      show_latency: "off",
      show_slos: "off",
      hide_details: "off",
      order: order.join(","),
      action: "save",
    };
    for (const mode of ["light", "dark"]) {
      for (const key of ["bg", "surface", "rule", "line-strong", "field-line", "text", "lead"]) {
        fields[`${mode}-${key}`] = "#aabbccdd";
      }
    }
    const token = formTokenOf((await getPage(c, PATH, c.cookies.owner)).body, PATH);
    const params = new URLSearchParams({ csrf: c.csrfs.owner, form_token: token });
    saveFields(fields)(params);
    const body = params.toString();
    expect(Buffer.byteLength(body)).toBeLessThan(47000);
    const res = await sendBody(c, body, "owner");
    expect(res.status).toBe(303);
    const sent = putBody(api) as { componentOrder: string[]; name: string };
    expect(sent.componentOrder).toHaveLength(500);
    expect(sent.name).toBe("\u{1F600}".repeat(30));

    const big = `${body}&pad=${"x".repeat(65537 - body.length - 5)}`;
    expect(Buffer.byteLength(big)).toBe(65537);
    expect((await sendBody(c, big, "owner")).status).toBe(413);
  });
});

const LOCKED_VIEW = statusSettingsView(
  { name: "Database name" },
  {
    state: "fresh",
    receivedAt: 1000,
    report: {
      at: 1000,
      startedAt: 500,
      appliedRevision: STATUS_REVISION,
      rejected: null,
      locked: [
        { field: "name", source: "env", via: "PULSE_STATUS_NAME", value: "Env name" },
        { field: "theme.light.bg", source: "file", via: "theme file" },
      ],
    },
  },
);

describe("locked fields and report states", () => {
  test("a fresh lock is read-only with its origin and keeps the stored value on save", async () => {
    const api = fakeApi(LOCKED_VIEW);
    const c = await teamConsole(api);
    const page = await getPage(c, PATH, c.cookies.owner);
    expect(page.body).toContain("Set by <code>PULSE_STATUS_NAME</code> on pulse-status");
    expect(page.body).toContain("Set by <code>theme file</code> on pulse-status");
    expect(page.body).not.toContain('name="name"');
    expect(page.body).not.toContain('name="light-bg"');
    const res = await postRaw(c, saveFields({ "dark-bg": "#000000", action: "save" }));
    expect(res.status).toBe(303);
    expect(putBody(api)).toEqual({ name: "Database name", theme: { dark: { bg: "#000000" } } });
  });

  test("a forged POST of a locked field is 422 and sends nothing", async () => {
    const api = fakeApi(LOCKED_VIEW);
    const c = await teamConsole(api);
    const res = await postRaw(c, saveFields({ name: "Forged", action: "save" }));
    expect(res.status).toBe(422);
    expect(res.body).toContain("This field is set on pulse-status and cannot be changed here.");
    expect(writes(api)).toEqual([]);
  });

  test.each([
    [
      "stale",
      {
        state: "stale",
        receivedAt: 1000,
        report: (LOCKED_VIEW.service as { report: unknown }).report,
      },
    ],
    ["never", { state: "never", receivedAt: null, report: null }],
  ])("a %s report shows unknown overrides and keeps every field editable", async (_, service) => {
    const c = await teamConsole(fakeApi(statusSettingsView({ name: "Db" }, service)));
    const page = await getPage(c, PATH, c.cookies.owner);
    expect(page.body).toContain("pulse-status has not reported; overrides are unknown");
    expect(page.body).toContain('name="name"');
    expect(page.body).not.toContain("Set by");
  });

  test("rejected and not-applied banners", async () => {
    const view = statusSettingsView(
      {},
      {
        state: "fresh",
        receivedAt: 1000,
        report: {
          at: 1000,
          startedAt: 500,
          appliedRevision: null,
          rejected: { source: "database", reason: "settings.name: must be 1..60 characters" },
          locked: [],
        },
      },
    );
    const page = await getPage(await teamConsole(fakeApi(view)), PATH);
    expect(page.body).toContain("settings.name: must be 1..60 characters");
    expect(page.body).toContain("Saved, not yet applied");
  });
});

describe("api states", () => {
  test("412 keeps the input", async () => {
    const api = fakeApi();
    api.replyTo("PUT", SETTINGS_PATH, {
      status: 412,
      headers: WIRE_HEADERS,
      body: '{"error":"x"}',
    });
    const c = await teamConsole(api);
    const res = await postRaw(c, saveFields({ name: "Kept name", action: "save" }));
    expect(res.status).toBe(412);
    expect(res.body).toContain("Changed since you opened it");
    expect(res.body).toContain('value="Kept name"');
  });

  test("a 401 read shows the token banner; a 404 read is the old api", async () => {
    const api = fakeApi();
    api.replyTo("GET", SETTINGS_PATH, { status: 401, headers: WIRE_HEADERS, body: "{}" });
    const c = await teamConsole(api);
    expect((await getPage(c, PATH, c.cookies.owner)).body).toContain(
      "pulse-api rejected the console token",
    );
    api.replyTo("GET", SETTINGS_PATH, { status: 404, headers: WIRE_HEADERS, body: "{}" });
    const old = await getPage(c, PATH, c.cookies.owner);
    expect(old.status).toBe(404);
    expect(old.body).toContain("This pulse-api is too old for this page.");
  });

  test("an invalid view is an unusable answer", async () => {
    const api = fakeApi({ revision: "nope" });
    const c = await teamConsole(api);
    const res = await getPage(c, PATH, c.cookies.owner);
    expect(res.body).toContain("pulse-api sent an invalid answer.");
  });

  test("a write timeout is unknown and logs a People row without values", async () => {
    const api = fakeApi();
    api.replyTo("PUT", SETTINGS_PATH, { status: 200, isHeld: true });
    const timers = new Set<() => void>();
    const c = await teamConsole(api, (fn) => {
      timers.add(fn);
      return () => timers.delete(fn);
    });
    const pending = postRaw(c, saveFields({ name: "Secret Name", action: "save" }));
    while (!api.seen.some((s) => s.method === "PUT") || timers.size !== 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (const fn of timers) fn();
    const res = await pending;
    expect(res.status).toBe(504);
    expect(writes(api)).toEqual([`PUT ${SETTINGS_PATH}`]);
    const rows = c.db
      .query(
        "SELECT action, target_kind, target_name, value FROM people_events WHERE action = 'status-settings.replace'",
      )
      .all();
    expect(rows).toEqual([
      {
        action: "status-settings.replace",
        target_kind: "status-settings",
        target_name: null,
        value: "unknown",
      },
    ]);
    expect(c.logs.join("\n")).not.toContain("Secret Name");
    expect(c.logs.join("\n")).not.toContain(TOKEN);
  });

  test("a saved write logs the new revision, never a value", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    await postRaw(c, saveFields({ name: "Value Sentinel", action: "save" }));
    const rows = c.db
      .query(
        "SELECT action, target_kind, target_name, value FROM people_events WHERE action = 'status-settings.replace'",
      )
      .all();
    expect(rows).toEqual([
      {
        action: "status-settings.replace",
        target_kind: "status-settings",
        target_name: null,
        value: NEW_REVISION,
      },
    ]);
  });
});
