import { afterEach, describe, expect, test } from "bun:test";
import { checkConfig, checkStates, REVISION } from "../test/check-fixtures.ts";
import {
  type FakeApi,
  type FakeReply,
  jsonReply,
  startFakeApi,
  WIRE_HEADERS,
} from "../test/fake-api.ts";
import { formTokenOf, getPage, postForm, type Reply } from "../test/signed-in-console.ts";
import { startTeamConsole, type TeamConsole } from "../test/team-console.ts";
import type { ConsoleRole } from "./roles.ts";

const TOKEN = "checks-change-admin-token-sentinel-0123456789";
const HEADER_SECRET = "literal-header-value-sentinel";
const BODY_SECRET = "request-body-sentinel";
const HEARTBEAT_SECRET = "heartbeatSecretSentinel01";
const REV_OLD = `sha256-${"0".repeat(64)}`;
const REV_NEW = `sha256-${"c".repeat(64)}`;
const SAVED: FakeReply = {
  status: 200,
  body: "{}",
  headers: { ...WIRE_HEADERS, etag: `"${REV_NEW}"` },
};

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function fakeApi(config: unknown = checkConfig): FakeApi {
  const api = startFakeApi();
  cleanups.push(() => api.stop());
  api.reply("/admin/config", jsonReply(config));
  api.reply("/checks", jsonReply(checkStates));
  api.replyTo("PUT", "/admin/checks/web", SAVED);
  api.replyTo("DELETE", "/admin/checks/web", SAVED);
  api.replyTo("DELETE", "/admin/checks/dns-a", SAVED);
  return api;
}

async function teamConsole(api: FakeApi): Promise<TeamConsole> {
  const c = await startTeamConsole({ apiUrl: api.url, adminToken: TOKEN });
  cleanups.push(() => c.close());
  return c;
}

function calls(api: FakeApi): string[] {
  return api.seen.map((s) => `${s.method} ${s.rawPath}`);
}

function writes(api: FakeApi): string[] {
  return calls(api).filter((call) => !call.startsWith("GET "));
}

/** Opens the page, takes its form token, forgets the GET's api requests and posts `fields`. */
async function submit(
  c: TeamConsole,
  api: FakeApi,
  path: string,
  fields: Record<string, string>,
  role: ConsoleRole = "admin",
): Promise<Reply> {
  const page = await getPage(c, path, c.cookies[role]);
  expect(page.status).toBe(200);
  const token = formTokenOf(page.body, escapeAttr(path));
  expect(token).not.toBe("");
  api.seen.length = 0;
  return postForm(
    c,
    path,
    { csrf: c.csrfs[role], form_token: token, ...fields },
    {
      cookie: c.cookies[role],
    },
  );
}

function escapeAttr(path: string): string {
  return path.replaceAll("&", "&amp;");
}

/** The fields of a valid edit of the fixture `web`: stored X-Api-Key row 0, env row 1. */
const WEB_EDIT: Record<string, string> = {
  revision: REVISION,
  name: "Web shop",
  url: "https://a';id;'b/",
  method: "POST",
  interval_ms: "60000",
  header_0_intent: "keep",
  header_1_name: "Authorization",
  header_1_kind: "env",
  header_1_value: "PULSE_HEADER_TOKEN",
  body_intent: "keep",
};

function sentBody(api: FakeApi, method: string): Record<string, unknown> {
  const seen = api.seen.find((s) => s.method === method);
  expect(seen).toBeDefined();
  return JSON.parse(seen?.body ?? "{}") as Record<string, unknown>;
}

type PeopleRow = { action: string; target_kind: string; target_id: null; target_name: string };

function peopleRows(c: TeamConsole): Array<PeopleRow & { value: string }> {
  return c.db
    .query<PeopleRow & { value: string }, []>(
      "SELECT action, target_kind, target_id, target_name, value FROM people_events WHERE action LIKE 'check.%' ORDER BY id",
    )
    .all();
}

function withChecks(changes: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return { ...checkConfig, checks: [...checkConfig.checks, ...changes], ...extra };
}

describe("POST /checks/edit", () => {
  test("saves from the trusted entry: forged type and header name are ignored", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await submit(
      c,
      api,
      "/checks/edit?id=web",
      { ...WEB_EDIT, type: "tcp", id: "other", header_0_name: "X-Evil", header_0_kind: "plain" },
      "member",
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/checks/check?id=web&saved=1");
    expect(calls(api)).toEqual(["GET /admin/config", "PUT /admin/checks/web"]);
    const put = api.seen[1];
    expect(put?.headers["if-match"]).toBe(`"${REVISION}"`);
    expect(put?.authorization).toBe(`Bearer ${TOKEN}`);
    const body = sentBody(api, "PUT");
    expect(body.type).toBeUndefined();
    expect(body.id).toBe("web");
    expect(body.headers).toEqual({
      "X-Api-Key": { keep: true },
      Authorization: { env: "PULSE_HEADER_TOKEN" },
    });
    expect(body.body).toEqual({ keep: true });
    expect(JSON.stringify(body)).not.toContain("X-Evil");
    expect(peopleRows(c)).toEqual([
      {
        action: "check.replace",
        target_kind: "check",
        target_id: null,
        target_name: "web",
        value: REV_NEW,
      },
    ]);
    const detail = await getPage(c, "/checks/check?id=web&saved=1", c.cookies.member);
    expect(detail.body).toContain("Check saved.");
  });

  test("stored row removed plus a free env row sends only that header", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await submit(c, api, "/checks/edit?id=web", {
      ...WEB_EDIT,
      header_0_intent: "remove",
      header_1_name: "X-Api-Key",
      header_1_value: "PULSE_HEADER_KEY",
    });
    expect(res.status).toBe(303);
    expect(writes(api)).toEqual(["PUT /admin/checks/web"]);
    expect(sentBody(api, "PUT").headers).toEqual({ "X-Api-Key": { env: "PULSE_HEADER_KEY" } });
  });

  for (const name of ["X-Api-Key", "x-api-key"]) {
    test(`a kept stored X-Api-Key and a free ${name} answer 422 with no write`, async () => {
      const api = fakeApi();
      const c = await teamConsole(api);
      const res = await submit(c, api, "/checks/edit?id=web", {
        ...WEB_EDIT,
        header_1_name: name,
      });
      expect(res.status).toBe(422);
      expect(res.body).toContain('id="field-header_1_name-error"');
      expect(res.body).toContain(
        "This header is already set in another row (names are compared without case).",
      );
      expect(res.body).toContain(`<input type="hidden" name="revision" value="${REVISION}">`);
      expect(calls(api)).toEqual(["GET /admin/config"]);
    });
  }

  test("a free __proto__ row answers 422 locally on edit and create", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const edit = await submit(c, api, "/checks/edit?id=web", {
      ...WEB_EDIT,
      header_2_name: "__proto__",
      header_2_kind: "env",
      header_2_value: "PULSE_X",
    });
    expect(edit.status).toBe(422);
    expect(edit.body).toContain("__proto__ is not an allowed header name.");
    expect(edit.body).toContain('id="field-header_2_name-error"');
    expect(calls(api)).toEqual(["GET /admin/config"]);
    const create = await submit(
      c,
      api,
      "/checks/new?type=http",
      {
        type: "http",
        revision: "",
        id: "new-web",
        name: "New",
        url: "https://example.com/",
        method: "GET",
        interval_ms: "60000",
        header_0_name: "__proto__",
        header_0_kind: "env",
        header_0_value: "PULSE_X",
      },
      "member",
    );
    expect(create.status).toBe(422);
    expect(create.body).toContain('id="field-header_0_name-error"');
    expect(calls(api)).toEqual([]);
  });

  test("a stale revision answers 409 with text, no form and no write, before field checks", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const res = await submit(c, api, "/checks/edit?id=web", {
      ...WEB_EDIT,
      revision: REV_OLD,
      interval_ms: "x",
    });
    expect(res.status).toBe(409);
    expect(res.body).toContain("Changed since you opened it");
    expect(res.body).toContain('<a href="/checks/edit?id=web">Reload</a>');
    expect(res.body).toContain("<dt>name</dt><dd>Web shop</dd>");
    expect(res.body).not.toContain('class="check-editor"');
    expect(calls(api)).toEqual(["GET /admin/config"]);
  });

  test("a failed config read answers 502 with the heading, kept input and no write", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const page = await getPage(c, "/checks/edit?id=web", c.cookies.member);
    const token = formTokenOf(page.body, "/checks/edit?id=web");
    api.replyTo("GET", "/admin/config", { status: 503, headers: WIRE_HEADERS });
    api.seen.length = 0;
    const res = await postForm(
      c,
      "/checks/edit?id=web",
      { csrf: c.csrfs.member, form_token: token, ...WEB_EDIT, header_0_value: HEADER_SECRET },
      { cookie: c.cookies.member },
    );
    expect(res.status).toBe(502);
    expect(res.body).toContain("Not saved: the current version could not be read.");
    expect(res.body).toContain("<dt>name</dt><dd>Web shop</dd>");
    expect(res.body).toContain('<a href="/checks/edit?id=web">Open it again</a>');
    expect(res.body).not.toContain(HEADER_SECRET);
    expect(res.body).not.toContain('class="check-editor"');
    expect(calls(api)).toEqual(["GET /admin/config"]);
  });

  test("an upstream 412 stays 412 with text and no form", async () => {
    const api = fakeApi();
    api.replyTo("PUT", "/admin/checks/web", { status: 412, body: "{}", headers: WIRE_HEADERS });
    const c = await teamConsole(api);
    const res = await submit(c, api, "/checks/edit?id=web", WEB_EDIT);
    expect(res.status).toBe(412);
    expect(res.body).toContain("Changed since you opened it");
    expect(res.body).not.toContain('class="check-editor"');
    expect(writes(api)).toEqual(["PUT /admin/checks/web"]);
  });

  test("heartbeat secret: keep sends none, replace sends the new one", async () => {
    const api = fakeApi();
    api.replyTo("PUT", "/admin/checks/nightly-backup", SAVED);
    const c = await teamConsole(api);
    const base = {
      revision: REVISION,
      name: "Nightly backup",
      period_ms: "86400000",
      grace_ms: "3600000",
    };
    const path = "/checks/edit?id=nightly-backup";
    expect((await submit(c, api, path, { ...base, secret_intent: "keep" })).status).toBe(303);
    expect(sentBody(api, "PUT").secret).toBeUndefined();
    const replaced = await submit(c, api, path, {
      ...base,
      secret_intent: "replace",
      secret: HEARTBEAT_SECRET,
    });
    expect(replaced.status).toBe(303);
    expect(sentBody(api, "PUT").secret).toBe(HEARTBEAT_SECRET);
  });
});

describe("edit and delete targets", () => {
  const shadowedConfig = {
    ...checkConfig,
    shadowed: [{ ...checkConfig.checks[0], source: "database" }],
    checks: [{ ...checkConfig.checks[0], source: "file" }, ...checkConfig.checks.slice(1)],
  };

  test("a shadowed id answers 409 on GET and POST before the file rule", async () => {
    const api = fakeApi(shadowedConfig);
    const c = await teamConsole(api);
    const get = await getPage(c, "/checks/edit?id=web", c.cookies.admin);
    const post = await postForm(
      c,
      "/checks/edit?id=web",
      { csrf: c.csrfs.admin, form_token: "x", ...WEB_EDIT },
      { cookie: c.cookies.admin },
    );
    expect(post.status).toBe(409);
    api.seen.length = 0;
    const getAgain = await getPage(c, "/checks/edit?id=web", c.cookies.admin);
    for (const res of [get, getAgain]) {
      expect(res.status).toBe(409);
      expect(res.body).toContain("Shadowed by checks.json: only Delete and Export are possible.");
      expect(res.body).toContain('<a href="/checks/delete?id=web">Delete</a>');
      expect(res.body).toContain('<a href="/checks/export?id=web&amp;shadowed=1">Export</a>');
      expect(res.body).not.toContain("Edit the file to change it.");
    }
    expect(calls(api)).toEqual(["GET /admin/config"]);
  });

  test("a valid POST for a shadowed id records only the config read", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const page = await getPage(c, "/checks/edit?id=web", c.cookies.admin);
    const token = formTokenOf(page.body, "/checks/edit?id=web");
    api.reply("/admin/config", jsonReply(shadowedConfig));
    api.seen.length = 0;
    const res = await postForm(
      c,
      "/checks/edit?id=web",
      { csrf: c.csrfs.admin, form_token: token, ...WEB_EDIT },
      { cookie: c.cookies.admin },
    );
    expect(res.status).toBe(409);
    expect(res.body).toContain("Shadowed by checks.json: only Delete and Export are possible.");
    expect(calls(api)).toEqual(["GET /admin/config"]);
  });

  test("a file check answers 409 and an unknown id 404", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const file = await getPage(c, "/checks/edit?id=db-port", c.cookies.admin);
    expect(file.status).toBe(409);
    expect(file.body).toContain("This check comes from checks.json. Edit the file to change it.");
    const fileDelete = await getPage(c, "/checks/delete?id=db-port", c.cookies.admin);
    expect(fileDelete.status).toBe(409);
    expect(fileDelete.body).toContain("This check comes from checks.json.");
    expect((await getPage(c, "/checks/edit?id=nope", c.cookies.admin)).status).toBe(404);
    expect((await getPage(c, "/checks/delete?id=nope", c.cookies.admin)).status).toBe(404);
    expect((await getPage(c, "/checks/edit", c.cookies.admin)).status).toBe(404);
    expect((await getPage(c, "/checks/delete?id=a&id=b", c.cookies.admin)).status).toBe(404);
  });

  for (const id of [".", ".."]) {
    test(`id ${id}: GET and POST of edit and delete answer 409 with only the config read`, async () => {
      const dotCheck = { ...checkConfig.checks[0], id };
      const api = fakeApi(withChecks([dotCheck]));
      const c = await teamConsole(api);
      const text = `pulse-api cannot address the id "${id}" in a URL path, so the Console cannot change or delete it.`;
      for (const path of ["/checks/edit", "/checks/delete"]) {
        const url = `${path}?id=${encodeURIComponent(id)}`;
        api.seen.length = 0;
        const get = await getPage(c, url, c.cookies.admin);
        expect(get.status).toBe(409);
        expect(get.body).toContain(text.replaceAll('"', "&quot;"));
        expect(calls(api)).toEqual(["GET /admin/config"]);
        const page = await getPage(c, "/checks/edit?id=web", c.cookies.admin);
        const token = formTokenOf(page.body, "/checks/edit?id=web");
        api.seen.length = 0;
        const post = await postForm(
          c,
          url,
          {
            csrf: c.csrfs.admin,
            form_token: path === "/checks/edit" ? token : "x",
            ...WEB_EDIT,
          },
          { cookie: c.cookies.admin },
        );
        expect(post.status).toBe(409);
        expect(writes(api)).toEqual([]);
      }
    });
  }
});

describe("expired and replayed tokens on edit and delete", () => {
  const slashConfig = withChecks([{ ...checkConfig.checks[1], id: "a/b", name: "Slash" }]);

  for (const path of ["/checks/edit", "/checks/delete"]) {
    test(`${path}: an expired token answers 409 with the id link and no api request`, async () => {
      const api = fakeApi(slashConfig);
      const c = await teamConsole(api);
      const res = await postForm(
        c,
        `${path}?id=a%2Fb`,
        { csrf: c.csrfs.admin, form_token: "expired", name: "Typed", confirm_name: "Typed" },
        { cookie: c.cookies.admin },
      );
      expect(res.status).toBe(409);
      expect(res.body).toContain(
        "This form has expired. Nothing was sent. Open it again to see the current version.",
      );
      expect(res.body).toContain(`<a href="${path}?id=a%2Fb">Open it again</a>`);
      expect(res.body).not.toContain('value="Typed"');
      expect(res.body).not.toContain('name="revision"');
      expect(api.seen).toEqual([]);
    });
  }

  test("a replayed delete token answers 409 Already submitted with the id link", async () => {
    const api = fakeApi(slashConfig);
    api.replyTo("DELETE", "/admin/checks/a%2Fb", SAVED);
    const c = await teamConsole(api);
    const page = await getPage(c, "/checks/delete?id=a%2Fb", c.cookies.admin);
    const fields = {
      csrf: c.csrfs.admin,
      form_token: formTokenOf(page.body, "/checks/delete?id=a%2Fb"),
      revision: REVISION,
      target: "database",
      confirm_name: "Slash",
    };
    const first = await postForm(c, "/checks/delete?id=a%2Fb", fields, {
      cookie: c.cookies.admin,
    });
    expect(first.status).toBe(303);
    const again = await postForm(c, "/checks/delete?id=a%2Fb", fields, {
      cookie: c.cookies.admin,
    });
    expect(again.status).toBe(409);
    expect(again.body).toContain("Already submitted");
    expect(again.body).toContain('<a href="/checks/delete?id=a%2Fb">Open the page again</a>');
    expect(writes(api)).toEqual(["DELETE /admin/checks/a%2Fb"]);
  });
});

describe("POST /checks/delete", () => {
  const spaced = {
    ...checkConfig,
    checks: [{ ...checkConfig.checks[0], name: " Checkout API " }, ...checkConfig.checks.slice(1)],
  };
  const deleteFields = { revision: REVISION, target: "database" };

  for (const typed of ["Checkout API", " Checkout API "]) {
    test(`typed ${JSON.stringify(typed)} deletes a check named " Checkout API "`, async () => {
      const api = fakeApi(spaced);
      const c = await teamConsole(api);
      const page = await getPage(c, "/checks/delete?id=web", c.cookies.admin);
      expect(page.body).toContain("Type Checkout API to confirm");
      expect(page.body).toContain(
        "The check stops running. Its results stay in pulse-api and its open incidents are resolved.",
      );
      const res = await submit(c, api, "/checks/delete?id=web", {
        ...deleteFields,
        confirm_name: typed,
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/checks?deleted=1");
      expect(calls(api)).toEqual(["GET /admin/config", "DELETE /admin/checks/web"]);
      expect(api.seen[1]?.headers["if-match"]).toBe(`"${REVISION}"`);
      expect(peopleRows(c)).toEqual([
        {
          action: "check.delete",
          target_kind: "check",
          target_id: null,
          target_name: "web",
          value: REV_NEW,
        },
      ]);
      const list = await getPage(c, "/checks?deleted=1", c.cookies.admin);
      expect(list.body).toContain("Check deleted.");
    });
  }

  for (const typed of ["Checkout  API", "checkout api"]) {
    test(`typed ${JSON.stringify(typed)} answers 422 with no DELETE`, async () => {
      const api = fakeApi(spaced);
      const c = await teamConsole(api);
      const res = await submit(c, api, "/checks/delete?id=web", {
        ...deleteFields,
        confirm_name: typed,
      });
      expect(res.status).toBe(422);
      expect(res.body).toContain("The name does not match. Type Checkout API exactly.");
      expect(res.body).toContain(`<input type="hidden" name="revision" value="${REVISION}">`);
      expect(calls(api)).toEqual(["GET /admin/config"]);
    });
  }

  test("the name to type comes from the POST-time read", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const page = await getPage(c, "/checks/delete?id=web", c.cookies.admin);
    const token = formTokenOf(page.body, "/checks/delete?id=web");
    const renamed = withChecks([]);
    renamed.checks = [
      { ...checkConfig.checks[0], name: "Shop API" },
      ...checkConfig.checks.slice(1),
    ];
    api.reply("/admin/config", jsonReply(renamed));
    api.seen.length = 0;
    const res = await postForm(
      c,
      "/checks/delete?id=web",
      { csrf: c.csrfs.admin, form_token: token, ...deleteFields, confirm_name: "Web shop" },
      { cookie: c.cookies.admin },
    );
    expect(res.status).toBe(422);
    expect(res.body).toContain("The name does not match. Type Shop API exactly.");
    expect(calls(api)).toEqual(["GET /admin/config"]);
  });

  test("a changed revision or a forged target answers 409 with no DELETE and no form", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    for (const fields of [
      { revision: REV_OLD, target: "database" },
      { revision: REVISION, target: "shadowed" },
    ]) {
      const res = await submit(c, api, "/checks/delete?id=web", {
        ...fields,
        confirm_name: "Web shop",
      });
      expect(res.status).toBe(409);
      expect(res.body).toContain('<a href="/checks/delete?id=web">Reload</a>');
      expect(res.body).not.toContain('name="confirm_name"');
      expect(calls(api)).toEqual(["GET /admin/config"]);
    }
  });

  test("a shadowed definition is deleted with one DELETE", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const page = await getPage(c, "/checks/delete?id=dns-a", c.cookies.admin);
    expect(page.body).toContain(
      "Only the database definition is removed. The check from checks.json keeps running.",
    );
    expect(page.body).toContain('<input type="hidden" name="target" value="shadowed">');
    const res = await submit(c, api, "/checks/delete?id=dns-a", {
      revision: REVISION,
      target: "shadowed",
      confirm_name: "DNS record (old)",
    });
    expect(res.status).toBe(303);
    expect(writes(api)).toEqual(["DELETE /admin/checks/dns-a"]);
  });

  test("a failed config read answers 502 with the heading and no DELETE", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const page = await getPage(c, "/checks/delete?id=web", c.cookies.admin);
    const token = formTokenOf(page.body, "/checks/delete?id=web");
    api.replyTo("GET", "/admin/config", { status: 503, headers: WIRE_HEADERS });
    api.seen.length = 0;
    const res = await postForm(
      c,
      "/checks/delete?id=web",
      { csrf: c.csrfs.admin, form_token: token, ...deleteFields, confirm_name: "Web shop" },
      { cookie: c.cookies.admin },
    );
    expect(res.status).toBe(502);
    expect(res.body).toContain("Not deleted: the current version could not be read.");
    expect(res.body).not.toContain('name="confirm_name"');
    expect(calls(api)).toEqual(["GET /admin/config"]);
  });
});

describe("roles of edit and delete", () => {
  const cases: Array<[string, ConsoleRole, number]> = [
    ["/checks/edit?id=web", "viewer", 403],
    ["/checks/edit?id=web", "member", 200],
    ["/checks/edit?id=web", "admin", 200],
    ["/checks/edit?id=web", "owner", 200],
    ["/checks/delete?id=web", "viewer", 403],
    ["/checks/delete?id=web", "member", 403],
    ["/checks/delete?id=web", "admin", 200],
    ["/checks/delete?id=web", "owner", 200],
  ];
  for (const [path, role, status] of cases) {
    test(`${role} GET, HEAD and POST of ${path}`, async () => {
      const api = fakeApi();
      const c = await teamConsole(api);
      expect((await getPage(c, path, c.cookies[role])).status).toBe(status);
      const head = await fetch(c.base + path, {
        method: "HEAD",
        headers: { cookie: c.cookies[role] },
      });
      expect(head.status).toBe(status);
      if (status === 403) {
        api.seen.length = 0;
        const post = await postForm(
          c,
          path,
          { csrf: c.csrfs[role], form_token: "x", ...WEB_EDIT, confirm_name: "Web shop" },
          { cookie: c.cookies[role] },
        );
        expect(post.status).toBe(403);
        expect(api.seen).toEqual([]);
      }
    });
  }

  test("an owner deletes and a member edits", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const edit = await submit(c, api, "/checks/edit?id=web", WEB_EDIT, "member");
    expect(edit.status).toBe(303);
    const del = await submit(
      c,
      api,
      "/checks/delete?id=web",
      { revision: REVISION, target: "database", confirm_name: "Web shop" },
      "owner",
    );
    expect(del.status).toBe(303);
  });

  test("stored role lowered while the delete read waits: 403, no DELETE", async () => {
    const api = fakeApi();
    const c = await teamConsole(api);
    const page = await getPage(c, "/checks/delete?id=web", c.cookies.admin);
    const token = formTokenOf(page.body, "/checks/delete?id=web");
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    api.replyTo("GET", "/admin/config", { ...jsonReply(checkConfig), gate });
    const pending = postForm(
      c,
      "/checks/delete?id=web",
      {
        csrf: c.csrfs.admin,
        form_token: token,
        revision: REVISION,
        target: "database",
        confirm_name: "Web shop",
      },
      { cookie: c.cookies.admin },
    );
    await api.received("/admin/config");
    c.db.run("UPDATE users SET role = 'member' WHERE id = ?", [c.ids.admin]);
    open();
    expect((await pending).status).toBe(403);
    expect(writes(api)).toEqual([]);
  });
});

describe("leaks on edit and delete", () => {
  test("sentinels appear only in the intended hidden controls", async () => {
    const api = fakeApi();
    api.replyTo("PUT", "/admin/checks/web", { status: 500, body: "{}", headers: WIRE_HEADERS });
    const c = await teamConsole(api);
    const pages: Array<{ reply: Reply; tokens: string[] }> = [];
    const issued: string[] = [];
    const secretFields = {
      ...WEB_EDIT,
      header_0_intent: "replace",
      header_0_value: HEADER_SECRET,
      body_intent: "replace",
      body: BODY_SECRET,
    };
    const run = async (path: string, fields: Record<string, string>): Promise<void> => {
      const page = await getPage(c, path, c.cookies.admin);
      const token = formTokenOf(page.body, path);
      issued.push(token);
      pages.push({ reply: page, tokens: [token] });
      const reply = await postForm(
        c,
        path,
        { csrf: c.csrfs.admin, form_token: token, ...fields },
        { cookie: c.cookies.admin },
      );
      const next = /name="form_token" value="([^"]*)"/g;
      const tokens = [...reply.body.matchAll(next)].map((m) => m[1] ?? "");
      issued.push(...tokens);
      pages.push({ reply, tokens });
    };
    await run("/checks/edit?id=web", secretFields);
    await run("/checks/edit?id=web", { ...secretFields, interval_ms: "x" });
    await run("/checks/edit?id=web", { ...secretFields, revision: REV_OLD });
    await run("/checks/delete?id=web", {
      revision: REVISION,
      target: "database",
      confirm_name: "x",
    });
    const expired = await postForm(
      c,
      "/checks/edit?id=web",
      { csrf: c.csrfs.admin, form_token: "expired", ...secretFields },
      { cookie: c.cookies.admin },
    );
    pages.push({
      reply: expired,
      tokens: [...expired.body.matchAll(/name="form_token" value="([^"]*)"/g)].map(
        (m) => m[1] ?? "",
      ),
    });
    const csrf = c.csrfs.admin;
    const fixed = [HEADER_SECRET, BODY_SECRET, HEARTBEAT_SECRET, TOKEN];
    for (const { reply, tokens } of pages) {
      for (const sentinel of fixed) expect(reply.body.split(sentinel).length - 1).toBe(0);
      let rest = reply.body;
      expect(rest).toContain(`<input type="hidden" name="csrf" value="${csrf}">`);
      rest = rest.replaceAll(`<input type="hidden" name="csrf" value="${csrf}">`, "");
      for (const token of tokens) {
        const control = `<input type="hidden" name="form_token" value="${token}">`;
        expect(rest).toContain(control);
        rest = rest.replaceAll(control, "");
      }
      const headers = [...reply.headers.entries()]
        .filter(([name]) => name !== "set-cookie")
        .map(([name, value]) => `${name}: ${value}`)
        .join("\n");
      for (const sentinel of [...fixed, csrf, ...issued]) {
        expect(rest.split(sentinel).length - 1).toBe(0);
        expect(headers.split(sentinel).length - 1).toBe(0);
      }
    }
    const logs = c.logs.join("\n");
    const metrics = await fetch(`${c.base}/metrics`).then((res) => res.text());
    for (const sentinel of [...fixed, csrf, ...issued]) {
      expect(logs.split(sentinel).length - 1).toBe(0);
      expect(metrics.split(sentinel).length - 1).toBe(0);
    }
  });
});
