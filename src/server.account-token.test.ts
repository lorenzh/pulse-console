import { afterEach, expect, test } from "bun:test";
import { formTokenOf } from "../test/signed-in-console.ts";
import {
  Client,
  closeAll,
  count,
  csrfIn,
  enrol,
  enrolledConsole,
  PASSWORD,
  startConsole,
  stepAt,
  totpCode,
} from "./two-factor-harness.ts";

afterEach(closeAll);

test("enrolment refuses a missing form token and a replay without replacing the pending key", async () => {
  const c = await startConsole();
  const client = new Client(c);
  await client.password();
  const path = "/account/authenticator";
  const page = await client.get(path);
  const fields = { csrf: csrfIn(page.body), action: "new" };
  const missing = await client.request("POST", path, fields);
  expect(missing.status).toBe(409);
  expect(count(c.dbPath, "SELECT count(*) AS n FROM pending_authenticators")).toBe(0);
  const form_token = formTokenOf(missing.body, path);
  expect(form_token).not.toBe("");
  expect((await client.request("POST", path, { ...fields, form_token })).status).toBe(303);
  expect((await client.request("POST", path, { ...fields, form_token })).status).toBe(409);
  expect(count(c.dbPath, "SELECT count(*) AS n FROM pending_authenticators")).toBe(1);
});

test("a valid TOTP with a missing token leaves the factor session live for the fresh form", async () => {
  const { c, seed } = await enrolledConsole();
  const client = new Client(c);
  await client.password("/account/security");
  const path = "/sign-in/factor";
  const page = await client.get(path);
  const fields = { csrf: csrfIn(page.body), code: totpCode(seed, stepAt(c.clock.now)) };
  const missing = await client.request("POST", path, fields);
  expect(missing.status).toBe(409);
  expect(count(c.dbPath, "SELECT count(*) AS n FROM sessions WHERE stage = 'factor'")).toBe(1);
  const done = await client.request("POST", path, {
    ...fields,
    form_token: formTokenOf(missing.body, path),
  });
  expect(done.status).toBe(303);
  expect(done.headers.get("location")).toBe("/account/security");
});

test("recovery verification keeps a refused form token and rolls back a missing-token commit", async () => {
  const c = await startConsole();
  const owner = new Client(c);
  await owner.password();
  const { codes } = await enrol(owner);
  const client = new Client(c);
  await client.password();
  const path = "/sign-in/factor";
  const page = await client.get(path);
  const fields = {
    csrf: csrfIn(page.body),
    form_token: formTokenOf(page.body, path),
  };
  expect(
    (
      await client.request("POST", path, {
        ...fields,
        recovery_code: "f".repeat(32),
      })
    ).status,
  ).toBe(401);
  const missing = await client.request("POST", path, {
    csrf: fields.csrf,
    recovery_code: codes[0] ?? "",
  });
  expect(missing.status).toBe(409);
  expect(
    count(c.dbPath, "SELECT count(*) AS n FROM recovery_codes WHERE used_at IS NOT NULL"),
  ).toBe(0);
  expect(count(c.dbPath, "SELECT count(*) AS n FROM sessions WHERE stage = 'factor'")).toBe(1);
  expect(
    (
      await client.request("POST", path, {
        ...fields,
        recovery_code: codes[0] ?? "",
      })
    ).status,
  ).toBe(303);
});

test("the account confirmations require single-use tokens and keep the current session", async () => {
  const c = await startConsole();
  const owner = new Client(c);
  await owner.password();
  await enrol(owner);
  const other = new Client(c);
  await other.password();
  const signOut = "/account/sessions/sign-out-all";
  const page = await owner.get(signOut);
  const fields = { csrf: csrfIn(page.body) };
  const missing = await owner.request("POST", signOut, fields);
  expect(missing.status).toBe(409);
  expect(missing.headers.getSetCookie()).toEqual([]);
  expect(count(c.dbPath, "SELECT count(*) AS n FROM sessions")).toBe(2);
  const complete = { ...fields, form_token: formTokenOf(missing.body, signOut) };
  expect((await owner.request("POST", signOut, complete)).status).toBe(303);
  expect((await owner.request("POST", signOut, complete)).status).toBe(409);
  expect(count(c.dbPath, "SELECT count(*) AS n FROM sessions")).toBe(1);
  expect((await owner.get("/")).status).toBe(200);

  const path = "/account/recovery-codes";
  const form = await owner.get(path);
  const password = { csrf: csrfIn(form.body), password: PASSWORD };
  const refused = await owner.request("POST", path, password);
  expect(refused.status).toBe(409);
  const regenerate = { ...password, form_token: formTokenOf(refused.body, path) };
  const codes = await owner.request("POST", path, regenerate);
  expect(codes.status).toBe(200);
  expect(codes.body.match(/<li><code>/g)).toHaveLength(10);
  const replay = await owner.request("POST", path, regenerate);
  expect(replay.status).toBe(409);
  expect(replay.body).not.toContain("<li><code>");
});
