import { afterEach, describe, expect, test } from "bun:test";
import { escapeHtml } from "@lorenzh/pulse-kit";
import { checkConfig, checkExport, checkStates, QUOTE_URL } from "../test/check-fixtures.ts";
import {
  type FakeApi,
  type FakeReply,
  jsonReply,
  startFakeApi,
  UPSTREAM_SENTINEL,
  WIRE_HEADERS,
} from "../test/fake-api.ts";
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
  const row = body.split("<tr>").find((part) => part.includes(`<td>${escapeHtml(id)}</td>`));
  return row ?? "";
}

function rowCount(body: string): number {
  const tbody = /<tbody>[\s\S]*<\/tbody>/.exec(body)?.[0] ?? "";
  return tbody.split("<tr>").length - 1;
}

function warnings(c: SignedInConsole): string[] {
  return c.logs.filter((line) => line.includes("api read failed"));
}

describe("GET /checks", () => {
  test("lists every type, state and source with the counts", async () => {
    const api = fakeApi();
    const c = await consoleFor(api);
    const res = await getPage(c, "/checks");
    expect(res.status).toBe(200);
    expect(res.body).toContain("6 checks, 1 shadowed definition");
    expect(rowCount(res.body)).toBe(7);
    for (const label of ["HTTP", "TLS", "TCP", "DNS", "Domain", "Heartbeat"]) {
      expect(res.body).toContain(`<td>${label}</td>`);
    }
    expect(rowOf(res.body, "web")).toContain("<td>Up</td>");
    expect(rowOf(res.body, "cert")).toContain("<td>Degraded</td>");
    expect(rowOf(res.body, "db-port")).toContain("<td>Down</td>");
    expect(rowOf(res.body, "db-port")).toContain("<td>checks.json (read-only)</td>");
    expect(rowOf(res.body, "db-port")).toContain("<td>db.internal:5432</td>");
    expect(rowOf(res.body, "domain-exp")).toContain("<td>Unknown</td>");
    expect(rowOf(res.body, "domain-exp")).toContain("<td>No results yet</td>");
    expect(rowOf(res.body, "nightly-backup")).toContain("<td>Unknown</td>");
    expect(rowOf(res.body, "nightly-backup")).toContain("<td>Console</td>");
    expect(rowOf(res.body, "web")).toContain("<td>2026-11-05 11:59:30 UTC</td>");
    expect(rowOf(res.body, "web")).toContain(`<td>${escapeHtml(QUOTE_URL)}</td>`);
    expect(res.body).toContain("<td>Maintenance</td>");
    expect(res.body).toContain("<td>Shadowed by checks.json</td>");
    expect(res.body).toContain("<td>example.com AAAA</td>");
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
      expect(res.body).toContain("Some filter values were not understood and were ignored.");
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
    expect(seen.body).toContain("A member can add checks.");
    expect(seen.body).not.toContain("/checks/new");
  });

  test.each([
    ["invalid", "checks.json is invalid"],
    ["unreadable", "checks.json cannot be read"],
    ["written-not-applied", "checks.json was written but not applied"],
  ])("file state %s shows its banner", async (state, heading) => {
    const file = { state, message: "line 3: <bad>", lastAppliedAt: Date.UTC(2026, 10, 4, 8) };
    const c = await consoleFor(fakeApi({ ...checkConfig, file }));
    const res = await getPage(c, "/checks");
    expect(res.status).toBe(200);
    expect(res.body).toContain(heading);
    expect(res.body).toContain("line 3: &lt;bad&gt;");
    expect(res.body).toContain("The last valid version from 2026-11-04 08:00:00 UTC stays in use.");
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
