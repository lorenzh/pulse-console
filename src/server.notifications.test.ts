import { afterEach, describe, expect, test } from "bun:test";
import {
  type FakeApi,
  jsonReply,
  NOTIFY_REVISION,
  notifyChannelsView,
  notifyReport,
  startFakeApi,
  WIRE_HEADERS,
  webhookChannel,
} from "../test/fake-api.ts";
import { formTokenOf, getPage, type Reply, replyOf } from "../test/signed-in-console.ts";
import { startTeamConsole, type TeamConsole } from "../test/team-console.ts";
import type { ConsoleRole } from "./roles.ts";

const TOKEN = "notify-admin-token-sentinel-0123456789";
const CHANNELS = "/admin/notify/channels";
const FAILED = "/admin/notify/failed";
const RESENDS = "/admin/notify/resends";
const NEW_REVISION = `sha256-${"8".repeat(64)}`;
const COMMAND_ID = "Cmd_cmd-cmd_cmd-cmd_cmd0";
const PATHS = [
  "/notifications",
  "/notifications/new",
  "/notifications/edit?id=a",
  "/notifications/delete?id=a",
  "/notifications/failed",
  `/notifications/resend?id=${COMMAND_ID}`,
] as const;
const POST_PATHS = [
  "/notifications/new",
  "/notifications/edit",
  "/notifications/delete",
  "/notifications/resend",
] as const;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function failedView(failed: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { state: "fresh", receivedAt: 1000, failed, failedTotal: failed.length, ...extra };
}

function failedEntry(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    channelId: "a",
    key: "1:opened",
    event: "opened",
    isManual: false,
    failedAt: 1_700_000_000_000,
    hasPayload: true,
    ...extra,
  };
}

function command(state: string, requestId = "r".repeat(24)): Record<string, unknown> {
  return {
    id: COMMAND_ID,
    channelId: "a",
    key: "1:opened",
    requestId,
    state,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function fakeApi(view: unknown = notifyChannelsView({ channels: [webhookChannel("a")] })): FakeApi {
  const api = startFakeApi();
  cleanups.push(() => api.stop());
  api.replyTo("GET", CHANNELS, jsonReply(view));
  const saved = {
    status: 201,
    body: "{}",
    headers: { ...WIRE_HEADERS, etag: `"${NEW_REVISION}"` },
  };
  api.replyTo("POST", CHANNELS, saved);
  api.replyTo("PUT", `${CHANNELS}/a`, { ...saved, status: 200 });
  api.replyTo("DELETE", `${CHANNELS}/a`, { status: 204, headers: WIRE_HEADERS, body: "" });
  api.replyTo("GET", FAILED, jsonReply(failedView([failedEntry({})])));
  api.replyTo("POST", RESENDS, { ...jsonReply(command("queued")), status: 202 });
  api.replyTo("GET", `${RESENDS}/${COMMAND_ID}`, jsonReply(command("delivered")));
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

function send(
  c: TeamConsole,
  path: string,
  body: string,
  role: ConsoleRole = "owner",
  origin?: string,
): Promise<Reply> {
  return fetch(c.base + path, {
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

/** Posts `fields` to `action` with CSRF and a form token read from the GET page `from`. */
async function post(
  c: TeamConsole,
  from: string,
  action: string,
  fields: Record<string, string>,
  options: { token?: string; csrf?: string; origin?: string } = {},
): Promise<Reply> {
  const token =
    options.token ?? formTokenOf((await getPage(c, from, c.cookies.owner)).body, action);
  const params = new URLSearchParams({ csrf: options.csrf ?? c.csrfs.owner, form_token: token });
  for (const [name, value] of Object.entries(fields)) params.append(name, value);
  return send(c, action, params.toString(), "owner", options.origin);
}

const webhookFields = {
  revision: NOTIFY_REVISION,
  id: "hook",
  type: "webhook",
  url_env: "HOOK",
  checks: "api\r\nweb",
};

function sentBody(api: FakeApi, method: string): unknown {
  const seen = api.seen.find((s) => s.method === method);
  return seen === undefined ? undefined : JSON.parse(seen.body);
}

function rowOf(html: string, id: string): string {
  return html.split("<tr>").find((r) => r.startsWith(`<td class="mono">${id}</td>`)) ?? "";
}

describe("access", () => {
  test.each(["admin", "member", "viewer"] as const)(
    "%s gets 403 on GET and POST of every route",
    async (role) => {
      const api = fakeApi();
      const c = await teamConsole(api);
      for (const path of PATHS) expect((await getPage(c, path, c.cookies[role])).status).toBe(403);
      for (const path of POST_PATHS) {
        const body = new URLSearchParams({ csrf: c.csrfs[role], form_token: "x" }).toString();
        expect((await send(c, path, body, role)).status).toBe(403);
      }
      expect(writes(api)).toEqual([]);
    },
  );

  test("the owner sees the nav entry", async () => {
    const c = await teamConsole(fakeApi());
    const res = await getPage(c, "/notifications", c.cookies.owner);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<a class="nav-item" href="/notifications"');
  });

  test("a role change between read and write is 403 and sends nothing", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const page = await getPage(c, "/notifications/new", c.cookies.owner);
    c.db.run("UPDATE users SET role = 'admin' WHERE id = ?", [c.ids.owner]);
    const res = await post(c, "", "/notifications/new", webhookFields, {
      token: formTokenOf(page.body, "/notifications/new"),
    });
    expect(res.status).toBe(403);
    expect(writes(api)).toEqual([]);
  });

  test("a bad origin and a bad CSRF are 403, a replayed form token 409", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const from = "/notifications/new";
    expect((await post(c, from, from, webhookFields, { origin: "http://evil.test" })).status).toBe(
      403,
    );
    expect((await post(c, from, from, webhookFields, { csrf: "wrong" })).status).toBe(403);
    const token = formTokenOf((await getPage(c, from, c.cookies.owner)).body, from);
    expect((await post(c, from, from, webhookFields, { token })).status).toBe(303);
    expect((await post(c, from, from, webhookFields, { token })).status).toBe(409);
    expect(writes(api)).toEqual([`POST ${CHANNELS}`]);
  });
});

describe("list", () => {
  test("file channels come from the report, shadowed copies allow only Delete", async () => {
    const view = notifyChannelsView({
      channels: [webhookChannel("a")],
      shadowed: [webhookChannel("s")],
      report: notifyReport({
        fileChannels: [{ source: "file", id: "ops", type: "slack", refs: ["SLACK_OPS"] }],
        fileChannelsTotal: 3,
        shadowedIds: ["s"],
      }),
    });
    const c = await teamConsole(fakeApi(view));
    const html = (await getPage(c, "/notifications", c.cookies.owner)).body;
    const ops = rowOf(html, "ops");
    expect(ops).toContain("From the notify channel file");
    expect(ops).toContain("<code>SLACK_OPS</code>");
    expect(ops).not.toContain("href=");
    const s = rowOf(html, "s");
    expect(s).toContain("Shadowed by the channel file");
    expect(s).toContain('href="/notifications/delete?id=s"');
    expect(s).not.toContain("/notifications/edit");
    expect(rowOf(html, "a")).toContain('href="/notifications/edit?id=a"');
    expect(html).toContain("2 more file channels exist and are not listed.");
  });

  test("a rejected channel marks only its own row; a null channel is a banner", async () => {
    const reason = "channels[1]: must be at most 16384 bytes as JSON";
    const view = notifyChannelsView({
      channels: [webhookChannel("a"), webhookChannel("b"), webhookChannel("c")],
      report: notifyReport({
        rejected: [
          { channelId: "b", reason },
          { channelId: null, reason: "channels answer: x" },
        ],
      }),
    });
    const c = await teamConsole(fakeApi(view));
    const html = (await getPage(c, "/notifications", c.cookies.owner)).body;
    expect(rowOf(html, "b")).toContain(`Rejected by pulse-notify: ${reason}`);
    expect(html.split(`Rejected by pulse-notify: ${reason}`)).toHaveLength(2);
    expect(rowOf(html, "a")).not.toContain("Rejected by pulse-notify");
    expect(rowOf(html, "c")).not.toContain("Rejected by pulse-notify");
    expect(html).not.toContain("Saved, not yet applied");
    expect(html).toContain("Rejected by pulse-notify: channels answer: x");
  });

  test("states: not applied, stale, never, zero channels", async () => {
    const api = fakeApi(
      notifyChannelsView({
        channels: [webhookChannel("a")],
        report: notifyReport({ appliedRevision: null }),
      }),
    );
    const c = await teamConsole(api);
    expect((await getPage(c, "/notifications", c.cookies.owner)).body).toContain(
      "Saved, not yet applied",
    );
    const stale = notifyChannelsView({
      channels: [webhookChannel("a")],
      state: "stale",
      report: notifyReport({ rejected: [{ channelId: "a", reason: "old" }] }),
    });
    api.replyTo("GET", CHANNELS, jsonReply(stale));
    const staleHtml = (await getPage(c, "/notifications", c.cookies.owner)).body;
    expect(staleHtml).toContain("pulse-notify has not reported");
    expect(staleHtml).not.toContain("Rejected by pulse-notify");
    api.replyTo("GET", CHANNELS, jsonReply(notifyChannelsView({ state: "never" })));
    const zero = (await getPage(c, "/notifications", c.cookies.owner)).body;
    expect(zero).toContain("No notification channels yet");
    expect(zero).toContain("pulse-notify has not reported");
  });

  test("token rejected, old api and an invalid record have states", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    api.replyTo("GET", CHANNELS, { status: 401, headers: WIRE_HEADERS, body: "{}" });
    expect((await getPage(c, "/notifications", c.cookies.owner)).body).toContain(
      "pulse-api rejected the console token",
    );
    api.replyTo("GET", CHANNELS, { status: 404, headers: WIRE_HEADERS, body: "{}" });
    const old = await getPage(c, "/notifications", c.cookies.owner);
    expect(old.status).toBe(404);
    expect(old.body).toContain("This pulse-api is too old for this page.");
    // A record with a literal url passes no admin validator.
    api.replyTo(
      "GET",
      CHANNELS,
      jsonReply(notifyChannelsView({ channels: [webhookChannel("a", { url: "https://x" })] })),
    );
    expect((await getPage(c, "/notifications", c.cookies.owner)).body).toContain(
      "pulse-api sent an invalid answer.",
    );
  });
});

describe("editor", () => {
  test("has no secret value field and offers reference names only", async () => {
    const c = await teamConsole(fakeApi());
    const html = (await getPage(c, "/notifications/new", c.cookies.owner)).body;
    expect(html).not.toMatch(/name="(url|secret|password|smtp_password)"/);
    expect(html).not.toContain('type="password"');
    expect(html).toContain("PULSE_NOTIFY_SECRET_");
    expect(html).toContain("a file in PULSE_NOTIFY_SECRET_DIR on pulse-notify");
  });

  test("create sends the definition with If-Match, a forged url is not forwarded", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await post(c, "/notifications/new", "/notifications/new", {
      ...webhookFields,
      url: "https://forged.example",
      secret: "s3cret-sentinel",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/notifications?saved=1");
    const seen = api.seen.find((s) => s.method === "POST");
    expect(seen?.headers["if-match"]).toBe(`"${NOTIFY_REVISION}"`);
    expect(sentBody(api, "POST")).toEqual({
      id: "hook",
      type: "webhook",
      checks: ["api", "web"],
      urlEnv: "PULSE_NOTIFY_SECRET_HOOK",
    });
    expect(seen?.body).not.toContain("forged");
    expect(seen?.body).not.toContain("s3cret-sentinel");
    const rows = c.db
      .query(
        "SELECT action, target_kind, target_name, value FROM people_events WHERE action LIKE 'notify%'",
      )
      .all();
    expect(rows).toEqual([
      {
        action: "notify-channel.create",
        target_kind: "notify-channel",
        target_name: "hook",
        value: NEW_REVISION,
      },
    ]);
  });

  test("a 16384-byte definition of 3-byte characters fits the form and arrives unchanged", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const base = {
      id: "big",
      type: "webhook",
      checks: [] as string[],
      urlEnv: "PULSE_NOTIFY_SECRET_HOOK",
    };
    const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));
    while (bytes(base) + 200 * 3 + 3 <= 16_384) base.checks.push("€".repeat(200));
    let last = "";
    while (bytes({ ...base, checks: [...base.checks, `${last}€`] }) <= 16_384) last += "€";
    while (bytes({ ...base, checks: [...base.checks, `${last}a`] }) <= 16_384) last += "a";
    base.checks.push(last);
    expect(bytes(base)).toBe(16_384);
    const token = formTokenOf(
      (await getPage(c, "/notifications/new", c.cookies.owner)).body,
      "/notifications/new",
    );
    const params = new URLSearchParams({ csrf: c.csrfs.owner, form_token: token });
    for (const [k, v] of Object.entries({
      revision: NOTIFY_REVISION,
      id: "big",
      type: "webhook",
      url_env: "HOOK",
      checks: base.checks.join("\r\n"),
    }))
      params.append(k, v);
    const body = params.toString();
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(57_344);
    const res = await send(c, "/notifications/new", body);
    expect(res.status).toBe(303);
    expect(sentBody(api, "POST")).toEqual(base);
  });

  test("bodies over the limits are 413: 65537 for channels, 8193 for delete and resend", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const over = (n: number): string => {
      const head = `csrf=${c.csrfs.owner}&form_token=x&id=`;
      return head + "a".repeat(n - head.length);
    };
    for (const path of ["/notifications/new", "/notifications/edit"]) {
      expect(Buffer.byteLength(over(65_537))).toBe(65_537);
      expect((await send(c, path, over(65_537))).status).toBe(413);
    }
    for (const path of ["/notifications/delete", "/notifications/resend"]) {
      expect((await send(c, path, over(8193))).status).toBe(413);
    }
    expect(writes(api)).toEqual([]);
  });

  test("a 422 over the definition limit keeps the input and shows the limit", async () => {
    const api = fakeApi();
    api.replyTo("POST", CHANNELS, {
      status: 422,
      headers: WIRE_HEADERS,
      body: JSON.stringify({ error: "channel: must be at most 16384 bytes as JSON" }),
    });
    const c = await teamConsole(api);
    const res = await post(c, "/notifications/new", "/notifications/new", webhookFields);
    expect(res.status).toBe(422);
    expect(res.body).toContain("must be at most 16384 bytes as JSON");
    expect(res.body).toContain('value="hook"');
  });

  test("a local validation error keeps the input and sends nothing", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await post(c, "/notifications/new", "/notifications/new", {
      ...webhookFields,
      id: "Bad Id",
    });
    expect(res.status).toBe(422);
    expect(res.body).toContain('value="Bad Id"');
    expect(writes(api)).toEqual([]);
  });

  test("edit reads the stored record and a 412 keeps the input", async () => {
    const api = fakeApi();
    api.replyTo("PUT", `${CHANNELS}/a`, { status: 412, headers: WIRE_HEADERS, body: "{}" });
    const c = await teamConsole(api);
    const page = await getPage(c, "/notifications/edit?id=a", c.cookies.owner);
    expect(page.body).toContain('value="HOOK"');
    const res = await post(c, "/notifications/edit?id=a", "/notifications/edit", {
      ...webhookFields,
      id: "a",
      url_env: "KEPT_INPUT",
    });
    expect(res.status).toBe(412);
    expect(res.body).toContain("Changed since you opened it");
    expect(res.body).toContain('value="KEPT_INPUT"');
    expect(api.seen.find((s) => s.method === "PUT")?.headers["if-match"]).toBe(
      `"${NOTIFY_REVISION}"`,
    );
  });

  test("a shadowed copy has no editor; an unknown id is 404", async () => {
    const api = fakeApi(notifyChannelsView({ shadowed: [webhookChannel("a")] }));
    const c = await teamConsole(api);
    const res = await getPage(c, "/notifications/edit?id=a", c.cookies.owner);
    expect(res.status).toBe(409);
    expect(res.body).toContain("Shadowed by the channel file: only Delete is possible.");
    expect((await getPage(c, "/notifications/edit?id=zz", c.cookies.owner)).status).toBe(404);
  });

  test("delete sends DELETE with If-Match and logs the channel id", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await post(c, "/notifications/delete?id=a", "/notifications/delete", {
      id: "a",
      revision: NOTIFY_REVISION,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/notifications?deleted=1");
    expect(writes(api)).toEqual([`DELETE ${CHANNELS}/a`]);
    expect(api.seen.find((s) => s.method === "DELETE")?.headers["if-match"]).toBe(
      `"${NOTIFY_REVISION}"`,
    );
    const rows = c.db
      .query("SELECT action, target_name FROM people_events WHERE action LIKE 'notify%'")
      .all();
    expect(rows).toEqual([{ action: "notify-channel.delete", target_name: "a" }]);
  });
});

describe("failed and resend", () => {
  test("rows show the event text, manual only when isManual, Resend only with a payload", async () => {
    const api = fakeApi();
    const events = ["update", "budget-low", "tls-expiry", "domain-expiry", "unknown"];
    api.replyTo(
      "GET",
      FAILED,
      jsonReply(
        failedView(
          [
            ...events.map((event, i) => failedEntry({ key: `k${i}`, event, hasPayload: false })),
            failedEntry({ key: "m", event: "update", isManual: true }),
          ],
          { failedTotal: 9 },
        ),
      ),
    );
    const c = await teamConsole(api);
    const html = (await getPage(c, "/notifications/failed", c.cookies.owner)).body;
    const cells = [...html.matchAll(/<td>([^<]*)<\/td><td><time/g)].map((m) => m[1]);
    expect(cells).toEqual([...events, "update manual"]);
    expect(html.match(/name="request_id" value="[A-Za-z0-9_-]{24}"/g)).toHaveLength(1);
    expect(html).toContain("3 more failed deliveries are not listed.");
  });

  test("a timeout then a deliberate retry sends the same requestId with a fresh form token", async () => {
    const api = fakeApi();
    api.replyTo("POST", RESENDS, { status: 202, isHeld: true });
    const timers = new Set<() => void>();
    const c = await teamConsole(api, (fn) => {
      timers.add(fn);
      return () => timers.delete(fn);
    });
    const failed = (await getPage(c, "/notifications/failed", c.cookies.owner)).body;
    const requestId = /name="request_id" value="([^"]*)"/.exec(failed)?.[1] ?? "";
    const fields = { channel_id: "a", key: "1:opened", request_id: requestId };
    const firstToken = formTokenOf(failed, "/notifications/resend");
    const pending = post(c, "", "/notifications/resend", fields, { token: firstToken });
    while (!api.seen.some((s) => s.method === "POST") || timers.size !== 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (const fn of timers) fn();
    const first = await pending;
    expect(first.status).toBe(504);
    expect(first.body).toContain(`name="request_id" value="${requestId}"`);
    const retryToken = formTokenOf(first.body, "/notifications/resend");
    expect(retryToken).not.toBe(firstToken);
    api.replyTo("POST", RESENDS, { ...jsonReply(command("queued", requestId)), status: 200 });
    const second = await post(c, "", "/notifications/resend", fields, { token: retryToken });
    expect(second.status).toBe(303);
    expect(second.headers.get("location")).toBe(`/notifications/resend?id=${COMMAND_ID}`);
    const ids = api.seen
      .filter((s) => s.method === "POST")
      .map((s) => (JSON.parse(s.body) as { requestId: string }).requestId);
    expect(ids).toEqual([requestId, requestId]);
    expect(requestId).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(api.seen.some((s) => s.method === "POST" && s.headers["if-match"] !== undefined)).toBe(
      false,
    );
    const replay = await post(c, "", "/notifications/resend", fields, { token: retryToken });
    expect(replay.status).toBe(409);
    const rows = c.db
      .query(
        "SELECT action, target_kind, target_name, value FROM people_events WHERE action LIKE 'notify%'",
      )
      .all();
    expect(rows).toEqual([
      {
        action: "notify-resend.create",
        target_kind: "notify-resend",
        target_name: "a",
        value: "unknown",
      },
      {
        action: "notify-resend.create",
        target_kind: "notify-resend",
        target_name: "a",
        value: COMMAND_ID,
      },
    ]);
  });

  test("a 503 resend has its state; the command page shows the state", async () => {
    const api = fakeApi();
    api.replyTo("POST", RESENDS, {
      status: 503,
      headers: WIRE_HEADERS,
      body: JSON.stringify({ error: "pulse-notify has not reported recently" }),
    });
    const c = await teamConsole(api);
    const failed = (await getPage(c, "/notifications/failed", c.cookies.owner)).body;
    const requestId = /name="request_id" value="([^"]*)"/.exec(failed)?.[1] ?? "";
    const res = await post(c, "/notifications/failed", "/notifications/resend", {
      channel_id: "a",
      key: "1:opened",
      request_id: requestId,
    });
    expect(res.status).toBe(503);
    expect(res.body).toContain("pulse-api cannot take a resend now");
    const state = await getPage(c, `/notifications/resend?id=${COMMAND_ID}`, c.cookies.owner);
    expect(state.status).toBe(200);
    expect(state.body).toContain("Delivered.");
    expect((await getPage(c, "/notifications/resend?id=bad", c.cookies.owner)).status).toBe(404);
  });

  test("the failed list of an old api is 404 with its state", async () => {
    const api = fakeApi();
    api.replyTo("GET", FAILED, { status: 404, headers: WIRE_HEADERS, body: "{}" });
    const c = await teamConsole(api);
    const res = await getPage(c, "/notifications/failed", c.cookies.owner);
    expect(res.status).toBe(404);
    expect(res.body).toContain("This pulse-api is too old for this page.");
  });
});
