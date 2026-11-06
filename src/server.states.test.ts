import { afterEach, describe, expect, test } from "bun:test";
import { createFixtureRoutes, type Recorder } from "../test/fixture-routes.ts";
import {
  completeSignIn,
  formTokenOf,
  getPage,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  postForm,
  type Reply,
  SESSION_CSRF,
  type SignedInConsole,
  START,
  startSignedInConsole,
} from "../test/signed-in-console.ts";
import type { ConsoleRole } from "./roles.ts";

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const SECRET = "s3cret-sentinel";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

type Fixture = { c: SignedInConsole; recorder: Recorder; setRole: (r: ConsoleRole) => void };

async function startFixtures(): Promise<Fixture> {
  const recorder: Recorder = { actions: [] };
  let role: ConsoleRole = "owner";
  const c = await startSignedInConsole({
    apiUrl: "http://127.0.0.1:9",
    testRoutes: createFixtureRoutes({ recorder }),
    roleOf: () => role,
  });
  cleanups.push(() => c.close());
  return {
    c,
    recorder,
    setRole: (r) => {
      role = r;
    },
  };
}

function expectShellHeaders(res: Reply): void {
  expect(res.headers.get("content-security-policy")).toBe(CSP);
  expect(res.headers.get("referrer-policy")).toBe("same-origin");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.body.match(/<script/g)).toEqual(["<script"]);
  expect(res.body).toContain('<script src="/console.js" defer></script>');
  expect(res.body).not.toContain("style=");
  expect(res.body).not.toMatch(/\son[a-z]+=/);
}

describe("state fixtures", () => {
  const rows: Array<[string, number, string]> = [
    ["/__test/states/empty", 200, "Nothing here yet"],
    ["/__test/states/busy", 200, "Busy button"],
    ["/__test/states/already-submitted", 409, "Already submitted"],
    ["/__test/states/api-timeout", 200, "pulse-api did not answer within 5 seconds."],
    [
      "/__test/states/api-refused",
      200,
      "The connection to http://127.0.0.1:9 was refused. Check that pulse-api is running at this address.",
    ],
    ["/__test/states/api-network", 200, "pulse-api cannot be reached at http://127.0.0.1:9."],
    ["/__test/states/api-status", 200, "pulse-api answered 503."],
    ["/__test/states/token-rejected", 200, "pulse-api rejected the console token"],
    ["/__test/states/forbidden", 200, "Only admins see this."],
    ["/__test/states/session-expired", 200, "You are signed in."],
    ["/__test/states/not-found", 404, "Page not found"],
    ["/__test/states/conflict-409", 200, "Edit"],
    ["/__test/states/invalid-422", 200, "Edit"],
    ["/__test/states/read-only-503", 200, "Edit"],
  ];
  for (const [path, status, text] of rows) {
    test(`GET ${path} answers ${status}`, async () => {
      const { c } = await startFixtures();
      const res = await getPage(c, path);
      expect(res.status).toBe(status);
      expect(res.body).toContain(text);
      expectShellHeaders(res);
    });
  }

  const posts: Array<[string, number, string]> = [
    ["/__test/states/conflict-409", 409, "Changed since you opened it"],
    ["/__test/states/conflict-412", 412, "Changed since you opened it"],
    ["/__test/states/read-only-503", 503, "The checks file is read-only"],
  ];
  for (const [path, status, heading] of posts) {
    test(`POST ${path} answers ${status} with the kept input`, async () => {
      const { c } = await startFixtures();
      const token = formTokenOf((await getPage(c, path)).body, path);
      const res = await postForm(c, path, {
        csrf: SESSION_CSRF,
        form_token: token,
        name: "Kept <name>",
        note: "Kept note",
        secret: SECRET,
      });
      expect(res.status).toBe(status);
      expect(res.body).toContain(`<h2 class="callout-title">${heading}</h2>`);
      expect(res.body).toContain('value="Kept &lt;name&gt;"');
      expect(res.body).toContain(">\nKept note</textarea>");
      expect(res.body).not.toContain(SECRET);
      const fresh = formTokenOf(res.body, path);
      expect(fresh).toHaveLength(43);
      expect(fresh).not.toBe(token);
      expectShellHeaders(res);
    });
  }

  test("POST invalid-422 links the summary to labelled fields", async () => {
    const { c } = await startFixtures();
    const path = "/__test/states/invalid-422";
    const token = formTokenOf((await getPage(c, path)).body, path);
    const res = await postForm(c, path, { csrf: SESSION_CSRF, form_token: token, name: "" });
    expect(res.status).toBe(422);
    expect(res.body).toContain('<li><a href="#field-name">Enter a name.</a></li>');
    expect(res.body).toContain('<li><a href="#field-note">Enter a note.</a></li>');
    expect(res.body).toContain('<label for="field-name">Name');
    expect(res.body).toContain('aria-describedby="field-name-error" aria-invalid="true"');
    expect(res.body).toContain('<span class="error" id="field-name-error">Enter a name.</span>');
    expect(res.body).toContain('aria-describedby="field-note-error" aria-invalid="true"');
    expect(res.body).toContain('<span class="error" id="field-note-error">Enter a note.</span>');
  });

  test("viewer gets the shell 403 naming Admin and Viewer", async () => {
    const { c, setRole } = await startFixtures();
    setRole("viewer");
    const res = await getPage(c, "/__test/states/forbidden");
    expect(res.status).toBe(403);
    expect(res.body.split("Access denied</h").length - 1).toBe(1);
    expect(res.body).toContain('<div class="page-head"><h1>Access denied</h1></div>');
    expect(res.body).toContain('<section class="callout callout-warning">');
    expect(res.body).toContain('<a href="/">Go to the overview</a>');
    expect(res.body).toContain("This page needs the Admin role or higher. Your role is Viewer.");
    expect(res.body).toContain("Role: Viewer");
    expectShellHeaders(res);
    setRole("member");
    expect((await getPage(c, "/__test/states/forbidden")).status).toBe(403);
    setRole("admin");
    expect((await getPage(c, "/__test/states/forbidden")).status).toBe(200);
  });

  test("an expired session goes to sign-in with next and comes back after sign-in", async () => {
    const { c, recorder } = await startFixtures();
    c.setNow(START + 2_592_000_000);
    const path = "/__test/states/session-expired";
    const res = await getPage(c, path);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sign-in?next=%2F__test%2Fstates%2Fsession-expired");
    const post = await postForm(c, "/__test/states/busy", { action: "go" });
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/sign-in?next=%2F__test%2Fstates%2Fbusy");
    expect(recorder.actions).toHaveLength(0);

    const form = await fetch(`${c.base}/sign-in?next=%2F__test%2Fstates%2Fsession-expired`, {
      redirect: "manual",
    });
    const csrfCookie = (form.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const html = await form.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const signIn = await postForm(
      c,
      "/sign-in",
      {
        email: OWNER_EMAIL,
        password: OWNER_PASSWORD,
        next: "/__test/states/session-expired",
        csrf,
        form_token: formTokenOf(html, "/sign-in"),
      },
      { cookie: csrfCookie },
    );
    expect(signIn.status).toBe(303);
    expect(signIn.headers.get("location")).toBe("/sign-in/factor");
    const full = await completeSignIn(c, signIn);
    expect(full.status).toBe(303);
    expect(full.headers.get("location")).toBe(path);
    const session = (full.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const back = await getPage(c, path, session);
    expect(back.status).toBe(200);
    expect(back.body).toContain("You are signed in.");
  });

  test("an unsafe target becomes next=/", async () => {
    const { c } = await startFixtures();
    const res = await getPage(c, `/__test/states/empty?x=${"a".repeat(3000)}`, "");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sign-in?next=%2F");
  });
});
