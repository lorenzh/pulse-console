/* eslint-disable sonarjs/no-clear-text-protocols -- loopback fake api and URL inputs under test */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Location, TokenMetadata } from "@lorenzh/pulse-contract";
import {
  type FakeApi,
  type FakeReply,
  jsonReply,
  startFakeApi,
  WIRE_HEADERS,
} from "../test/fake-api.ts";
import { formTokenOf, getPage, postForm, type Reply, START } from "../test/signed-in-console.ts";
import { startTeamConsole, type TeamConsole } from "../test/team-console.ts";
import { adminToken, FAKE_SECRET, probeToken, selfToken } from "../test/token-fixtures.ts";
import type { ProbePrefill } from "./settings.ts";

const TOKEN = "probes-admin-token-sentinel-0123456789";
const EU_ID = "tok_b0be00000000000000000003";
const NEW_ID = "tok_ae0000000000000000abc123";
const ROTATED_SECRET = "pulse_rotatedProbeSecret9876543210fedcba";
const OPS_ID = "tok_ad0000000000000000000002";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

type Api = FakeApi & { setTokens: (tokens: TokenMetadata[]) => void };

const self = selfToken();
const ops = adminToken();
const eu = probeToken("eu");

function probeApi(
  tokens: TokenMetadata[],
  locations: Location[] = [],
  selfRow: TokenMetadata = self,
): Api {
  const api = startFakeApi();
  cleanups.push(() => api.stop());
  api.reply("/admin/tokens/self", jsonReply(selfRow));
  api.reply("/locations", jsonReply(locations));
  const setTokens = (rows: TokenMetadata[]): void => {
    api.replyTo("GET", "/admin/tokens", jsonReply({ tokens: rows }));
    for (const row of rows) api.replyTo("GET", `/admin/tokens/${row.id}`, jsonReply(row));
  };
  setTokens(tokens);
  return { ...api, setTokens };
}

async function probesConsole(api: FakeApi, probePrefill?: ProbePrefill): Promise<TeamConsole> {
  const c = await startTeamConsole({ apiUrl: api.url, adminToken: TOKEN, probePrefill });
  cleanups.push(() => c.close());
  return c;
}

function writes(api: FakeApi): string[] {
  return api.seen.filter((s) => s.method !== "GET").map((s) => `${s.method} ${s.path}`);
}

function secretReply(token: TokenMetadata, secret: string, previousValidUntil: number | null) {
  return {
    status: token.id === NEW_ID ? 201 : 200,
    body: JSON.stringify({ token, secret, previousValidUntil }),
    headers: WIRE_HEADERS,
  } satisfies FakeReply;
}

const VALID = {
  location: "eu-west",
  name: "",
  api_url: "http://pulse-api:3000/",
  image: "ghcr.io/lorenzh/pulse-probe:main",
  network: "pulse_default",
};

async function postNew(c: TeamConsole, fields: Record<string, string>): Promise<Reply> {
  const page = await getPage(c, "/probes/new", c.cookies.admin);
  return postForm(
    c,
    "/probes/new",
    { csrf: c.csrfs.admin, form_token: formTokenOf(page.body, "/probes/new"), ...fields },
    { cookie: c.cookies.admin },
  );
}

async function openChange(c: TeamConsole, change: "rotate" | "revoke", id: string) {
  const page = await getPage(c, `/probes/${change}?id=${id}`, c.cookies.admin);
  return {
    page,
    formToken: formTokenOf(page.body, `/probes/${change}?id=${id}`),
    revision: /name="revision" value="([^"]*)"/.exec(page.body)?.[1] ?? "",
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
    `/probes/${change}?id=${id}`,
    { csrf: c.csrfs.admin, ...fields },
    { cookie: c.cookies.admin },
  );
}

/** The text of the group section whose heading is `name`. */
function groupOf(html: string, name: string): string {
  const start = html.indexOf(`<h2>${name}</h2>`) + 1 || html.indexOf(`<h3>${name}</h3>`) + 1;
  if (start === 0) return "";
  const end = html.indexOf("</section>", start);
  return html.slice(start - 1, end);
}

describe("GET /probes", () => {
  test("every row of the location state table, the warning and the Revoked table", async () => {
    const tokens = [
      self,
      ops,
      probeToken("a-rep", { id: "tok_a10000000000000000000001" }),
      probeToken("b-rep0", { id: "tok_b20000000000000000000002", revokedAt: START - 1 }),
      probeToken("c-sil", { id: "tok_c30000000000000000000003" }),
      probeToken("e-await", { id: "tok_e50000000000000000000005", lastUsedAt: START - 5 }),
      probeToken("f-none", { id: "tok_f60000000000000000000006", revokedAt: START - 1 }),
      probeToken("EU", { id: "tok_e70000000000000000000007" }),
    ];
    const locations: Location[] = [
      { name: "a-rep", lastResultAt: Date.UTC(2026, 0, 1, 9, 0, 0), state: "reporting" },
      { name: "b-rep0", lastResultAt: Date.UTC(2026, 0, 1, 9, 1, 0), state: "reporting" },
      { name: "c-sil", lastResultAt: Date.UTC(2026, 0, 1, 8, 0, 0), state: "silent" },
      { name: "d-sil0", lastResultAt: Date.UTC(2026, 0, 1, 7, 0, 0), state: "silent" },
    ];
    const api = probeApi(tokens, locations);
    const c = await probesConsole(api);
    const res = await getPage(c, "/probes", c.cookies.owner);
    expect(res.status).toBe(200);
    const body = res.body;
    expect(groupOf(body, "a-rep")).toContain("Reporting, last result 2026-01-01 09:00:00 UTC");
    expect(groupOf(body, "b-rep0")).toContain("Reporting, last result 2026-01-01 09:01:00 UTC");
    expect(groupOf(body, "b-rep0")).toContain("No active token: new results will be refused.");
    expect(groupOf(body, "a-rep")).not.toContain("No active token");
    expect(groupOf(body, "c-sil")).toContain("Silent since 2026-01-01 08:00:00 UTC");
    expect(groupOf(body, "d-sil0")).toContain("Silent, no active token");
    expect(groupOf(body, "e-await")).toContain("Awaiting first result");
    expect(groupOf(body, "f-none")).toContain("No active token");
    expect(body).toContain("<h3>f-none</h3>");
    expect(body.indexOf("<h2>Revoked</h2>")).toBeLessThan(body.indexOf("<h3>f-none</h3>"));
    expect(body.indexOf("<h2>EU</h2>")).toBeLessThan(body.indexOf("<h2>a-rep</h2>"));
    expect(body.indexOf("<h2>a-rep</h2>")).toBeLessThan(body.indexOf("<h2>e-await</h2>"));
    const cSil = groupOf(body, "c-sil");
    for (const text of [
      "probe c-sil",
      "tok_c30000000000000000000003",
      "<td>Never</td>",
      '<td class="actions-cell"><a href="/probes/rotate?id=tok_c30000000000000000000003">Rotate this token</a> <a href="/probes/revoke?id=tok_c30000000000000000000003">Revoke this token</a></td>',
      'href="/probes/rotate?id=tok_c30000000000000000000003">Rotate this token',
      'href="/probes/revoke?id=tok_c30000000000000000000003">Revoke this token',
    ]) {
      expect(cSil).toContain(text);
    }
    expect(groupOf(body, "b-rep0")).not.toContain("Rotate this token");
    expect(body).not.toContain(`>${self.name}<`);
    expect(body).not.toContain(OPS_ID);
    expect(body).toContain('href="/probes/new"');
    expect(api.seen.find((s) => s.path === "/locations")?.authorization).toBeNull();
  });

  test("a failed locations read keeps the credentials and says why", async () => {
    const api = probeApi([self, eu]);
    api.reply("/locations", { status: 503, headers: WIRE_HEADERS, body: "{}" });
    const c = await probesConsole(api);
    const res = await getPage(c, "/probes", c.cookies.admin);
    expect(res.status).toBe(200);
    expect(groupOf(res.body, "eu")).toContain("Last result unknown (pulse-api answered 503)");
    expect(res.body).toContain(EU_ID);
  });

  test("a revoke notice names the token and keeps the results", async () => {
    const api = probeApi([self, { ...eu, revokedAt: START }]);
    const c = await probesConsole(api);
    const res = await getPage(c, `/probes?revoked=${EU_ID}`, c.cookies.admin);
    expect(res.body).toContain(`Revoked probe eu (${EU_ID}). Its results stay in pulse-api.`);
  });
});

describe("roles", () => {
  for (const role of ["member", "viewer"] as const) {
    test(`${role} gets 403 on every GET and forged POST, with 0 api calls`, async () => {
      const api = probeApi([self, eu]);
      const c = await probesConsole(api);
      for (const path of [
        "/probes",
        "/probes/new",
        `/probes/rotate?id=${EU_ID}`,
        `/probes/revoke?id=${EU_ID}`,
      ]) {
        expect((await getPage(c, path, c.cookies[role])).status).toBe(403);
      }
      for (const path of [
        "/probes/new",
        `/probes/rotate?id=${EU_ID}`,
        `/probes/revoke?id=${EU_ID}`,
      ]) {
        const res = await postForm(
          c,
          path,
          { csrf: c.csrfs[role], form_token: "x", ...VALID, revision: "r", confirm_name: "eu" },
          { cookie: c.cookies[role] },
        );
        expect(res.status).toBe(403);
      }
      expect(api.seen).toEqual([]);
    });
  }

  test("navigation shows Probes to Admin and Owner, not to Member", async () => {
    const c = await probesConsole(probeApi([self]));
    for (const role of ["owner", "admin"] as const) {
      const res = await getPage(c, "/probes", c.cookies[role]);
      expect(res.body).toContain('href="/probes" aria-current="page"');
    }
    const member = await getPage(c, "/checks", c.cookies.member);
    expect(member.body).not.toContain('href="/probes"');
  });
});

describe("add location", () => {
  test("the form has exactly the five fields, editable prefills and no private-range control", async () => {
    const api = probeApi([self]);
    const c = await probesConsole(api, {
      apiUrl: "http://pulse-api:3000",
      image: "ghcr.io/lorenzh/pulse-probe:1",
      network: "pulse_default",
    });
    const res = await getPage(c, "/probes/new", c.cookies.admin);
    expect(res.status).toBe(200);
    const form = res.body.slice(res.body.indexOf('action="/probes/new"'));
    const names = [...form.matchAll(/<input[^>]* name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual([
      "csrf",
      "form_token",
      "location",
      "name",
      "api_url",
      "image",
      "network",
    ]);
    expect(res.body).toContain(
      'name="api_url" type="url" autocomplete="off" required value="http://pulse-api:3000"',
    );
    expect(res.body).toContain('value="ghcr.io/lorenzh/pulse-probe:1"');
    expect(res.body).toContain('value="pulse_default"');
    expect(res.body).not.toContain("readonly");
    expect(res.body).not.toContain("disabled");
    expect(res.body.toLowerCase()).not.toContain("private");
    expect(res.body).toContain(
      `The address the probe uses to reach pulse-api. The console reaches it at ${api.url}; a probe on another host needs an address it can reach.`,
    );
    expect(res.body).toContain(
      "For a probe on the same Docker host as pulse-api: the Compose network of the stack (for example pulse_default). Leave empty for a remote probe.",
    );
  });

  test("a forged private-range POST still renders false and the four snippets, once", async () => {
    const created = probeToken("eu-west", { id: NEW_ID, name: "probe eu-west" });
    const api = probeApi([
      self,
      probeToken("eu-west"),
      probeToken("eu-west", { id: "tok_e2e200000000000000000009" }),
    ]);
    api.replyTo("POST", "/admin/tokens", secretReply(created, FAKE_SECRET, null));
    const c = await probesConsole(api);
    const res = await postNew(c, {
      ...VALID,
      block_private: "on",
      PULSE_PROBE_BLOCK_PRIVATE_RANGES: "true",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const post = api.seen.find((s) => s.method === "POST");
    expect(JSON.parse(post?.body ?? "")).toEqual({
      name: "probe eu-west",
      scopes: ["probe"],
      location: "eu-west",
    });
    const base = "pulse-probe-eu-west-abc123";
    expect(res.body).toContain(
      `<pre id="probe-env-command" data-secret>(umask 077 &amp;&amp; printf &#39;%s\\n&#39; &#39;PULSE_PROBE_TOKEN=${FAKE_SECRET}&#39; &gt; &#39;${base}.env&#39;)</pre>`,
    );
    for (const id of [
      "probe-env-command",
      "probe-docker-run",
      "probe-compose-file",
      "probe-compose-command",
    ]) {
      expect(res.body).toContain(`<pre id="${id}"`);
      expect(res.body).toContain(`<button type="button" data-copy="${id}" hidden>Copy</button>`);
    }
    expect(res.body).toContain("-e &#39;PULSE_PROBE_BLOCK_PRIVATE_RANGES=false&#39;");
    expect(res.body).toContain("PULSE_PROBE_BLOCK_PRIVATE_RANGES: &quot;false&quot;");
    expect(res.body).not.toContain("=true");
    expect(res.body).toContain(
      `docker compose -p &#39;${base}&#39; -f &#39;${base}.compose.yaml&#39; up -d</pre>`,
    );
    expect(res.body).toContain(
      "is the probe&#39;s default: its checks may connect to private, loopback, link-local and cloud metadata addresses, so checks of internal services work. To block those addresses on this probe, change the value to true in the docker run line or the Compose file before you start it.",
    );
    expect(res.body).toContain("eu-west now has 3 active tokens.");
    expect(res.body.split(FAKE_SECRET)).toHaveLength(2);
    const rows = c.db
      .query(
        "SELECT action, target_kind, target_name, value FROM people_events WHERE action LIKE 'token.%'",
      )
      .all();
    expect(rows).toEqual([
      {
        action: "token.create",
        target_kind: "token",
        target_name: NEW_ID,
        value: "location=eu-west",
      },
    ]);
  });

  test("a replayed add answers Already submitted with 1 api write", async () => {
    const api = probeApi([self]);
    api.replyTo(
      "POST",
      "/admin/tokens",
      secretReply(probeToken("eu-west", { id: NEW_ID }), FAKE_SECRET, null),
    );
    const c = await probesConsole(api);
    const page = await getPage(c, "/probes/new", c.cookies.admin);
    const fields = {
      csrf: c.csrfs.admin,
      form_token: formTokenOf(page.body, "/probes/new"),
      ...VALID,
    };
    expect((await postForm(c, "/probes/new", fields, { cookie: c.cookies.admin })).status).toBe(
      200,
    );
    const again = await postForm(c, "/probes/new", fields, { cookie: c.cookies.admin });
    expect(again.status).toBe(409);
    expect(again.body).toContain("Already submitted");
    expect(again.body).not.toContain(FAKE_SECRET);
    expect(writes(api)).toEqual(["POST /admin/tokens"]);
  });

  const invalid: Array<[string, Record<string, string>, string]> = [
    ["heartbeat", { location: "heartbeat" }, "field-location-error"],
    ["65 characters", { location: "x".repeat(65) }, "field-location-error"],
    ["control character", { location: "eu\u0007" }, "field-location-error"],
    ["name control character", { name: "a\u0001b" }, "field-name-error"],
    ["url with query", { api_url: "http://api:3000/?a=1" }, "field-api_url-error"],
    ["url ftp", { api_url: "ftp://api" }, "field-api_url-error"],
    ["image", { image: "-bad" }, "field-image-error"],
    ["network", { network: "bad net" }, "field-network-error"],
  ];
  for (const [label, override, errorId] of invalid) {
    test(`${label} answers 422 with the input kept and 0 writes`, async () => {
      const api = probeApi([self]);
      const c = await probesConsole(api);
      const res = await postNew(c, { ...VALID, ...override });
      expect(res.status).toBe(422);
      expect(res.body).toContain(`id="${errorId}"`);
      const kept =
        "location" in override ? 'value="ghcr.io/lorenzh/pulse-probe:main"' : 'value="eu-west"';
      expect(res.body).toContain(kept);
      expect(writes(api)).toEqual([]);
    });
  }

  test("a console token without checks replaces the form and refuses a forged POST", async () => {
    const weak = selfToken({ scopes: ["read", "admin"] });
    const api = probeApi([self]);
    const c = await probesConsole(api);
    const open = await getPage(c, "/probes/new", c.cookies.admin);
    api.reply("/admin/tokens/self", jsonReply(weak));
    const form = await getPage(c, "/probes/new", c.cookies.admin);
    expect(form.body).toContain(
      "The console token lacks the checks scope, so it cannot create probe tokens.",
    );
    expect(form.body).not.toContain('<form method="post" action="/probes/new"');
    const res = await postForm(
      c,
      "/probes/new",
      { csrf: c.csrfs.admin, form_token: formTokenOf(open.body, "/probes/new"), ...VALID },
      { cookie: c.cookies.admin },
    );
    expect(res.status).toBe(403);
    expect(res.body).toContain("The console token lacks checks.");
    expect(writes(api)).toEqual([]);
  });

  test("api 422 shows the form again with the message", async () => {
    const api = probeApi([self]);
    api.replyTo("POST", "/admin/tokens", {
      status: 422,
      headers: WIRE_HEADERS,
      body: JSON.stringify({ error: "location is invalid" }),
    });
    const c = await probesConsole(api);
    const res = await postNew(c, VALID);
    expect(res.status).toBe(422);
    expect(res.body).toContain('action="/probes/new"');
  });
});

describe("rotate and revoke", () => {
  test("rotate shows the env command for the same file, the countdown and the restart lines", async () => {
    const api = probeApi([self, eu]);
    api.replyTo(
      "POST",
      `/admin/tokens/${EU_ID}/rotate`,
      secretReply(eu, ROTATED_SECRET, START + 90_000),
    );
    const c = await probesConsole(api);
    const open = await openChange(c, "rotate", EU_ID);
    expect(open.page.status).toBe(200);
    const res = await postChange(c, "rotate", EU_ID, {
      form_token: open.formToken,
      revision: open.revision,
    });
    expect(res.status).toBe(200);
    const base = "pulse-probe-eu-000003";
    expect(res.body).toContain(
      `&#39;PULSE_PROBE_TOKEN=${ROTATED_SECRET}&#39; &gt; &#39;${base}.env&#39;)</pre>`,
    );
    expect(res.body).toContain('<pre id="probe-env-command" data-secret>');
    expect(res.body).toContain("01:30</time> left");
    expect(res.body).toContain(
      `docker compose -p &#39;${base}&#39; -f &#39;${base}.compose.yaml&#39; up -d --force-recreate`,
    );
    expect(res.body).toContain(`docker rm -f &#39;${base}&#39;`);
    expect(res.body).toContain("run your docker run line again");
    expect(res.body).toContain("so a plain docker restart keeps the old token");
    expect(writes(api)).toEqual([`POST /admin/tokens/${EU_ID}/rotate`]);
  });

  test("revoke with the typed location redirects and keeps history", async () => {
    const api = probeApi([self, eu]);
    api.replyTo(
      "POST",
      `/admin/tokens/${EU_ID}/revoke`,
      jsonReply({ token: { ...eu, revokedAt: START } }),
    );
    const c = await probesConsole(api);
    const open = await openChange(c, "revoke", EU_ID);
    expect(open.page.body).toContain("Revoking keeps the results of this location in pulse-api.");
    const wrong = await postChange(c, "revoke", EU_ID, {
      form_token: open.formToken,
      revision: open.revision,
      confirm_name: "EU",
    });
    expect(wrong.status).toBe(422);
    expect(writes(api)).toEqual([]);
    const again = await openChange(c, "revoke", EU_ID);
    const res = await postChange(c, "revoke", EU_ID, {
      form_token: again.formToken,
      revision: again.revision,
      confirm_name: "eu",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/probes?revoked=${EU_ID}`);
    const rows = c.db
      .query("SELECT action, value FROM people_events WHERE action LIKE 'token.%'")
      .all();
    expect(rows).toEqual([{ action: "token.revoke", value: "location=eu" }]);
  });

  for (const change of ["rotate", "revoke"] as const) {
    const typed = change === "revoke" ? { confirm_name: "eu" } : {};

    test(`${change}: revoked between GET and POST is stale, 0 writes`, async () => {
      const api = probeApi([self, eu]);
      const c = await probesConsole(api);
      const open = await openChange(c, change, EU_ID);
      api.setTokens([self, { ...eu, revokedAt: START }]);
      const res = await postChange(c, change, EU_ID, {
        form_token: open.formToken,
        revision: open.revision,
        ...typed,
      });
      expect(res.status).toBe(409);
      expect(res.body).toContain("Changed since you opened it");
      expect(res.body).not.toContain("This token is already revoked or expired.");
      expect(writes(api)).toEqual([]);
    });

    test(`${change}: expired after GET with the shown revision is inactive, 0 writes`, async () => {
      const api = probeApi([self, { ...eu, expiresAt: START + 1000 }]);
      const c = await probesConsole(api);
      const open = await openChange(c, change, EU_ID);
      c.setNow(START + 2000);
      const res = await postChange(c, change, EU_ID, {
        form_token: open.formToken,
        revision: open.revision,
        ...typed,
      });
      expect(res.status).toBe(409);
      expect(res.body).toContain("This token is already revoked or expired.");
      expect(writes(api)).toEqual([]);
    });

    test(`${change}: a forged POST with the revoked row's revision is inactive, 0 writes`, async () => {
      const api = probeApi([self, eu]);
      const c = await probesConsole(api);
      const open = await openChange(c, change, EU_ID);
      const revoked = { ...eu, revokedAt: START };
      api.setTokens([self, revoked]);
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
      const res = await postChange(c, change, EU_ID, {
        form_token: open.formToken,
        revision: hasher.digest("hex"),
        ...typed,
      });
      expect(res.status).toBe(409);
      expect(res.body).toContain("This token is already revoked or expired.");
      expect(writes(api)).toEqual([]);
    });

    test(`${change}: GET of an inactive token is 409 without a form`, async () => {
      const api = probeApi([self, { ...eu, revokedAt: START - 1 }]);
      const c = await probesConsole(api);
      const res = await getPage(c, `/probes/${change}?id=${EU_ID}`, c.cookies.admin);
      expect(res.status).toBe(409);
      expect(res.body).toContain("This token is already revoked or expired.");
      expect(res.body).not.toContain('<form method="post" action="/probes');
    });

    test(`${change}: an admin-side token or an unknown id is not found`, async () => {
      const api = probeApi([self, ops]);
      const c = await probesConsole(api);
      expect((await getPage(c, `/probes/${change}?id=${OPS_ID}`, c.cookies.admin)).status).toBe(
        404,
      );
      expect((await getPage(c, `/probes/${change}?id=tok_unknown`, c.cookies.admin)).status).toBe(
        404,
      );
    });

    test(`${change}: the own token has no form and a forged POST is 409 with 0 writes`, async () => {
      const own = probeToken("eu", { id: self.id });
      const api = probeApi([own], [], own);
      const c = await probesConsole(api);
      const get = await getPage(c, `/probes/${change}?id=${self.id}`, c.cookies.admin);
      expect(get.status).toBe(409);
      expect(get.body).not.toContain('<form method="post" action="/probes');
      const ok = await openChange(c, change, "x");
      const res = await postChange(c, change, self.id, {
        form_token: ok.formToken,
        revision: "r",
        ...typed,
      });
      expect(res.status).toBe(409);
      expect(writes(api)).toEqual([]);
    });

    test(`${change}: the role lowered between GET and POST answers 403, 0 writes`, async () => {
      const api = probeApi([self, eu]);
      const c = await probesConsole(api);
      const open = await openChange(c, change, EU_ID);
      c.db.run("UPDATE users SET role = 'viewer' WHERE id = ?", [c.ids.admin]);
      const res = await postChange(c, change, EU_ID, {
        form_token: open.formToken,
        revision: open.revision,
        ...typed,
      });
      expect(res.status).toBe(403);
      expect(writes(api)).toEqual([]);
    });

    test(`${change}: the console token without checks answers 403, 0 writes`, async () => {
      const weak = selfToken({ scopes: ["read", "admin"] });
      const api = probeApi([weak, eu], [], weak);
      const c = await probesConsole(api);
      const open = await openChange(c, change, EU_ID);
      const res = await postChange(c, change, EU_ID, {
        form_token: open.formToken,
        revision: open.revision,
        ...typed,
      });
      expect(res.status).toBe(403);
      expect(res.body).toContain("The console token lacks checks.");
      expect(writes(api)).toEqual([]);
    });
  }
});

describe("self failures", () => {
  test("self 404 shows the banner, removes every action, and every mutation answers 503", async () => {
    const api = probeApi([self, eu]);
    const c = await probesConsole(api);
    const open = await openChange(c, "rotate", EU_ID);
    const add = await getPage(c, "/probes/new", c.cookies.admin);
    api.reply("/admin/tokens/self", { status: 404, headers: WIRE_HEADERS, body: "{}" });
    const list = await getPage(c, "/probes", c.cookies.admin);
    expect(list.body).toContain(
      "The console cannot tell which token it uses (pulse-api answered 404). Changes are off until it can. pulse-api needs GET /admin/tokens/self.",
    );
    expect(list.body).toContain(EU_ID);
    expect(list.body).not.toContain('href="/probes/new"');
    expect(list.body).not.toContain("Rotate this token");
    expect((await getPage(c, "/probes/new", c.cookies.admin)).status).toBe(503);
    const rotate = await postChange(c, "rotate", EU_ID, {
      form_token: open.formToken,
      revision: open.revision,
    });
    expect(rotate.status).toBe(503);
    const created = await postForm(
      c,
      "/probes/new",
      { csrf: c.csrfs.admin, form_token: formTokenOf(add.body, "/probes/new"), ...VALID },
      { cookie: c.cookies.admin },
    );
    expect(created.status).toBe(503);
    expect(writes(api)).toEqual([]);
  });

  test("self 401 shows the token-rejected banner", async () => {
    const api = probeApi([self, eu]);
    api.reply("/admin/tokens/self", { status: 401, headers: WIRE_HEADERS, body: "{}" });
    const c = await probesConsole(api);
    const list = await getPage(c, "/probes", c.cookies.admin);
    expect(list.body).not.toContain('href="/probes/new"');
    expect((await getPage(c, "/probes/new", c.cookies.admin)).status).toBe(502);
  });
});

describe("secrets", () => {
  test("no secret in the database, events, logs, metrics or later pages", async () => {
    const api = probeApi([self, eu]);
    api.replyTo(
      "POST",
      "/admin/tokens",
      secretReply(probeToken("eu-west", { id: NEW_ID }), FAKE_SECRET, null),
    );
    api.replyTo("POST", `/admin/tokens/${EU_ID}/rotate`, secretReply(eu, ROTATED_SECRET, null));
    const c = await probesConsole(api);
    expect((await postNew(c, VALID)).body).toContain(FAKE_SECRET);
    const open = await openChange(c, "rotate", EU_ID);
    const rotated = await postChange(c, "rotate", EU_ID, {
      form_token: open.formToken,
      revision: open.revision,
    });
    expect(rotated.body).toContain(ROTATED_SECRET);
    expect(rotated.body).toContain("The old secret no longer works.");
    c.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const bytes = readFileSync(c.db.filename).toString("latin1");
    const metrics = await (await fetch(`${c.base}/metrics`)).text();
    const later = await getPage(c, "/probes", c.cookies.admin);
    const events = JSON.stringify(c.db.query("SELECT * FROM people_events").all());
    for (const secret of [FAKE_SECRET, ROTATED_SECRET, TOKEN]) {
      for (const text of [bytes, metrics, later.body, events, c.logs.join("\n")]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
