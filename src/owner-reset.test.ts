import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formTokenOf,
  getPage,
  OWNER_EMAIL,
  postForm,
  type Reply,
} from "../test/signed-in-console.ts";
import { startTeamConsole, type TeamConsole } from "../test/team-console.ts";
import { base32Decode, stepAt, totpCode } from "./two-factor-harness.ts";

const LINE =
  /^pulse-console owner reset link: \S*\/reset\/([A-Za-z0-9_-]{43}) \(valid 15 minutes, one use/;
const NEW_PASSWORD = "an-owner-recovery-password-91";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

type Run = { code: number | null; stdout: string; stderr: string };

function runCommand(env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    // Only PATH and HOME from the parent: the command must not need the API or secret settings.
    const child = spawn(process.execPath, ["--no-env-file", "src/owner-reset.ts"], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function team(): Promise<TeamConsole> {
  const c = await startTeamConsole({ apiUrl: "http://127.0.0.1:9" });
  cleanups.push(() => c.close());
  return c;
}

function count(db: Database, sql: string, ...args: number[]): number {
  return (
    db.query<{ n: number }, number[]>(`SELECT count(*) AS n FROM ${sql}`).get(...args)?.n ?? -1
  );
}

async function issue(c: TeamConsole, env: Record<string, string> = {}): Promise<string> {
  const r = await runCommand({ PULSE_CONSOLE_DB: c.db.filename, ...env });
  expect(r.code).toBe(0);
  const lines = r.stdout.split("\n").filter((l) => l !== "");
  expect(lines).toHaveLength(1);
  return LINE.exec(lines[0] ?? "")?.[1] ?? "";
}

function createdAt(c: TeamConsole): number {
  return (
    c.db
      .query<{ created_at: number }, []>(
        "SELECT created_at FROM reset_links WHERE kind = 'owner-recovery' ORDER BY id DESC",
      )
      .get()?.created_at ?? -1
  );
}

async function redeem(c: TeamConsole, token: string): Promise<Reply> {
  const page = await getPage(c, `/reset/${token}`, "");
  if (page.status !== 200) return page;
  const csrf =
    /pulse_console_csrf=([A-Za-z0-9_-]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? "";
  return postForm(
    c,
    `/reset/${token}`,
    {
      csrf,
      form_token: formTokenOf(page.body, `/reset/${token}`),
      password: NEW_PASSWORD,
      password_confirm: NEW_PASSWORD,
    },
    { cookie: `pulse_console_csrf=${csrf}` },
  );
}

async function signIn(c: TeamConsole, password: string): Promise<Reply> {
  const page = await getPage(c, "/sign-in", "");
  const csrf = /pulse_console_csrf=([^;]*)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? "";
  return postForm(
    c,
    "/sign-in",
    {
      csrf,
      form_token: formTokenOf(page.body, "/sign-in"),
      email: OWNER_EMAIL,
      password,
      next: "/",
    },
    { cookie: `pulse_console_csrf=${csrf}` },
  );
}

describe("owner recovery command", () => {
  test("before setup it exits 2 with the literal text and prints no link", async () => {
    const dir = mkdtempSync(join(tmpdir(), "console-owner-reset-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "console.db");
    const r = await runCommand({ PULSE_CONSOLE_DB: dbPath });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("pulse-console: no owner account: finish setup first");
    expect(r.stdout).toBe("");
    const db = new Database(dbPath);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    db.close();
  });

  test("a bad setting exits 2 with the existing setting text", async () => {
    const r = await runCommand({ PULSE_CONSOLE_PUBLIC_URL: "https://console.example/path" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      "pulse-console: PULSE_CONSOLE_PUBLIC_URL: must not have a path other than /",
    );
  });

  test("the line names the public origin, else the console address note", async () => {
    const c = await team();
    const loopback = await runCommand({ PULSE_CONSOLE_DB: c.db.filename });
    expect(loopback.stdout).toMatch(
      /^pulse-console owner reset link: \/reset\/[A-Za-z0-9_-]{43} \(valid 15 minutes, one use; open it on the console address\)\n$/,
    );
    const pub = await runCommand({
      PULSE_CONSOLE_DB: c.db.filename,
      PULSE_CONSOLE_PUBLIC_URL: "https://console.example",
    });
    expect(pub.stdout).toMatch(
      /^pulse-console owner reset link: https:\/\/console\.example\/reset\/[A-Za-z0-9_-]{43} \(valid 15 minutes, one use\)\n$/,
    );
    expect(count(c.db, "reset_links WHERE kind = 'owner-recovery' AND used_at IS NULL")).toBe(1);
    expect(count(c.db, "people_events WHERE action = 'owner.recovery-link'")).toBe(2);
    expect(
      c.db
        .query("SELECT DISTINCT actor_kind FROM people_events WHERE action = 'owner.recovery-link'")
        .all(),
    ).toEqual([{ actor_kind: "container" }]);
  });

  test("the link is valid at +899999 ms and 404 at +900000 ms", async () => {
    const c = await team();
    const token = await issue(c);
    expect(c.db.query("SELECT issued_by, target_role FROM reset_links").all()).toEqual([
      { issued_by: null, target_role: "owner" },
    ]);
    c.setNow(createdAt(c) + 899999);
    expect((await getPage(c, `/reset/${token}`, "")).status).toBe(200);
    c.setNow(createdAt(c) + 900000);
    const late = await getPage(c, `/reset/${token}`, "");
    expect(late.status).toBe(404);
    expect(late.body).toContain("Link not valid");
  });

  test("a second run makes the first link fail", async () => {
    const c = await team();
    const first = await issue(c);
    const second = await issue(c);
    c.setNow(createdAt(c) + 1);
    expect((await getPage(c, `/reset/${first}`, "")).status).toBe(404);
    expect((await getPage(c, `/reset/${second}`, "")).status).toBe(200);
  });

  test("use clears the factors and sessions once; the next sign-in leads into enrolment", async () => {
    const c = await team();
    const ownerId = c.ids.owner;
    const token = await issue(c);
    c.setNow(createdAt(c) + 1);
    const used = await redeem(c, token);
    expect(used.status).toBe(303);
    expect(used.headers.get("location")).toBe("/sign-in?reset=done");
    for (const table of [
      "authenticators",
      "recovery_codes",
      "pending_authenticators",
      "sessions",
    ]) {
      expect(count(c.db, `${table} WHERE user_id = ?`, ownerId)).toBe(0);
    }
    expect(count(c.db, "people_events WHERE action = 'owner.recover'")).toBe(1);
    expect((await getPage(c, "/team", c.cookie)).status).toBe(303);
    expect((await getPage(c, `/reset/${token}`, "")).status).toBe(404);

    const signedIn = await signIn(c, NEW_PASSWORD);
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get("location")).toBe("/account/authenticator");
    const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect((await getPage(c, "/team", cookie)).headers.get("location")).toBe(
      "/account/authenticator",
    );

    const start = await getPage(c, "/account/authenticator", cookie);
    const csrf = /name="csrf" value="([^"]+)"/.exec(start.body)?.[1] ?? "";
    await postForm(
      c,
      "/account/authenticator",
      { csrf, form_token: formTokenOf(start.body, "/account/authenticator"), action: "new" },
      { cookie },
    );
    const keyPage = await getPage(c, "/account/authenticator", cookie);
    const key = /id="totp-secret">([A-Z2-7 ]+)</.exec(keyPage.body)?.[1] ?? "";
    const confirmed = await postForm(
      c,
      "/account/authenticator",
      {
        csrf,
        form_token: formTokenOf(keyPage.body, "/account/authenticator"),
        action: "confirm",
        code: totpCode(base32Decode(key), stepAt(createdAt(c) + 1)),
      },
      { cookie },
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toContain('<ol id="recovery-codes">');
    const full = (confirmed.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(full).not.toBe(cookie);
    expect((await getPage(c, "/team", full)).status).toBe(200);
  });

  test("the Team page offers no Owner reset", async () => {
    const c = await team();
    const page = await getPage(c, "/team", c.cookie);
    expect(page.body).not.toContain(`/team/reset-link?user=${c.ids.owner}`);
    expect(page.body).not.toContain("owner-reset");
  });
});
