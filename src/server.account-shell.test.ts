import { afterEach, describe, expect, test } from "bun:test";
import {
  formTokenOf,
  getPage,
  OWNER_PASSWORD,
  postForm,
  type Reply,
  SESSION_CSRF,
  type SignedInConsole,
  startSignedInConsole,
} from "../test/signed-in-console.ts";

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function signedIn(options: { isViewer?: boolean } = {}): Promise<SignedInConsole> {
  const c = await startSignedInConsole({
    apiUrl: "http://127.0.0.1:9",
    roleOf: options.isViewer === true ? () => "viewer" : undefined,
  });
  cleanups.push(() => c.close());
  return c;
}

function countOf(body: string, text: string): number {
  return body.split(text).length - 1;
}

function expectAccountShell(res: Reply, title: string): void {
  expect(res.headers.get("content-security-policy")).toBe(CSP);
  expect(res.headers.get("referrer-policy")).toBe("same-origin");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(countOf(res.body.toLowerCase(), "<!doctype html>")).toBe(1);
  expect(countOf(res.body, "<h1>")).toBe(1);
  expect(res.body).toContain(`<h1>${title}</h1>`);
  expect(res.body).toContain(`<title>${title}`);
  expect(countOf(res.body, '<header class="sidebar">')).toBe(1);
  expect(countOf(res.body, '<nav aria-label="Main">')).toBe(1);
  expect(countOf(res.body, "<script")).toBe(1);
  expect(res.body).toContain('<script src="/console.js" defer></script>');
  expect(res.body).toContain('<a class="nav-item" href="/"><svg class="icon"');
  expect(res.body).not.toMatch(/class="nav-item"[^>]*aria-current/);
  expect(res.body).toContain(
    'Signed in as Owner <span class="account-email">(owner@example.com)</span>',
  );
  expect(res.body).toContain("Role: Owner");
  expect(res.body).not.toContain("style=");
  expect(res.body).not.toMatch(/\son[a-z]+=/);
}

const SUBMITS: Record<string, string> = {
  "Sign out all other sessions": '<button type="submit" class="danger">',
  "Create new recovery codes": '<button type="submit">',
};

/** Cancel is a ghost link before the submit; sign out all is danger, new codes stay primary. */
function expectCancel(body: string, button: string, href: string): void {
  expect(body).toContain(
    `<div class="panel-foot"><a class="button ghost cancel" href="${href}">Cancel</a> ${SUBMITS[button]}${button}</button></div>`,
  );
}

const ROUTES = [
  { path: "/account/security", title: "Account security", content: "of 10 recovery codes left" },
  { path: "/account/sessions", title: "Sessions", content: "This browser" },
  {
    path: "/account/sessions/sign-out-all",
    title: "Sign out all other sessions",
    content: "Sign out all other sessions? This browser stays signed in.",
  },
  {
    path: "/account/recovery-codes",
    title: "New recovery codes",
    content: "Your current recovery codes stop working.",
  },
] as const;

describe("account pages in the signed-in shell", () => {
  for (const route of ROUTES) {
    test(`GET ${route.path} is a shell page with its content`, async () => {
      const c = await signedIn();
      const res = await getPage(c, route.path);
      expect(res.status).toBe(200);
      expectAccountShell(res, route.title);
      expect(res.body).toContain(route.content);
    });

    test(`HEAD ${route.path} is 200 with an empty body`, async () => {
      const c = await signedIn();
      const before = await getPage(c, route.path);
      const res = await fetch(c.base + route.path, {
        method: "HEAD",
        headers: { cookie: c.cookie },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
      // The earlier GET token is still the one that signs out: HEAD replaced nothing.
      const signOut = await postForm(c, "/sign-out", {
        csrf: SESSION_CSRF,
        form_token: formTokenOf(before.body, "/sign-out"),
      });
      expect(signOut.status).toBe(303);
    });
  }

  test("the security page keeps its four links", async () => {
    const c = await signedIn();
    const { body } = await getPage(c, "/account/security");
    for (const href of [
      "/account/authenticator",
      "/account/recovery-codes",
      "/account/sessions",
      "/account/password",
    ]) {
      expect(body).toContain(`<a href="${href}">`);
    }
  });

  test("sessions links back to account security and has one sign-out form", async () => {
    const c = await signedIn();
    const { body } = await getPage(c, "/account/sessions");
    expect(body).toContain('<p><a href="/account/security">Back to account security</a></p>');
    expect(body).toContain(
      '<div class="table-scroll" tabindex="0" role="region" aria-label="Sessions table">\n<table id="sessions">',
    );
    expect(body).toContain("This browser");
    expect(countOf(body, 'action="/sign-out"')).toBe(1);
  });

  test("both confirmations are panels with Cancel before the submit", async () => {
    const c = await signedIn();
    const all = await getPage(c, "/account/sessions/sign-out-all");
    expectCancel(all.body, "Sign out all other sessions", "/account/sessions");
    expect(all.body).toContain(
      '<form method="post" action="/account/sessions/sign-out-all" class="panel confirm confirm-danger">',
    );
    const codes = await getPage(c, "/account/recovery-codes");
    expectCancel(codes.body, "Create new recovery codes", "/account/security");
    expect(codes.body).toContain(
      '<form method="post" action="/account/recovery-codes" class="panel confirm confirm-safe">',
    );
    expect(codes.body).toMatch(
      /<div class="panel-body">[\s\S]*name="password"[\s\S]*<\/div>\n<div class="panel-foot">/,
    );
    expect(codes.body).not.toContain("danger");
  });

  test("a viewer sees Overview and no Team", async () => {
    const c = await signedIn({ isViewer: true });
    const res = await getPage(c, "/account/security");
    expect(res.status).toBe(200);
    expect(res.body).toContain("<span>Overview</span></a>");
    expect(res.body).not.toContain(">Team<");
    expect(res.body).not.toContain("Instance");
    expect(res.body).toContain("Role: Viewer");
  });

  test("the header and page tokens only work at their own paths", async () => {
    const c = await signedIn();
    const { body } = await getPage(c, "/account/sessions/sign-out-all");
    const page = formTokenOf(body, "/account/sessions/sign-out-all");
    const header = formTokenOf(body, "/sign-out");
    expect(page).not.toBe(header);
    const wrongPage = await postForm(c, "/account/sessions/sign-out-all", {
      csrf: SESSION_CSRF,
      form_token: header,
    });
    expect(wrongPage.status).toBe(409);
    const wrongHeader = await postForm(c, "/sign-out", { csrf: SESSION_CSRF, form_token: page });
    expect(wrongHeader.status).toBe(409);
  });
});

describe("account notices are callouts", () => {
  test("the signed-out notice on Sessions is a success callout with role status", async () => {
    const c = await signedIn();
    const { body } = await getPage(c, "/account/sessions?signed-out=others");
    expect(body).toContain('<section class="callout callout-success" role="status">');
    expect(body).toContain("<p>All other sessions are signed out.</p>");
  });
});

describe("account re-renders keep the shell and Cancel", () => {
  async function codesPost(c: SignedInConsole, password: string, token?: string): Promise<Reply> {
    const page = await getPage(c, "/account/recovery-codes");
    return postForm(c, "/account/recovery-codes", {
      csrf: SESSION_CSRF,
      form_token: token ?? formTokenOf(page.body, "/account/recovery-codes"),
      password,
    });
  }

  test("a wrong password is 401 in the shell", async () => {
    const c = await signedIn();
    const res = await codesPost(c, "wrong-password-0123456789");
    expect(res.status).toBe(401);
    expectAccountShell(res, "New recovery codes");
    expectCancel(res.body, "Create new recovery codes", "/account/security");
  });

  test("the wrong password is an error callout with role alert, not a bare paragraph", async () => {
    const c = await signedIn();
    const res = await codesPost(c, "wrong-password-0123456789");
    expect(res.body).toContain('<section class="callout callout-error" role="alert">');
    expect(res.body).not.toContain('class="error"');
  });

  test("an empty password is 422 in the shell", async () => {
    const c = await signedIn();
    const res = await codesPost(c, "");
    expect(res.status).toBe(422);
    expectAccountShell(res, "New recovery codes");
    expectCancel(res.body, "Create new recovery codes", "/account/security");
  });

  test("an expired form token is 409 in the shell", async () => {
    const c = await signedIn();
    const res = await codesPost(c, OWNER_PASSWORD, "unknown-token");
    expect(res.status).toBe(409);
    expectAccountShell(res, "New recovery codes");
    expectCancel(res.body, "Create new recovery codes", "/account/security");
  });

  test("sign out all with an expired form token is 409 in the shell", async () => {
    const c = await signedIn();
    const res = await postForm(c, "/account/sessions/sign-out-all", {
      csrf: SESSION_CSRF,
      form_token: "unknown-token",
    });
    expect(res.status).toBe(409);
    expectAccountShell(res, "Sign out all other sessions");
    expectCancel(res.body, "Sign out all other sessions", "/account/sessions");
  });

  test("the new codes result shows 10 codes with Continue and no Cancel", async () => {
    const c = await signedIn();
    const res = await codesPost(c, OWNER_PASSWORD);
    expect(res.status).toBe(200);
    expect(countOf(res.body, "<li><code>")).toBe(10);
    expect(res.body).toContain('<a href="/account/security">Continue</a>');
    expect(res.body).not.toContain("Cancel");
  });
});

describe("account pages outside the full stage", () => {
  test("an owner without an authenticator is sent to /account/authenticator", async () => {
    const c = await startSignedInConsole({
      apiUrl: "http://127.0.0.1:9",
      prepare: (db) => db.run("DELETE FROM authenticators"),
    });
    cleanups.push(() => c.close());
    const res = await getPage(c, "/account/security");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account/authenticator");
    expect(res.body).not.toContain('class="sidebar"');
  });

  test("a factor-stage session is sent to /sign-in/factor", async () => {
    const c = await startSignedInConsole({
      apiUrl: "http://127.0.0.1:9",
      prepare: (db) => db.run("UPDATE sessions SET stage = 'factor'"),
    });
    cleanups.push(() => c.close());
    const res = await getPage(c, "/account/sessions");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sign-in/factor");
    expect(res.body).not.toContain('class="sidebar"');
  });
});
