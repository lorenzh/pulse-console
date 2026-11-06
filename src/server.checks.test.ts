import { afterEach, describe, expect, test } from "bun:test";
import { escapeHtml } from "@lorenzh/pulse-kit";
import {
  checkConfig,
  checkExport,
  checkStates,
  checkUptime,
  LAST_RESULT_AT,
  QUOTE_URL,
  webLatency,
  webLocationUptime,
  webResults,
  webState,
} from "../test/check-fixtures.ts";
import {
  type FakeApi,
  type FakeReply,
  jsonReply,
  startFakeApi,
  UPSTREAM_SENTINEL,
  WIRE_HEADERS,
} from "../test/fake-api.ts";
import { expectCalloutsOnly } from "../test/rendered-audit.ts";
import {
  getPage,
  type SignedInConsole,
  type SignedInOptions,
  startSignedInConsole,
} from "../test/signed-in-console.ts";
import type { ConsoleRole } from "./roles.ts";

const TOKEN = "checks-admin-token-sentinel-0123456789";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function fakeApi(config: unknown = checkConfig): FakeApi {
  const api = startFakeApi();
  cleanups.push(() => api.stop());
  api.reply("/admin/config", jsonReply(config));
  api.reply("/checks", jsonReply(checkStates));
  api.reply("/admin/config/export", jsonReply(checkExport));
  return api;
}

async function consoleFor(
  api: FakeApi,
  options: Partial<SignedInOptions> & { role?: ConsoleRole } = {},
): Promise<SignedInConsole> {
  const { role, ...rest } = options;
  const c = await startSignedInConsole({
    apiUrl: api.url,
    adminToken: TOKEN,
    ...(role === undefined ? {} : { roleOf: () => role }),
    ...rest,
  });
  cleanups.push(() => c.close());
  return c;
}

function rowOf(body: string, id: string): string {
  const row = body.split("<tr>").find((part) => part.includes(`<code>${escapeHtml(id)}</code>`));
  return row ?? "";
}

function rowCount(body: string): number {
  const tbody = /<tbody>[\s\S]*<\/tbody>/.exec(body)?.[0] ?? "";
  return tbody.split("<tr>").length - 1;
}

function warnings(c: SignedInConsole): string[] {
  return c.logs.filter((line) => line.includes("api read failed"));
}

const failures: Array<[string, string, FakeReply, string]> = [
  [
    "rejected token",
    "/admin/config",
    { status: 401, headers: WIRE_HEADERS },
    "rejected the console token",
  ],
  ["status", "/checks", { status: 503, headers: WIRE_HEADERS }, "pulse-api answered 503."],
  [
    "redirect",
    "/admin/config",
    { status: 302, headers: { ...WIRE_HEADERS, location: "http://127.0.0.1:1/x" } },
    "pulse-api answered with a redirect (302); redirects are not followed.",
  ],
  [
    "wire",
    "/checks",
    { status: 200, body: "[]", headers: { ...WIRE_HEADERS, "x-pulse-contract": "2" } },
    "pulse-api speaks wire version 2; this console needs 1.",
  ],
  [
    "missing header",
    "/checks",
    { status: 200, body: "[]", headers: { "content-type": "application/json" } },
    "pulse-api sent no x-pulse-contract header.",
  ],
  ["invalid", "/admin/config", jsonReply({ nope: true }), "pulse-api sent an invalid answer."],
];

describe("GET /checks", () => {
  test("lists every type, state and source with the counts", async () => {
    const api = fakeApi();
    const c = await consoleFor(api);
    const res = await getPage(c, "/checks");
    expect(res.status).toBe(200);
    expect(res.body).toContain("6 checks, 1 shadowed definition");
    expect(rowCount(res.body)).toBe(7);
    for (const label of ["HTTP", "TLS", "TCP", "DNS", "Domain", "Heartbeat"]) {
      expect(res.body).toContain(
        `<td><span class="cell-sub">${label}</span><span class="cell-target">`,
      );
    }
    for (const head of ["Check", "Target", "State", "Actions"]) {
      expect(res.body).toContain(`<th scope="col">${head}</th>`);
    }
    expect(res.body).toContain(
      '<th scope="col">Check</th><th scope="col">Target</th><th scope="col">State</th><th scope="col">Actions</th>',
    );
    expect(res.body).not.toContain('<th scope="col">Last result</th>');
    expect(res.body).toContain(
      '<colgroup><col class="col-check"><col class="col-target"><col class="col-state"><col class="col-actions"></colgroup>',
    );
    expect(res.body).toContain('<span class="visually-hidden">Last result: </span>');
    expect(rowOf(res.body, "web")).toContain(
      '<td><span class="check-state check-state-up dense"><span class="dot" aria-hidden="true"></span><span>Up</span></span><span class="cell-sub mono"><span class="visually-hidden">Last result: </span>',
    );
    expect(rowOf(res.body, "cert")).toContain(
      '<td><span class="check-state check-state-degraded dense"><span class="dot" aria-hidden="true"></span><span>Degraded</span></span><span class="cell-sub mono">',
    );
    expect(rowOf(res.body, "db-port")).toContain(
      '<td><span class="check-state check-state-down dense"><span class="dot" aria-hidden="true"></span><span>Down</span></span><span class="cell-sub mono">',
    );
    expect(rowOf(res.body, "db-port")).toContain(
      '<code>db-port</code> <span class="tag tag-neutral">checks.json (read-only)</span></span></td>',
    );
    expect(rowOf(res.body, "web")).toContain(
      '<td><span class="cell-title">Web shop</span><span class="cell-sub"><code>web</code> <span class="tag tag-info">Console</span></span></td>',
    );
    expect(res.body).toContain(
      '<p class="table-scroll-hint">Scroll sideways to see all columns.</p>\n<div class="table-scroll" tabindex="0" role="region" aria-label="Checks table">',
    );
    expect(res.body).not.toContain("style=");
    expect(res.body).not.toContain("<style");
    expect(rowOf(res.body, "db-port")).toContain(
      '<span class="cell-target">db.internal:5432</span></td>',
    );
    expect(rowOf(res.body, "domain-exp")).toContain(
      '<td><span class="check-state check-state-unknown dense"><span class="dot" aria-hidden="true"></span><span>Unknown</span></span><span class="cell-sub mono"><span class="visually-hidden">Last result: </span>No results yet</span></td>',
    );
    expect(rowOf(res.body, "nightly-backup")).toContain(
      '<td><span class="check-state check-state-unknown dense"><span class="dot" aria-hidden="true"></span><span>Unknown</span></span><span class="cell-sub mono"><span class="visually-hidden">Last result: </span>',
    );
    expect(rowOf(res.body, "nightly-backup")).toContain(
      '<code>nightly-backup</code> <span class="tag tag-info">Console</span></span></td>',
    );
    expect(rowOf(res.body, "web")).toContain(
      `${'<span class="cell-sub mono"><span class="visually-hidden">Last result: </span>'}2026-11-05 11:59:30 UTC</span></td>`,
    );
    expect(rowOf(res.body, "web")).toContain(
      `<span class="cell-target">${escapeHtml(QUOTE_URL)}</span></td>`,
    );
    expect(res.body).toContain(
      '<td><span class="check-state check-state-maintenance dense"><span class="dot" aria-hidden="true"></span><span>Maintenance</span></span><span class="cell-sub mono">',
    );
    expect(res.body).toContain(
      '<td><span class="check-state check-state-shadowed dense"><span class="dot" aria-hidden="true"></span><span>Shadowed by checks.json</span></span></td>',
    );
    expect(res.body).toContain('<span class="cell-target">example.com AAAA</span></td>');
    expect(res.body).toContain('href="/checks/new"');
    expect(res.body).toContain('href="/checks/export"');
    expect(res.body).toContain('href="/checks/export?id=dns-a&amp;shadowed=1"');
    expect(res.body).toContain('href="/checks/shadowed?id=dns-a"');
    expect(res.body).toContain('href="/checks/check?id=nightly-backup"');
    expect(res.body).toContain('href="/checks/edit?id=web"');
    expect(res.body).not.toContain('href="/checks/edit?id=db-port"');
    expect(res.body).not.toContain('href="/checks/delete?id=db-port"');
    expect(res.body).toContain("<form");
    expect(res.body).not.toContain('method="post" action="/checks');
    expect(api.seen.map((s) => [s.method, s.path, s.authorization])).toEqual([
      ["GET", "/admin/config", `Bearer ${TOKEN}`],
      ["GET", "/checks", null],
    ]);
    expect(res.body).not.toContain(TOKEN);
  });

  test("a Viewer sees no member actions", async () => {
    const c = await consoleFor(fakeApi(), { role: "viewer" });
    const res = await getPage(c, "/checks");
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('href="/checks/new"');
    expect(res.body).not.toContain("/checks/export");
    expect(res.body).not.toContain("/checks/edit");
    expect(res.body).not.toContain("/checks/delete");
  });

  test("an overlong unbroken name and id stay whole and escaped in the Check cell", async () => {
    const name = `<b>Unbroken${"n".repeat(92)}`;
    const id = `unbroken${"x".repeat(56)}`;
    const config = {
      ...checkConfig,
      checks: [...checkConfig.checks, { ...checkConfig.checks[0], id, name }],
    };
    const c = await consoleFor(fakeApi(config));
    const res = await getPage(c, "/checks");
    expect(rowOf(res.body, id)).toContain(
      `<td><span class="cell-title">&lt;b&gt;Unbroken${"n".repeat(92)}</span><span class="cell-sub"><code>${id}</code> <span class="tag tag-info">Console</span></span></td>`,
    );
    expect(res.body).not.toContain("<b>Unbroken");
  });

  test("a Member gets edit but no delete links", async () => {
    const c = await consoleFor(fakeApi(), { role: "member" });
    const res = await getPage(c, "/checks");
    expect(res.body).toContain('href="/checks/edit?id=web"');
    expect(res.body).not.toContain("/checks/delete");
  });

  test("filters combine, round-trip and reset", async () => {
    const c = await consoleFor(fakeApi());
    const both = await getPage(c, "/checks?type=tcp&source=file");
    expect(rowCount(both.body)).toBe(1);
    expect(rowOf(both.body, "db-port")).not.toBe("");
    expect(both.body).toContain('<option value="tcp" selected>');
    expect(both.body).toContain('<option value="file" selected>');
    expect(both.body).toContain('<a href="/checks">Reset filters</a>');
    const q = await getPage(c, "/checks?q=%20BACKUP%20");
    expect(rowCount(q.body)).toBe(1);
    expect(q.body).toContain('value="BACKUP"');
    const target = await getPage(c, "/checks?q=db.internal");
    expect(rowCount(target.body)).toBe(1);
    const shadowed = await getPage(c, "/checks?source=shadowed");
    expect(rowCount(shadowed.body)).toBe(1);
    expect(shadowed.body).toContain("Shadowed by checks.json");
  });

  test("ignored filter values show the notice", async () => {
    const c = await consoleFor(fakeApi());
    for (const query of ["type=http&type=tcp", "state=shadowed", "type=", `q=${"x".repeat(201)}`]) {
      const res = await getPage(c, `/checks?${query}`);
      expect(res.body).toContain('<section class="callout callout-info" role="status">');
      expect(res.body).toContain("<p>Some filter values were not understood and were ignored.</p>");
      expectCalloutsOnly(res.body);
      expect(rowCount(res.body)).toBe(7);
    }
  });

  test("state never matches a shadowed row", async () => {
    const c = await consoleFor(fakeApi());
    const res = await getPage(c, "/checks?source=shadowed&state=up");
    expect(res.body).toContain("No checks match these filters");
    expect(res.body).toContain('href="/checks">Reset filters');
    expect(rowCount(res.body)).toBe(0);
  });

  test("an empty installation offers Add a check, or names who can", async () => {
    const empty = { ...checkConfig, checks: [], shadowed: [] };
    const owner = await consoleFor(fakeApi(empty));
    const res = await getPage(owner, "/checks");
    expect(res.body).toContain("No checks yet");
    expect(res.body).toContain('<a href="/checks/new">Add a check</a>');
    const viewer = await consoleFor(fakeApi(empty), { role: "viewer" });
    const seen = await getPage(viewer, "/checks");
    expect(seen.body).toContain("No checks yet");
    expect(seen.body).toContain(
      '<section class="empty-state">\n<h2>No checks yet</h2>\n<p>A member can add checks.</p>\n</section>',
    );
    expect(seen.body).not.toContain("/checks/new");
    expect(seen.body).not.toContain('class="button"');
    expectCalloutsOnly(seen.body);
  });

  test.each([
    ["member", true],
    ["viewer", false],
  ] as const)(
    "an empty installation keeps the %s export link and the ignored-values notice",
    async (role, hasExport) => {
      const empty = { ...checkConfig, checks: [], shadowed: [] };
      const c = await consoleFor(fakeApi(empty), { role });
      const res = await getPage(c, "/checks?type=invalid");
      expect(res.body).toContain("No checks yet");
      expect(res.body).toContain('<section class="callout callout-info" role="status">');
      expect(res.body).toContain("<p>Some filter values were not understood and were ignored.</p>");
      expectCalloutsOnly(res.body);
      expect(res.body.includes('<a href="/checks/export">Export as checks.json</a>')).toBe(
        hasExport,
      );
    },
  );

  test.each([
    ["invalid", "checks.json is invalid"],
    ["unreadable", "checks.json cannot be read"],
    ["written-not-applied", "checks.json was written but not applied"],
  ])("file state %s shows its banner", async (state, heading) => {
    const file = { state, message: "line 3: <bad>", lastAppliedAt: Date.UTC(2026, 10, 4, 8) };
    const c = await consoleFor(fakeApi({ ...checkConfig, file }));
    const res = await getPage(c, "/checks");
    expect(res.status).toBe(200);
    expect(res.body).toContain(`<section class="callout callout-info" role="alert">`);
    expect(res.body).toContain(`<h2 class="callout-title">${heading}</h2>`);
    expectCalloutsOnly(res.body);
    expect(res.body).toContain("line 3: &lt;bad&gt;");
    expect(res.body).toContain(
      '<p>The last valid version from <span class="mono">2026-11-04 08:00:00 UTC</span> stays in use.</p>',
    );
    expect(res.body).toContain("Console checks can still be changed.");
    expect(res.body).toContain('href="/checks/edit?id=web"');
  });

  test("an api without check sources gets the old-api state", async () => {
    const old = { revision: checkConfig.revision, checks: [{ id: "web" }] };
    const c = await consoleFor(fakeApi(old));
    const res = await getPage(c, "/checks");
    expect(res.status).toBe(200);
    expect(res.body).toContain(
      "This pulse-api is too old for the Checks pages. It needs check sources (pulse-api with #565).",
    );
    expect(res.body).not.toContain("/checks/new");
  });

  test("no token reads nothing", async () => {
    const api = fakeApi();
    const c = await consoleFor(api, { adminToken: undefined });
    const res = await getPage(c, "/checks");
    expect(res.status).toBe(200);
    expect(res.body).toContain("pulse-api is not available");
    expect(api.seen).toEqual([]);
  });

  test.each(failures)(
    "%s answers 200 with its state and one warning",
    async (_, path, reply, text) => {
      const api = fakeApi();
      api.reply(path, reply);
      const c = await consoleFor(api);
      const res = await getPage(c, "/checks");
      expect(res.status).toBe(200);
      expect(res.body).toContain(escapeHtml(text));
      expect(warnings(c)).toHaveLength(1);
      expect(res.body).not.toContain(UPSTREAM_SENTINEL);
      expect(res.body).not.toContain(TOKEN);
      expect(api.seen.filter((s) => s.path === "/x")).toEqual([]);
    },
  );

  test("a held read times out with one warning", async () => {
    const api = fakeApi();
    api.reply("/checks", { status: 200, isHeld: true });
    const pending = new Set<() => void>();
    const c = await consoleFor(api, {
      schedule: (fn) => {
        pending.add(fn);
        return () => pending.delete(fn);
      },
    });
    const page = getPage(c, "/checks");
    await api.received("/checks");
    // The config read cancels its timer when it answers; then only the held read's timer is left.
    while (pending.size !== 1) await new Promise((resolve) => setImmediate(resolve));
    for (const fn of pending) fn();
    const res = await page;
    expect(res.status).toBe(200);
    expect(res.body).toContain("pulse-api did not answer within 5 seconds.");
    expect(warnings(c)).toHaveLength(1);
  });

  test("an unreachable api answers 200 with the unreachable state", async () => {
    const c = await consoleFor({ ...fakeApi(), url: "http://127.0.0.1:1" });
    const res = await getPage(c, "/checks");
    expect(res.status).toBe(200);
    expect(res.body).toContain("pulse-api cannot be reached");
    expect(warnings(c)).toHaveLength(2);
  });

  test("the ids . and .. are listed without edit or delete", async () => {
    const dot = { ...checkConfig.checks[5], id: ".", name: "Dot" };
    const dots = { ...checkConfig.checks[1], id: "..", name: "Dots" };
    const api = fakeApi({ ...checkConfig, checks: [dot, dots], shadowed: [] });
    const c = await consoleFor(api);
    const res = await getPage(c, "/checks");
    expect(rowCount(res.body)).toBe(2);
    expect(res.body).toContain('href="/checks/check?id=."');
    expect(res.body).toContain('href="/checks/check?id=.."');
    expect(res.body).toContain('href="/checks/export?id=.."');
    expect(res.body).not.toContain("/checks/edit");
    expect(res.body).not.toContain("/checks/delete");
    expect(api.seen.map((s) => s.path)).toEqual(["/admin/config", "/checks"]);
  });
});

function expectDownload(res: { status: number; headers: Headers }, filename: string): void {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${filename}"`);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
}

describe("GET /checks/export", () => {
  test("no query downloads the api's whole export", async () => {
    const api = fakeApi();
    const c = await consoleFor(api, { role: "member" });
    const res = await getPage(c, "/checks/export");
    expectDownload(res, "checks.json");
    expect(JSON.parse(res.body)).toEqual(checkExport);
    expect(res.body.startsWith('{\n  "checks": [\n    {\n      "id": "web",')).toBe(true);
    expect(res.body.endsWith("}\n")).toBe(true);
    expect(api.seen.map((s) => [s.method, s.path, s.authorization])).toEqual([
      ["GET", "/admin/config/export", `Bearer ${TOKEN}`],
    ]);
  });

  test("?id= downloads one check with its maintenance and redactions", async () => {
    const c = await consoleFor(fakeApi());
    const res = await getPage(c, "/checks/export?id=web");
    expectDownload(res, "check.json");
    expect(res.body).toBe(`{
  "checks": [
    {
      "id": "web",
      "name": "Web shop",
      "url": "https://a';id;'b/",
      "method": "POST",
      "intervalMs": 60000,
      "headers": {
        "Authorization": {
          "env": "PULSE_HEADER_TOKEN"
        }
      }
    }
  ],
  "components": [],
  "maintenance": [],
  "redacted": [
    {
      "checkId": "web",
      "field": "headers.X-Api-Key"
    },
    {
      "checkId": "web",
      "field": "body"
    }
  ]
}
`);
    const dns = await getPage(c, "/checks/export?id=dns-a");
    expect(JSON.parse(dns.body)).toEqual({
      checks: [
        {
          id: "dns-a",
          name: "DNS record",
          type: "dns",
          dnsName: "example.com",
          recordType: "A",
          intervalMs: 60000,
        },
      ],
      components: [],
      maintenance: [
        {
          checkId: "dns-a",
          start: "2026-11-06T00:00:00.000Z",
          end: "2026-11-06T02:00:00.000Z",
          note: "Resolver move",
        },
      ],
    });
  });

  test("?id=&shadowed=1 builds the shadowed definition from /admin/config", async () => {
    const api = fakeApi();
    const c = await consoleFor(api);
    const res = await getPage(c, "/checks/export?id=dns-a&shadowed=1");
    expectDownload(res, "check.json");
    expect(JSON.parse(res.body)).toEqual({
      checks: [
        {
          id: "dns-a",
          name: "DNS record (old)",
          type: "dns",
          dnsName: "example.com",
          recordType: "AAAA",
          intervalMs: 60000,
        },
      ],
      components: [],
      maintenance: [],
    });
    expect(res.body).not.toContain("keep");
    expect(res.body).not.toContain("source");
    expect(api.seen.map((s) => s.path)).toEqual(["/admin/config"]);
  });

  test("HEAD sends the headers without a body", async () => {
    const c = await consoleFor(fakeApi());
    const res = await fetch(`${c.base}/checks/export`, {
      method: "HEAD",
      headers: { cookie: c.cookie },
    });
    expectDownload(res, "checks.json");
    expect(await res.text()).toBe("");
  });

  test.each([
    "?id=missing",
    "?id=missing&shadowed=1",
    "?id=web&shadowed=1",
    "?id=",
    "?id=web&id=cert",
    "?shadowed=1&id=dns-a",
    "?id=dns-a&shadowed=2",
    "?id=dns-a&shadowed=1&x=1",
    "?x=1",
  ])("%s answers 404", async (query) => {
    const c = await consoleFor(fakeApi());
    const res = await getPage(c, `/checks/export${query}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-disposition")).toBeNull();
  });

  test("a Viewer gets 403 and nothing is read", async () => {
    const api = fakeApi();
    const c = await consoleFor(api, { role: "viewer" });
    const res = await getPage(c, "/checks/export");
    expect(res.status).toBe(403);
    expect(api.seen).toEqual([]);
  });

  test("the ids . and .. export from the export document alone", async () => {
    const dots = { ...checkExport.checks[1], id: ".." };
    const api = fakeApi();
    api.reply(
      "/admin/config/export",
      jsonReply({ ...checkExport, checks: [dots], redacted: undefined }),
    );
    const c = await consoleFor(api);
    const res = await getPage(c, "/checks/export?id=..");
    expectDownload(res, "check.json");
    expect(JSON.parse(res.body).checks[0].id).toBe("..");
    expect(api.seen.map((s) => s.path)).toEqual(["/admin/config/export"]);
  });

  test("a failed export read answers the failure state with one warning", async () => {
    const api = fakeApi();
    api.reply("/admin/config/export", { status: 403, headers: WIRE_HEADERS });
    const c = await consoleFor(api);
    const res = await getPage(c, "/checks/export");
    expect(res.status).toBe(502);
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.body).toContain("The console token lacks the read or checks scope.");
    expect(warnings(c)).toHaveLength(1);
  });

  test("route metric labels hold no id, query or token", async () => {
    const c = await consoleFor(fakeApi());
    await getPage(c, "/checks?q=secret-query");
    await getPage(c, "/checks/export?id=dns-a&shadowed=1");
    const text = c.metrics.render();
    expect(text).toContain('path="/checks",code="200"');
    expect(text).toContain('path="/checks/export",code="200"');
    for (const bad of ["dns-a", "secret-query", "shadowed=", TOKEN]) {
      expect(text).not.toContain(bad);
    }
  });
});

const ROUND_2 = [
  "/uptime",
  "/checks/web/results",
  "/checks/web/location-uptime",
  "/checks/web/latency",
];
const HOST_LINE = `PULSE_PROBE_HEADER_HOSTS='{"PULSE_HEADER_TOKEN":["a'\\'';id;'\\''b"]}'`;
const UNSAFE_TEMPLATE = `["a';id;'b"]}'`;
const DOTS_TEXT = (id: string) =>
  `pulse-api cannot address the id "${id}" in a URL path, so its results, per-location uptime and latency cannot be read. Rename the check to use them.`;

/** A fake api with every detail read of the fixture answered. */
function detailApi(config: unknown = checkConfig): FakeApi {
  const api = fakeApi(config);
  api.reply("/checks", jsonReply([webState, ...checkStates.slice(1)]));
  api.reply("/uptime", jsonReply(checkUptime));
  api.reply("/checks/web/results", jsonReply(webResults));
  api.reply("/checks/web/location-uptime", jsonReply(webLocationUptime));
  api.reply("/checks/web/latency", jsonReply(webLatency));
  return api;
}

function byText(a: string, b: string): number {
  return a.localeCompare(b);
}

function seenRequests(api: FakeApi): string[] {
  return api.seen.map((s) => `${s.method} ${s.rawPath}`);
}

function tbodyRows(body: string, heading: string): number {
  const panel = body.split(`<h2 class="eyebrow">${heading}</h2>`)[1]?.split("</section>")[0] ?? "";
  const tbody = /<tbody>[\s\S]*?<\/tbody>/.exec(panel)?.[0] ?? "";
  return tbody.split("<tr>").length - 1;
}

describe("GET /checks/check", () => {
  test("the maintenance window shows its times in mono", async () => {
    const c = await consoleFor(detailApi(), { role: "viewer" });
    const res = await getPage(c, "/checks/check?id=dns-a");
    expect(res.status).toBe(200);
    expect(res.body).toContain(
      '<dt>Maintenance</dt><dd><span class="mono">1970-01-01 00:00:00 UTC</span> to <span class="mono">2100-01-01 00:00:00 UTC</span>: Window</dd>',
    );
  });

  test("shows settings, state, locations, uptime, latency and results of an HTTP check", async () => {
    const api = detailApi();
    const c = await consoleFor(api, { role: "viewer" });
    const res = await getPage(c, "/checks/check?id=web");
    expect(res.status).toBe(200);
    const seen = seenRequests(api);
    expect(seen.slice(0, 2).toSorted(byText)).toEqual(["GET /admin/config", "GET /checks"]);
    expect(seen.slice(2).toSorted(byText)).toEqual([
      "GET /checks/web/latency",
      "GET /checks/web/location-uptime",
      "GET /checks/web/results",
      "GET /uptime",
    ]);
    expect(api.seen.find((s) => s.path === "/checks/web/results")?.query).toBe("?limit=20");
    for (const s of api.seen.filter((s) => ROUND_2.includes(s.path))) {
      expect(s.authorization).toBeNull();
    }
    // Settings: env names as stored, write-only values only as `set`.
    expect(res.body).toContain(
      "<dt>Header Authorization</dt><dd>Secret from the probe environment: PULSE_HEADER_TOKEN</dd>",
    );
    expect(res.body).toContain("<dt>Header X-Api-Key</dt><dd>set</dd>");
    expect(res.body).toContain("<dt>Body</dt><dd>set</dd>");
    expect(res.body).toContain('<dt>Source</dt><dd><span class="tag tag-info">Console</span></dd>');
    // The host-binding line, escaped once, never the old template.
    expect(res.body).toContain(`<pre id="host-binding-line">${escapeHtml(HOST_LINE)}</pre>`);
    expect(res.body).toContain(
      '<button type="button" class="secondary small" data-copy="host-binding-line" hidden>Copy</button>',
    );
    expect(res.body).not.toContain(escapeHtml(UNSAFE_TEMPLATE));
    expect(res.body).not.toContain(UNSAFE_TEMPLATE);
    // R6/R11: panels with eyebrow headings, labelled table boxes, mono settings values.
    expect(res.body).toContain(
      '<section class="panel">\n<div class="panel-head"><h2 class="eyebrow">Settings</h2></div>\n<div class="panel-body">',
    );
    for (const name of ["Locations", "Uptime", "Latency", "Recent results"]) {
      expect(res.body).toContain(
        `<div class="table-scroll" tabindex="0" role="region" aria-label="${name} table">`,
      );
    }
    expect(res.body).not.toContain("table-scroll-hint");
    expect(res.body).toContain('<dt>Id</dt><dd><span class="mono">web</span></dd>');
    for (const term of [
      "Name",
      "Type",
      "Source",
      "State",
      "Consecutive down",
      "Last result",
      "Last reason",
    ]) {
      expect(res.body).toContain(`<dt>${term}</dt>`);
    }
    expect(res.body).toContain('<th scope="col" class="num">Latency</th>');
    expectCalloutsOnly(res.body);
    // State and SLO with a negative budget whose rounded text is -0.0.
    expect(res.body).toContain(
      '<dt>State</dt><dd><span class="check-state check-state-up"><span class="dot" aria-hidden="true"></span><span>Up</span></span></dd>',
    );
    expect(res.body).toContain(
      "Availability 99.95 % over 30 days, objective 99.9 %. Error budget exceeded (-0.0 %)",
    );
    // Locations joined by name, in code-unit order, with a row for a name only on one side.
    expect(res.body).toContain(
      "Every probe runs this check. It is down when at least two locations report down; with one reporting location, that location decides.",
    );
    expect(tbodyRows(res.body, "Locations")).toBe(4);
    expect(res.body).toContain(
      '<tr><td>ap</td><td><span class="check-state check-state-up dense"><span class="dot" aria-hidden="true"></span><span>Up</span></span></td><td class="mono">2026-11-05 11:59:30 UTC</td><td class="num">120 ms</td><td class="num">1</td><td></td><td></td><td class="num">No results in 90 days</td></tr>',
    );
    expect(res.body).toContain(
      '<tr><td>eu</td><td><span class="check-state check-state-degraded dense"><span class="dot" aria-hidden="true"></span><span>Degraded</span></span></td><td class="mono">2026-11-05 11:59:30 UTC</td><td class="num">120 ms</td><td class="num">1</td><td></td><td></td><td class="num">80.00 % with 4 of 5 results</td></tr>',
    );
    expect(res.body).toContain(
      '<tr><td>old</td><td>No current result</td><td class="mono"></td><td class="num"></td><td class="num"></td><td></td><td></td><td class="num">No results in 90 days</td></tr>',
    );
    expect(res.body).toContain(
      '<tr><td>us</td><td><span class="check-state check-state-down dense"><span class="dot" aria-hidden="true"></span><span>Down</span></span></td><td class="mono">2026-11-05 09:59:30 UTC</td><td class="num">120 ms</td><td class="num">3</td><td>connect timeout</td><td>Stale</td><td class="num">99.90 % with 999 of 1000 results</td></tr>',
    );
    // Aggregate uptime over 90 days, never rounded up.
    expect(res.body).toContain("<p>99.99 % over 90 days</p>");
    expect(res.body).toContain(
      '<tr><td class="mono">2026-08-08</td><td class="num">No results</td><td class="num">0</td></tr>',
    );
    expect(tbodyRows(res.body, "Uptime")).toBe(90);
    // Latency newest first: 14 rows visible, the remaining 76 in details.
    const latency =
      res.body.split('<h2 class="eyebrow">Latency</h2>')[1]?.split("</section>")[0] ?? "";
    const [visible, older] = latency.split("<details>");
    expect((visible ?? "").split("<tr>").length - 2).toBe(14);
    expect((older ?? "").split("<tr>").length - 2).toBe(76);
    expect(visible).toContain(
      '<tr><td class="mono">2026-11-05</td><td class="num">189 ms</td><td class="num">389 ms</td><td class="num">10</td></tr>',
    );
    expect(older).toContain(
      '<tr><td class="mono">2026-08-08</td><td class="num">No results</td><td class="num">No results</td><td class="num">0</td></tr>',
    );
    // A complete timestamp group: 21 rows for limit=20, then one Older link.
    expect(tbodyRows(res.body, "Recent results")).toBe(21);
    const last = LAST_RESULT_AT - 19 * 60000;
    expect(res.body).toContain(`href="/checks/check?id=web&amp;before=${last}">Older results</a>`);
    expect(res.body).not.toContain("Newest results");
    // A Viewer gets no member action; no mutation form at all.
    expect(res.body).not.toContain("/checks/export");
    expect(res.body).not.toContain("/checks/edit");
    expect(res.body).not.toContain('method="post" action="/checks');
    expect(res.body).not.toContain(TOKEN);
  });

  test("round-1 reads run together, then round-2 reads run together", async () => {
    const api = detailApi();
    let openChecks = (): void => undefined;
    let openUptime = (): void => undefined;
    api.reply("/checks", {
      ...jsonReply([webState]),
      gate: new Promise<void>((resolve) => {
        openChecks = resolve;
      }),
    });
    api.reply("/uptime", {
      ...jsonReply(checkUptime),
      gate: new Promise<void>((resolve) => {
        openUptime = resolve;
      }),
    });
    const c = await consoleFor(api);
    const page = getPage(c, "/checks/check?id=web");
    await api.received("/admin/config");
    await api.received("/checks");
    expect(api.seen.map((s) => s.path)).toEqual(["/admin/config", "/checks"]);
    openChecks();
    for (const path of ROUND_2) await api.received(path);
    expect(api.seen).toHaveLength(6);
    openUptime();
    expect((await page).status).toBe(200);
  });

  test("a TLS check reads no latency and shows its certificate days", async () => {
    const api = detailApi();
    const cert = { ...checkStates[1], certDaysLeft: 12 };
    api.reply("/checks", jsonReply([cert]));
    api.reply("/checks/cert/results", jsonReply([]));
    api.reply(
      "/checks/cert/location-uptime",
      jsonReply({ checkId: "cert", windowDays: 90, locations: [] }),
    );
    const c = await consoleFor(api);
    const res = await getPage(c, "/checks/check?id=cert");
    expect(res.status).toBe(200);
    expect(api.seen.map((s) => s.path).toSorted(byText)).toEqual([
      "/admin/config",
      "/checks",
      "/checks/cert/location-uptime",
      "/checks/cert/results",
      "/uptime",
    ]);
    expect(res.body).not.toContain('<h2 class="eyebrow">Latency</h2>');
    expect(res.body).toContain(
      '<dt>Certificate days left</dt><dd><span class="mono">12</span></dd>',
    );
    expect(res.body).toContain(
      '<dt>State</dt><dd><span class="check-state check-state-degraded"><span class="dot" aria-hidden="true"></span><span>Degraded</span></span></dd>',
    );
    expect(res.body).toContain("<p>No availability objective</p>");
    expect(res.body).toContain("<p>No location has reported yet.</p>");
    expect(res.body).toContain("<p>No results yet</p>");
    expect(res.body).not.toContain("host-binding-line");
  });

  test("an SLO without results says so", async () => {
    const api = detailApi();
    const slo = { target: 99.5, windowDays: 30, availability: null, budgetRemaining: null };
    api.reply("/checks", jsonReply([{ ...webState, slo }]));
    const c = await consoleFor(api);
    const res = await getPage(c, "/checks/check?id=web");
    expect(res.body).toContain("<p>Objective 99.5 %: no results in the last 30 days</p>");
  });

  test("a heartbeat check shows the quoted curl line, its pings and the copy button", async () => {
    const api = detailApi();
    const heartbeatState = {
      ...webState,
      id: "nightly-backup",
      locations: [
        {
          location: "heartbeat",
          result: {
            ...webState.locations[0]?.result,
            checkId: "nightly-backup",
            location: "heartbeat",
          },
          stale: false,
        },
      ],
    };
    const withoutSlo: Record<string, unknown> = { ...heartbeatState };
    delete withoutSlo.slo;
    api.reply("/checks", jsonReply([withoutSlo]));
    api.reply("/checks/nightly-backup/results", jsonReply([]));
    api.reply(
      "/checks/nightly-backup/location-uptime",
      jsonReply({
        checkId: "nightly-backup",
        windowDays: 90,
        locations: [{ location: "heartbeat", good: 30, results: 30, uptime: 100 }],
      }),
    );
    const c = await consoleFor(api);
    const res = await getPage(c, "/checks/check?id=nightly-backup");
    expect(res.status).toBe(200);
    const line = `curl -fsS -X POST -H 'Authorization: Bearer <secret>' '${api.url}/heartbeat/nightly-backup'`;
    expect(res.body).toContain(`<pre id="heartbeat-line">${escapeHtml(line)}</pre>`);
    expect(res.body).toContain(
      '<button type="button" class="secondary small" data-copy="heartbeat-line" hidden>Copy</button>',
    );
    expect(res.body).toContain(
      "Use the address under which your job reaches pulse-api. The secret is not shown again.",
    );
    expect(res.body).toContain("<dt>Secret</dt><dd>set</dd>");
    expect(res.body).toContain("Heartbeat checks are not run by probes; your job pings pulse-api.");
    expect(res.body).not.toContain("Every probe runs this check.");
    expect(res.body).toContain(
      '<tr><td>Heartbeat pings</td><td><span class="check-state check-state-up dense"><span class="dot" aria-hidden="true"></span><span>Up</span></span></td><td class="mono">2026-11-05 11:59:30 UTC</td><td class="num">Not applicable</td>',
    );
    expect(res.body).toContain('<td class="num">100 % with 30 of 30 results</td>');
    expect(api.seen.some((s) => s.path.endsWith("/latency"))).toBe(false);
  });

  test("a valid before asks for that page and links the newest results", async () => {
    const api = detailApi();
    const c = await consoleFor(api);
    const res = await getPage(c, "/checks/check?id=web&before=1700000000000");
    expect(api.seen.find((s) => s.path === "/checks/web/results")?.query).toBe(
      "?limit=20&before=1700000000000",
    );
    expect(res.body).toContain('<a href="/checks/check?id=web">Newest results</a>');
    expect(api.seen.filter((s) => s.path === "/checks/web/results")).toHaveLength(1);
  });

  test.each(["abc", "-1", "12345678901234567", "1&before=2"])(
    "an invalid before %s gives the first page",
    async (before) => {
      const api = detailApi();
      const c = await consoleFor(api);
      const res = await getPage(c, `/checks/check?id=web&before=${before}`);
      expect(res.status).toBe(200);
      expect(api.seen.find((s) => s.path === "/checks/web/results")?.query).toBe("?limit=20");
      expect(res.body).not.toContain("Newest results");
    },
  );

  const panelFailures: Array<[string, string, FakeReply, string, string]> = [
    [
      "results",
      "/checks/web/results",
      { status: 503, headers: WIRE_HEADERS },
      "pulse-api answered 503.",
      "Recent results",
    ],
    ["uptime", "/uptime", jsonReply({ nope: true }), "pulse-api sent an invalid answer.", "Uptime"],
    [
      "latency",
      "/checks/web/latency",
      { status: 200, body: "{}", headers: { ...WIRE_HEADERS, "x-pulse-contract": "2" } },
      "pulse-api speaks wire version 2; this console needs 1.",
      "Latency",
    ],
    [
      "location uptime",
      "/checks/web/location-uptime",
      {
        status: 200,
        body: JSON.stringify(webLocationUptime),
        headers: { "content-type": "application/json" },
      },
      "pulse-api sent no x-pulse-contract header.",
      "Locations",
    ],
  ];

  test.each(panelFailures)(
    "a failed %s read fails only its panel",
    async (_, path, reply, text, heading) => {
      const api = detailApi();
      api.reply(path, reply);
      const c = await consoleFor(api);
      const res = await getPage(c, "/checks/check?id=web");
      expect(res.status).toBe(200);
      const panel =
        res.body
          .split(`<h2 class="eyebrow">${heading}</h2>`)[1]
          ?.split("</div>\n</section>\n<section")[0] ?? "";
      expect(panel).toContain(escapeHtml(text));
      expect(res.body.split(escapeHtml(text))).toHaveLength(2);
      expect(warnings(c)).toHaveLength(1);
      expect(res.body).toContain(
        '<dt>State</dt><dd><span class="check-state check-state-up"><span class="dot" aria-hidden="true"></span><span>Up</span></span></dd>',
      );
      expect(res.body).not.toContain(UPSTREAM_SENTINEL);
      for (const other of ["Recent results", "Uptime", "Latency", "Locations"]) {
        expect(res.body).toContain(`<h2 class="eyebrow">${other}</h2>`);
      }
    },
  );

  test("a 404 from location uptime shows only the newer-api text", async () => {
    const api = detailApi();
    api.reply("/checks/web/location-uptime", { status: 404, headers: WIRE_HEADERS, body: "{}" });
    const c = await consoleFor(api);
    const res = await getPage(c, "/checks/check?id=web");
    expect(res.status).toBe(200);
    expect(res.body).toContain("<p>Location uptime needs a newer pulse-api.</p>");
    expect(res.body).not.toContain("pulse-api answered 404.");
    expect(res.body).toContain('<td class="num">Not available</td>');
    expect(res.body).toContain("<p>99.99 % over 90 days</p>");
    expect(tbodyRows(res.body, "Recent results")).toBe(21);
  });

  test.each(failures)(
    "a round-1 %s failure answers 200 with its shared state",
    async (_, path, reply, text) => {
      const api = detailApi();
      api.reply(path, reply);
      const c = await consoleFor(api);
      const res = await getPage(c, "/checks/check?id=web");
      expect(res.status).toBe(200);
      expect(res.body).toContain(escapeHtml(text));
      expect(warnings(c)).toHaveLength(1);
      expect(api.seen.map((s) => s.path).toSorted(byText)).toEqual(["/admin/config", "/checks"]);
      expect(res.body).not.toContain(UPSTREAM_SENTINEL);
      expect(res.body).not.toContain(TOKEN);
    },
  );

  test("a held round-1 read times out with the shared state", async () => {
    const api = detailApi();
    api.reply("/checks", { status: 200, isHeld: true });
    const pending = new Set<() => void>();
    const c = await consoleFor(api, {
      schedule: (fn) => {
        pending.add(fn);
        return () => pending.delete(fn);
      },
    });
    const page = getPage(c, "/checks/check?id=web");
    await api.received("/checks");
    while (pending.size !== 1) await new Promise((resolve) => setImmediate(resolve));
    for (const fn of pending) fn();
    const res = await page;
    expect(res.status).toBe(200);
    expect(res.body).toContain("pulse-api did not answer within 5 seconds.");
  });

  test("no token, an unreachable api and an old api use the shared states", async () => {
    const api = detailApi();
    const noToken = await consoleFor(api, { adminToken: undefined });
    expect((await getPage(noToken, "/checks/check?id=web")).body).toContain(
      "pulse-api is not available",
    );
    expect(api.seen).toEqual([]);
    const away = await consoleFor({ ...detailApi(), url: "http://127.0.0.1:1" });
    expect((await getPage(away, "/checks/check?id=web")).body).toContain(
      "pulse-api cannot be reached",
    );
    const old = detailApi({ revision: checkConfig.revision, checks: [{ id: "web" }] });
    const oldConsole = await consoleFor(old);
    const res = await getPage(oldConsole, "/checks/check?id=web");
    expect(res.status).toBe(200);
    expect(res.body).toContain(
      "This pulse-api is too old for the Checks pages. It needs check sources (pulse-api with #565).",
    );
    expect(old.seen.map((s) => s.path).toSorted(byText)).toEqual(["/admin/config", "/checks"]);
  });

  test.each(["", "?id=", "?id=web&id=web", "?id=unknown", "?ID=web"])(
    "%s answers the shell 404",
    async (query) => {
      const api = detailApi();
      const c = await consoleFor(api);
      const res = await getPage(c, `/checks/check${query}`);
      expect(res.status).toBe(404);
      expect(res.body).toContain("There is no page at this address; go to the overview.");
      expect(api.seen.every((s) => s.path === "/admin/config" || s.path === "/checks")).toBe(true);
    },
  );

  test("ids enter api paths encoded as one segment, also over 1024 code units", async () => {
    const long = "x".repeat(1025);
    const ids = ["a/b", "%2e", "...", long];
    const checks = ids.map((id) => ({ ...checkConfig.checks[1], id }));
    const api = detailApi({ ...checkConfig, checks, shadowed: [] });
    const c = await consoleFor(api);
    for (const id of ids) {
      const res = await getPage(c, `/checks/check?id=${encodeURIComponent(id)}`);
      expect(res.status).toBe(200);
    }
    const paths = api.seen.map((s) => s.rawPath).filter((p) => p.endsWith("/results"));
    expect(paths).toEqual([
      "/checks/a%2Fb/results",
      "/checks/%252e/results",
      "/checks/.../results",
      `/checks/${long}/results`,
    ]);
  });

  test("the id .. is shown from /admin/config and /uptime without per-id reads", async () => {
    const dots = { ...checkConfig.checks[0], id: "..", name: "Dots" };
    const api = detailApi({ ...checkConfig, checks: [dots], shadowed: [] });
    const c = await consoleFor(api);
    const res = await getPage(c, "/checks/check?id=..");
    expect(res.status).toBe(200);
    expect(seenRequests(api)).toEqual(["GET /admin/config", "GET /checks", "GET /uptime"]);
    expect(res.body.split(escapeHtml(DOTS_TEXT(".."))).length - 1).toBe(3);
    expect(res.body).toContain("<p>99.99 % over 90 days</p>");
    expect(res.body).toContain('href="/checks/export?id=.."');
    expect(res.body).not.toContain("/checks/edit");
    expect(res.body).not.toContain("/checks/delete");
  });

  test("a heartbeat id . shows the fixed text and no curl line", async () => {
    const dot = { ...checkConfig.checks[5], id: ".", name: "Dot" };
    const api = detailApi({ ...checkConfig, checks: [dot], shadowed: [] });
    const c = await consoleFor(api);
    const res = await getPage(c, "/checks/check?id=.");
    expect(res.status).toBe(200);
    expect(res.body).toContain(
      escapeHtml(
        'pulse-api cannot address the id "." in a URL path, so pulse-api cannot receive pings for it. Rename the check.',
      ),
    );
    expect(res.body).not.toContain("curl");
    expect(res.body).not.toContain("heartbeat-line");
    expect(seenRequests(api)).toEqual(["GET /admin/config", "GET /checks", "GET /uptime"]);
  });

  test.each([
    ["viewer", 200, false, false, 403],
    ["member", 200, true, false, 200],
    ["admin", 200, true, true, 200],
    ["owner", 200, true, true, 200],
  ] as const)(
    "a %s reads the detail; export link %s, delete link %s; direct export %s",
    async (role, status, hasExport, hasDelete, exportStatus) => {
      const api = detailApi();
      const c = await consoleFor(api, { role });
      const res = await getPage(c, "/checks/check?id=web");
      expect(res.status).toBe(status);
      expect(res.body.includes('href="/checks/export?id=web"')).toBe(hasExport);
      expect(res.body.includes('href="/checks/delete?id=web"')).toBe(hasDelete);
      expect(res.body.includes('href="/checks/edit?id=web"')).toBe(hasExport);
      expect((await getPage(c, "/checks/export?id=web")).status).toBe(exportStatus);
    },
  );
});

describe("GET /checks/shadowed", () => {
  test("shows the stored definition without runtime data", async () => {
    const api = detailApi();
    const c = await consoleFor(api, { role: "admin" });
    const res = await getPage(c, "/checks/shadowed?id=dns-a");
    expect(res.status).toBe(200);
    expect(seenRequests(api)).toEqual(["GET /admin/config"]);
    expect(res.body).toContain('<section class="callout callout-info" role="status">');
    expect(res.body).toContain(
      "<p>Shadowed by checks.json: the check from checks.json runs instead. This definition is kept in the database.</p>",
    );
    expectCalloutsOnly(res.body);
    expect(res.body).toContain("<dt>Name</dt><dd>DNS record (old)</dd>");
    expect(res.body).toContain("<dt>recordType</dt><dd>AAAA</dd>");
    expect(res.body).toContain('href="/checks/check?id=dns-a"');
    expect(res.body).toContain('href="/checks/export?id=dns-a&amp;shadowed=1"');
    expect(res.body).toContain('href="/checks/delete?id=dns-a&amp;shadowed=1"');
    expect(res.body).not.toContain("/checks/edit");
    for (const runtime of [
      '<h2 class="eyebrow">State</h2>',
      '<h2 class="eyebrow">Uptime</h2>',
      '<h2 class="eyebrow">Latency</h2>',
      '<h2 class="eyebrow">Recent results</h2>',
      '<h2 class="eyebrow">Locations</h2>',
      "objective",
    ]) {
      expect(res.body).not.toContain(runtime);
    }
  });

  test("a Viewer gets neither Export nor Delete", async () => {
    const c = await consoleFor(detailApi(), { role: "viewer" });
    const res = await getPage(c, "/checks/shadowed?id=dns-a");
    expect(res.status).toBe(200);
    expect(res.body).not.toContain("/checks/export");
    expect(res.body).not.toContain("/checks/delete");
  });

  test.each(["", "?id=", "?id=dns-a&id=dns-a", "?id=web"])("%s answers 404", async (query) => {
    const c = await consoleFor(detailApi());
    expect((await getPage(c, `/checks/shadowed${query}`)).status).toBe(404);
  });

  test("a shadowed id .. stays viewable and exportable", async () => {
    const dots = { ...checkConfig.shadowed[0], id: ".." };
    const api = detailApi({ ...checkConfig, shadowed: [dots] });
    const c = await consoleFor(api);
    const res = await getPage(c, "/checks/shadowed?id=..");
    expect(res.status).toBe(200);
    expect(res.body).toContain('href="/checks/export?id=..&amp;shadowed=1"');
    expect(res.body).not.toContain("/checks/delete");
    const download = await getPage(c, "/checks/export?id=..&shadowed=1");
    expectDownload(download, "check.json");
    expect(api.seen.map((s) => s.path)).toEqual(["/admin/config", "/admin/config"]);
  });

  test("a failed read shows the shared state", async () => {
    const api = detailApi();
    api.reply("/admin/config", { status: 503, headers: WIRE_HEADERS });
    const c = await consoleFor(api);
    const res = await getPage(c, "/checks/shadowed?id=dns-a");
    expect(res.status).toBe(200);
    expect(res.body).toContain("pulse-api answered 503.");
  });

  test("detail and shadowed metric labels hold no id", async () => {
    const c = await consoleFor(detailApi());
    await getPage(c, "/checks/check?id=web");
    await getPage(c, "/checks/shadowed?id=dns-a");
    const text = c.metrics.render();
    expect(text).toContain('path="/checks/check",code="200"');
    expect(text).toContain('path="/checks/shadowed",code="200"');
    expect(text).not.toContain("dns-a");
  });
});

describe("editor GET routes", () => {
  const probeText =
    "Every probe runs this check. It is down when at least two locations report down; with one reporting location, that location decides. Choosing locations or a quorum per check is not available yet.";
  const heartbeatText =
    "Heartbeat checks are not run by probes and have no quorum; your job pings pulse-api. With no ping for longer than the period plus the grace time, the check is down at once.";
  const editable = {
    ...checkConfig,
    checks: checkConfig.checks.map((check) => ({ ...check, source: "database" })),
    shadowed: [],
  };
  const cases: Array<[string, string, boolean]> = [
    ["/checks/new?type=http", "create http", false],
    ["/checks/new?type=tls", "create tls", false],
    ["/checks/new?type=tcp", "create tcp", false],
    ["/checks/new?type=dns", "create dns", false],
    ["/checks/new?type=domain", "create domain", false],
    ["/checks/new?type=heartbeat", "create heartbeat", true],
    ["/checks/edit?id=web", "edit http", false],
    ["/checks/edit?id=cert", "edit tls", false],
    ["/checks/edit?id=db-port", "edit tcp", false],
    ["/checks/edit?id=dns-a", "edit dns", false],
    ["/checks/edit?id=domain-exp", "edit domain", false],
    ["/checks/edit?id=nightly-backup", "edit heartbeat", true],
  ];
  for (const [path, label, isHeartbeat] of cases) {
    test(`${label} shows its quorum paragraph above Submit and no quorum input`, async () => {
      const c = await consoleFor(fakeApi(editable), { role: "member" });
      const res = await getPage(c, path);
      expect(res.status).toBe(200);
      const shown = isHeartbeat ? heartbeatText : probeText;
      const at = res.body.indexOf(escapeHtml(shown));
      expect(at).toBeGreaterThan(-1);
      expect(res.body.indexOf('type="submit"', at)).toBeGreaterThan(at);
      if (isHeartbeat) expect(res.body).not.toContain(escapeHtml(probeText));
      expect(res.body).not.toMatch(/name="[^"]*(quorum|location)[^"]*"/);
    });
  }

  test("the edit page of the hostile-host check shows the quoted host line, no stored values", async () => {
    const c = await consoleFor(fakeApi(), { role: "member" });
    const res = await getPage(c, "/checks/edit?id=web");
    expect(res.status).toBe(200);
    expect(res.body).toContain(escapeHtml(HOST_LINE));
    expect(res.body).toContain("Value: set");
    expect(res.body).not.toContain("&quot;keep&quot;");
    expect(res.body).not.toContain(TOKEN);
  });
});

describe("Edit and Delete visibility", () => {
  for (const id of [".", ".."]) {
    test(`id ${id}: the list and detail pages hide Edit and Delete`, async () => {
      const config = {
        ...checkConfig,
        checks: [...checkConfig.checks, { ...checkConfig.checks[0], id }],
      };
      const c = await consoleFor(fakeApi(config), { role: "owner" });
      const list = await getPage(c, "/checks");
      const row = rowOf(list.body, id);
      expect(row).toContain("View");
      expect(row).not.toContain(">Edit<");
      expect(row).not.toContain(">Delete<");
      const detail = await getPage(c, `/checks/check?id=${encodeURIComponent(id)}`);
      expect(detail.body).not.toContain("/checks/edit?");
      expect(detail.body).not.toContain("/checks/delete?");
    });
  }

  for (const state of ["invalid", "unreadable", "written-not-applied"]) {
    test(`a ${state} checks.json keeps Add, Edit and Delete for database checks`, async () => {
      const config = {
        ...checkConfig,
        file: { state, message: "bad", lastAppliedAt: LAST_RESULT_AT },
      };
      const c = await consoleFor(fakeApi(config), { role: "admin" });
      const list = await getPage(c, "/checks");
      expect(list.body).toContain('<a href="/checks/new">Add a check</a>');
      const row = rowOf(list.body, "web");
      expect(row).toContain(
        '<td class="actions-cell"><a href="/checks/check?id=web">View</a> <a href="/checks/edit?id=web">Edit</a> <a href="/checks/export?id=web">Export</a> <a href="/checks/delete?id=web">Delete</a></td>',
      );
      expect(row).toContain('<a href="/checks/edit?id=web">Edit</a>');
      expect(row).toContain('<a href="/checks/delete?id=web">Delete</a>');
    });
  }
});
