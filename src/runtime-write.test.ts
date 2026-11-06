import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@lorenzh/pulse-kit";
import { STATUS_REVISION, startFakeApi, WIRE_HEADERS } from "../test/fake-api.ts";
import { type AccountStore, createAccountStore, type User } from "./account-store.ts";
import type { CheckWriteDeps } from "./check-write.ts";
import { openDatabase } from "./database.ts";
import type { PeopleEvent } from "./people-log.ts";
import { type RuntimeWrite, sendResend, sendRuntimeWrite } from "./runtime-write.ts";

const TOKEN = "runtime-write-token-sentinel";
const PATH = "/admin/status/settings";
const api = startFakeApi();
afterAll(() => api.stop());

const events: PeopleEvent[] = [];
const lines: string[] = [];
const inits: Array<RequestInit | undefined> = [];
const dir = mkdtempSync(join(tmpdir(), "console-runtime-write-"));
const db = openDatabase(join(dir, "console.db"), {
  createFile: (path, mode) => closeSync(openSync(path, "wx", mode)),
  chmod: chmodSync,
});
const realStore = createAccountStore(db);
const OWNER = { email: "o@example.com", name: "Owner", passwordHash: "$argon2id$fake" };
realStore.completeSetup(OWNER, "http://127.0.0.1:1", 1);
const owner = realStore.userByEmail("o@example.com");
if (owner === undefined) throw new Error("owner missing");
const user: User = owner;
const store: AccountStore = {
  ...realStore,
  appendPeople: (event) => {
    events.push(event);
  },
};
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function deps(schedule?: CheckWriteDeps["schedule"]): CheckWriteDeps {
  return {
    store,
    fetch: (input, init) => {
      inits.push(init);
      return fetch(input, init);
    },
    adminToken: TOKEN,
    schedule,
    now: () => 42,
    log: createLogger({ level: "debug", write: (_level, line) => lines.push(line) }),
  };
}

function write(): RuntimeWrite {
  return {
    action: "status-settings.replace",
    target: { kind: "status-settings" },
    method: "PUT",
    url: `${api.url}${PATH}`,
    revision: STATUS_REVISION,
    body: '{"name":"Value Sentinel"}',
  };
}

beforeEach(() => {
  api.seen.length = 0;
  events.length = 0;
  lines.length = 0;
  inits.length = 0;
});

describe("sendRuntimeWrite", () => {
  test("one PUT with bearer and quoted If-Match; saved from metadata; no value logged", async () => {
    const next = `sha256-${"7".repeat(64)}`;
    api.reply(PATH, {
      status: 200,
      body: "not json",
      headers: { ...WIRE_HEADERS, etag: `"${next}"` },
    });
    const answer = await sendRuntimeWrite(deps(), write(), user);
    expect(answer).toEqual({ kind: "saved", isLogged: true });
    expect(api.seen.map((s) => [s.method, s.authorization, s.headers["if-match"], s.body])).toEqual(
      [["PUT", `Bearer ${TOKEN}`, `"${STATUS_REVISION}"`, '{"name":"Value Sentinel"}']],
    );
    expect(inits[0]?.redirect).toBe("manual");
    expect(events).toEqual([
      {
        at: 42,
        actor: { kind: "user", person: { id: user.id, email: "o@example.com", name: "Owner" } },
        action: "status-settings.replace",
        target: { kind: "status-settings" },
        value: next,
      },
    ]);
    expect(lines.join("\n")).not.toContain("Value Sentinel");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  test("a write without a revision sends no If-Match", async () => {
    api.reply(PATH, { status: 202, headers: WIRE_HEADERS });
    await sendRuntimeWrite(deps(), { ...write(), revision: undefined }, user);
    expect(api.seen[0]?.headers["if-match"]).toBeUndefined();
  });

  test.each([
    [412, { kind: "text", status: 412, message: "", reason: "stale" }],
    [
      403,
      {
        kind: "text",
        status: 502,
        message: "The console token lacks the admin scope.",
        reason: "other",
      },
    ],
    [401, { kind: "text", status: 502, message: "", reason: "token-rejected" }],
    [422, { kind: "form", status: 422, message: "settings.name: bad" }],
  ])("refused %d", async (status, expected) => {
    api.reply(PATH, { status, headers: WIRE_HEADERS, body: '{"error":"settings.name: bad"}' });
    expect(await sendRuntimeWrite(deps(), write(), user)).toEqual(expected as never);
    expect(events).toEqual([]);
    expect(api.seen).toHaveLength(1);
  });

  test("a redirect is unknown, not followed, and logged as unknown", async () => {
    api.reply(PATH, { status: 302, headers: { ...WIRE_HEADERS, location: "http://example.com/" } });
    const answer = await sendRuntimeWrite(deps(), write(), user);
    expect(answer.kind === "text" && answer.message).toContain("open the page again");
    expect(api.seen).toHaveLength(1);
    expect(events.map((e) => e.value)).toEqual(["unknown"]);
  });

  test("no answer within 5000 ms is unknown with one request", async () => {
    api.reply(PATH, { status: 200, isHeld: true });
    const delays: number[] = [];
    const answer = await sendRuntimeWrite(
      deps((fn, ms) => {
        delays.push(ms);
        queueMicrotask(fn);
        return () => undefined;
      }),
      write(),
      user,
    );
    expect(delays).toEqual([5000]);
    expect(answer).toEqual({
      kind: "text",
      status: 504,
      message: "The result is unknown. Open the page again to see whether the change was saved.",
      reason: "other",
    });
    expect(events.map((e) => e.value)).toEqual(["unknown"]);
  });
});

describe("sendResend", () => {
  const request = { channelId: "a", key: "1:opened", requestId: "R".repeat(24) };
  const commandBody = JSON.stringify({
    id: "C".repeat(24),
    ...request,
    state: "queued",
    createdAt: 1,
    updatedAt: 1,
  });

  test.each([200, 202])("%i names the command; no If-Match is sent", async (status) => {
    events.length = 0;
    api.replyTo("POST", "/admin/notify/resends", {
      status,
      headers: WIRE_HEADERS,
      body: commandBody,
    });
    const answer = await sendResend(deps(), api.url, request, user);
    expect(answer).toEqual({ kind: "created", commandId: "C".repeat(24), isLogged: true });
    const seen = api.seen.at(-1);
    expect(seen?.headers["if-match"]).toBeUndefined();
    expect(JSON.parse(seen?.body ?? "")).toEqual(request);
    expect(events.map((e) => [e.action, e.target, e.value])).toEqual([
      ["notify-resend.create", { kind: "notify-resend", channelId: "a" }, "C".repeat(24)],
    ]);
  });

  test("503 is busy with the api reason; 409 is refused", async () => {
    api.replyTo("POST", "/admin/notify/resends", {
      status: 503,
      headers: WIRE_HEADERS,
      body: JSON.stringify({ error: "too many resend requests" }),
    });
    expect(await sendResend(deps(), api.url, request, user)).toEqual({
      kind: "busy",
      message: "pulse-api cannot take a resend now: too many resend requests. Try again later.",
    });
    api.replyTo("POST", "/admin/notify/resends", {
      status: 409,
      headers: WIRE_HEADERS,
      body: JSON.stringify({ error: "not a failed delivery" }),
    });
    expect(await sendResend(deps(), api.url, request, user)).toEqual({
      kind: "refused",
      answer: { kind: "form", status: 409, message: "not a failed delivery" },
    });
  });
});
