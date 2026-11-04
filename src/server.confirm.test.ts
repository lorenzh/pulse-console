import { afterEach, describe, expect, test } from "bun:test";
import {
  type ConfirmTargetHolder,
  createFixtureRoutes,
  type Recorder,
} from "../test/fixture-routes.ts";
import {
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

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

type Fixture = {
  c: SignedInConsole;
  recorder: Recorder;
  target: ConfirmTargetHolder;
  setRole: (r: ConsoleRole) => void;
};

async function startFixtures(): Promise<Fixture> {
  const recorder: Recorder = { actions: [] };
  const target: ConfirmTargetHolder = { current: { name: "Checkout API", revision: "rev-1" } };
  let role: ConsoleRole = "admin";
  const c = await startSignedInConsole({
    apiUrl: "http://127.0.0.1:9",
    testRoutes: createFixtureRoutes({ recorder, target }),
    roleOf: () => role,
  });
  cleanups.push(() => c.close());
  return {
    c,
    recorder,
    target,
    setRole: (r) => {
      role = r;
    },
  };
}

const TYPED = [
  "delete-check",
  "delete-incident",
  "revoke-token",
  "revoke-probe",
  "remove-member",
  "transfer-ownership",
];
const PLAIN = [
  "resolve-incident",
  "delete-maintenance",
  "reset-2fa",
  "sign-out-all-sessions",
  "new-recovery-codes",
];
const FAMILIES: Array<[string, string]> = [
  ...TYPED.map((f): [string, string] => ["typed", f]),
  ...PLAIN.map((f): [string, string] => ["plain", f]),
];

const TYPED_PATH = "/__test/confirm/typed/delete-check";

async function openForm(c: SignedInConsole, path: string): Promise<string> {
  return formTokenOf((await getPage(c, path)).body, path);
}

function headPage(c: SignedInConsole, path: string): Promise<Response> {
  return fetch(c.base + path, {
    method: "HEAD",
    redirect: "manual",
    headers: { cookie: c.cookie },
  });
}

function expectRefused(res: Reply): void {
  expect(res.status).toBe(403);
  expect(res.body).toContain("Request refused");
}

describe("confirmation families", () => {
  for (const [kind, family] of FAMILIES) {
    const path = `/__test/confirm/${kind}/${family}`;
    test(`${path}: GET, HEAD and Cancel do nothing; one POST acts once`, async () => {
      const { c, recorder } = await startFixtures();
      const get = await getPage(c, path);
      expect(get.status).toBe(200);
      expect(get.body).toMatch(
        /<input type="hidden" name="csrf" value="[^"]+">\n<input type="hidden" name="form_token" value="[^"]{43}">\n<input type="hidden" name="revision" value="rev-1">/,
      );
      expect(get.body).toContain('<a class="cancel" href="/">Cancel</a>');
      expect(get.body).toContain("This cannot be undone.");
      if (kind === "typed") {
        expect(get.body).toContain('<label for="field-confirm_name">Type Checkout API to confirm');
      } else {
        expect(get.body).not.toContain("confirm_name");
      }
      expect((await headPage(c, path)).status).toBe(200);
      expect((await getPage(c, "/")).status).toBe(200);
      expect(recorder.actions).toHaveLength(0);

      const body: Record<string, string> = {
        csrf: SESSION_CSRF,
        form_token: formTokenOf(get.body, path),
        revision: "rev-1",
      };
      if (kind === "typed") body.confirm_name = "Checkout API";
      const post = await postForm(c, path, body);
      expect(post.status).toBe(303);
      expect(post.headers.get("location")).toBe("/__test/confirm/done");
      expect(recorder.actions).toEqual([{ family, target: "Checkout API" }]);
      const done = await getPage(c, "/__test/confirm/done");
      expect(done.body).toContain(`<p>Done: ${family} Checkout API</p>`);

      const replay = await postForm(c, path, body);
      expect(replay.status).toBe(409);
      expect(replay.body).toContain("<h2>Already submitted</h2>");
      expect(recorder.actions).toHaveLength(1);
    });
  }
});

describe("typed name", () => {
  const rows: Array<[string, Record<string, string>, number, string | undefined]> = [
    ["equivalent spelling", { confirm_name: "  Checkout API " }, 303, undefined],
    ["NFC form", { confirm_name: "Checkout API".normalize("NFD") }, 303, undefined],
    [
      "other case",
      { confirm_name: "checkout api" },
      422,
      "The name does not match. Type Checkout API exactly.",
    ],
    [
      "changed inner whitespace",
      { confirm_name: "Checkout  API" },
      422,
      "The name does not match. Type Checkout API exactly.",
    ],
    ["blank", { confirm_name: "   " }, 422, "Type the name to confirm."],
    [
      "forged expected",
      { confirm_name: "x", expected: "x" },
      422,
      "The name does not match. Type Checkout API exactly.",
    ],
  ];
  for (const [name, fields, status, error] of rows) {
    test(`${name} answers ${status}`, async () => {
      const { c, recorder } = await startFixtures();
      const token = await openForm(c, TYPED_PATH);
      const res = await postForm(c, TYPED_PATH, {
        csrf: SESSION_CSRF,
        form_token: token,
        revision: "rev-1",
        ...fields,
      });
      expect(res.status).toBe(status);
      if (error === undefined) {
        expect(recorder.actions).toHaveLength(1);
        return;
      }
      expect(recorder.actions).toHaveLength(0);
      expect(res.body).toContain(
        `<span class="error" id="field-confirm_name-error">${error}</span>`,
      );
      expect(res.body).toContain(`value="${fields.confirm_name}"`);
      const fresh = formTokenOf(res.body, TYPED_PATH);
      expect(fresh).toHaveLength(43);
      expect(fresh).not.toBe(token);
    });
  }
});

describe("target changes", () => {
  test("a renamed target with the old revision answers 409 with the input kept", async () => {
    const { c, recorder, target } = await startFixtures();
    const token = await openForm(c, TYPED_PATH);
    target.current = { name: "Checkout API v2", revision: "rev-2" };
    const res = await postForm(c, TYPED_PATH, {
      csrf: SESSION_CSRF,
      form_token: token,
      revision: "rev-1",
      confirm_name: "Checkout API",
    });
    expect(res.status).toBe(409);
    expect(res.body).toContain("<h2>Changed since you opened it</h2>");
    expect(res.body).toContain('value="Checkout API"');
    expect(res.body).toContain('name="revision" value="rev-2"');
    const fresh = formTokenOf(res.body, TYPED_PATH);
    expect(fresh).toHaveLength(43);
    expect(fresh).not.toBe(token);
    expect(recorder.actions).toHaveLength(0);
  });

  test("a removed target answers the shell 404 on GET and POST", async () => {
    const { c, recorder, target } = await startFixtures();
    const token = await openForm(c, TYPED_PATH);
    target.current = undefined;
    const get = await getPage(c, TYPED_PATH);
    expect(get.status).toBe(404);
    expect(get.body).toContain("<h2>Page not found</h2>");
    const post = await postForm(c, TYPED_PATH, {
      csrf: SESSION_CSRF,
      form_token: token,
      revision: "rev-1",
      confirm_name: "Checkout API",
    });
    expect(post.status).toBe(404);
    expect(post.body).toContain("<h2>Page not found</h2>");
    expect(recorder.actions).toHaveLength(0);
  });
});

describe("refused confirmation POSTs", () => {
  test("an admin downgraded to viewer gets 403 naming Admin and Viewer", async () => {
    const { c, recorder, setRole } = await startFixtures();
    const token = await openForm(c, TYPED_PATH);
    setRole("viewer");
    const res = await postForm(c, TYPED_PATH, {
      csrf: SESSION_CSRF,
      form_token: token,
      revision: "rev-1",
      confirm_name: "Checkout API",
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("This page needs the Admin role or higher. Your role is Viewer.");
    expect(recorder.actions).toHaveLength(0);
  });

  const rows: Array<[string, Record<string, string>, string | undefined]> = [
    ["missing csrf", {}, undefined],
    ["wrong csrf", { csrf: "wrong" }, undefined],
    ["cross origin", { csrf: SESSION_CSRF }, "http://evil.example"],
    ["Origin null", { csrf: SESSION_CSRF }, "null"],
  ];
  for (const [name, fields, origin] of rows) {
    test(`${name} answers 403 with 0 actions`, async () => {
      const { c, recorder } = await startFixtures();
      const token = await openForm(c, TYPED_PATH);
      const body = { form_token: token, revision: "rev-1", confirm_name: "Checkout API" };
      const res = await postForm(
        c,
        TYPED_PATH,
        { ...body, ...fields },
        origin === undefined ? {} : { origin },
      );
      expectRefused(res);
      expect(recorder.actions).toHaveLength(0);
    });
  }

  test("an expired-session POST goes to sign-in and is not replayed after sign-in", async () => {
    const { c, recorder } = await startFixtures();
    const token = await openForm(c, TYPED_PATH);
    c.setNow(START + 2_592_000_000);
    const post = await postForm(c, TYPED_PATH, {
      csrf: SESSION_CSRF,
      form_token: token,
      revision: "rev-1",
      confirm_name: "Checkout API",
    });
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe(
      "/sign-in?next=%2F__test%2Fconfirm%2Ftyped%2Fdelete-check",
    );
    const form = await fetch(`${c.base}/sign-in`, { redirect: "manual" });
    const csrfCookie = (form.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const html = await form.text();
    const signIn = await postForm(
      c,
      "/sign-in",
      {
        email: OWNER_EMAIL,
        password: OWNER_PASSWORD,
        next: TYPED_PATH,
        csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "",
        form_token: formTokenOf(html, "/sign-in"),
      },
      { cookie: csrfCookie },
    );
    expect(signIn.status).toBe(303);
    expect(signIn.headers.get("location")).toBe(TYPED_PATH);
    const session = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const back = await getPage(c, TYPED_PATH, session);
    expect(back.status).toBe(200);
    expect(back.body).toContain("Type Checkout API to confirm");
    expect(recorder.actions).toHaveLength(0);
  });
});
