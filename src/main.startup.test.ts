/* eslint-disable sonarjs/no-clear-text-protocols -- loopback test servers and URL inputs under test */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_URL = "http://api.invalid:3000";

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "console-startup-"));
  dirs.push(dir);
  return dir;
}

function spawnMain(env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ["src/main.ts"], {
    env: {
      PATH: process.env.PATH ?? "",
      PULSE_CONSOLE_PORT: "0",
      PULSE_CONSOLE_DB: join(tempDir(), "console.db"),
      ...env,
    },
  });
}

/** Starts main, waits for the listening line, stops it with SIGTERM. */
async function runUntilListening(
  env: Record<string, string>,
  marker = "pulse-console listening",
): Promise<Run> {
  const child = spawnMain(env);
  let isSignalled = false;
  const r = await collect(child, (all) => {
    if (!isSignalled && all.includes(marker)) {
      isSignalled = true;
      child.kill("SIGTERM");
    }
  });
  expect(isSignalled).toBe(true);
  return r;
}

const CODE_LINE =
  /^pulse-console setup code: [0-9a-f]{4}(?:-[0-9a-f]{4}){7} \(open \/setup; a restart prints a new code\)$/;

function codeLines(r: Run): string[] {
  return r.stdout.split("\n").filter((l) => l.includes("setup code:"));
}

function completeSetup(dbPath: string, apiUrl: string): void {
  const db = new Database(dbPath);
  db.run("INSERT INTO instance (id, api_url, setup_completed_at) VALUES (1, ?, 1)", [apiUrl]);
  db.close();
}

function collect(child: ChildProcess, onStdout?: (all: string) => void): Promise<Run> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += String(d);
      onStdout?.(stdout);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function assertOneLine(r: Run, expected: string): void {
  assert.equal(r.code, 2);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, `${expected}\n`);
}

test("a missing PULSE_API_URL prints one line and exits 2", async () => {
  const r = await collect(spawnMain({}));
  assertOneLine(r, "pulse-console: PULSE_API_URL must be set");
});

test("an invalid PULSE_API_URL prints kit's line without the value and exits 2", async () => {
  const r = await collect(spawnMain({ PULSE_API_URL: "not-a-url-secret" }));
  assertOneLine(
    r,
    "pulse-console: PULSE_API_URL: must be an http(s) URL without credentials, query or fragment",
  );
  assert.ok(!r.stderr.includes("not-a-url-secret"));
});

test("a valid start listens, never logs the token and exits 0 on SIGTERM", async () => {
  const sentinel = "startup-sentinel-token-0123456789";
  const child = spawnMain({
    PULSE_API_URL: API_URL,
    PULSE_CONSOLE_ADMIN_TOKEN: sentinel,
  });
  let isSignalled = false;
  const r = await collect(child, (all) => {
    if (!isSignalled && all.includes("pulse-console listening")) {
      isSignalled = true;
      child.kill("SIGTERM");
    }
  });
  expect(isSignalled).toBe(true);
  expect(r.code).toBe(0);
  const listening = r.stdout.split("\n").find((l) => l.includes("pulse-console listening"));
  assert.ok(listening !== undefined);
  const fields: unknown = JSON.parse(listening);
  expect(fields).toMatchObject({
    msg: "pulse-console listening",
    host: "127.0.0.1",
    apiUrl: API_URL,
    hasAdminToken: true,
  });
  expect(r.stdout + r.stderr).not.toContain(sentinel);
}, 10_000);

test("a fresh database prints one setup code line, also at log level error", async () => {
  const dbPath = join(tempDir(), "console.db");
  const r = await runUntilListening(
    { PULSE_API_URL: API_URL, PULSE_CONSOLE_DB: dbPath, PULSE_LOG_LEVEL: "error" },
    "setup code:",
  );
  expect(r.code).toBe(0);
  const lines = codeLines(r);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(CODE_LINE);
  expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  const again = await runUntilListening({ PULSE_API_URL: API_URL, PULSE_CONSOLE_DB: dbPath });
  const next = codeLines(again);
  expect(next).toHaveLength(1);
  expect(next[0]).not.toBe(lines[0]);
}, 20_000);

test("a set-up database prints no code; a differing PULSE_API_URL warns without a URL", async () => {
  const dbPath = join(tempDir(), "console.db");
  await runUntilListening({ PULSE_API_URL: API_URL, PULSE_CONSOLE_DB: dbPath });
  completeSetup(dbPath, "http://saved.invalid:3000");
  const r = await runUntilListening({ PULSE_API_URL: API_URL, PULSE_CONSOLE_DB: dbPath });
  expect(codeLines(r)).toHaveLength(0);
  const warn = r.stderr.split("\n").filter((l) => l.includes("PULSE_API_URL differs"));
  expect(warn).toHaveLength(1);
  expect(JSON.parse(warn[0] ?? "{}")).toMatchObject({
    level: "warn",
    msg: "PULSE_API_URL differs from the API URL saved at setup; the saved URL is used",
  });
  expect(warn[0]).not.toContain("invalid");
  const listening = r.stdout.split("\n").find((l) => l.includes("pulse-console listening"));
  expect(JSON.parse(listening ?? "{}")).toMatchObject({
    apiUrl: "http://saved.invalid:3000",
    mode: "loopback",
    isSetUp: true,
  });
}, 20_000);

test("strict-http logs its warning and the listening line names the mode", async () => {
  const r = await runUntilListening({
    PULSE_API_URL: API_URL,
    PULSE_CONSOLE_PUBLIC_URL: "http://console.lan",
  });
  expect(r.code).toBe(0);
  expect(r.stderr).toContain(
    '"msg":"PULSE_CONSOLE_PUBLIC_URL uses http: session cookies are not marked Secure"',
  );
  const listening = r.stdout.split("\n").find((l) => l.includes("pulse-console listening"));
  expect(JSON.parse(listening ?? "{}")).toMatchObject({ mode: "strict-http", isSetUp: false });
}, 20_000);

test("database start errors exit 2 with their literal text and print no code", async () => {
  const dir = tempDir();
  const missing = join(dir, "missing", "console.db");
  const corrupt = join(dir, "corrupt.db");
  writeFileSync(corrupt, Buffer.alloc(4096, 0xab));
  const newer = join(dir, "newer.db");
  const db = new Database(newer);
  db.run("PRAGMA user_version = 2");
  db.close();
  for (const [path, text] of [
    [missing, `PULSE_CONSOLE_DB=${missing}: cannot open (ENOENT)`],
    [corrupt, `PULSE_CONSOLE_DB=${corrupt}: cannot open (SQLITE_NOTADB)`],
    [newer, `PULSE_CONSOLE_DB=${newer}: schema version 2 is newer than this console (1)`],
  ] as const) {
    const r = await collect(spawnMain({ PULSE_API_URL: API_URL, PULSE_CONSOLE_DB: path }));
    assertOneLine(r, `pulse-console: ${text}`);
  }
}, 20_000);

test("bun src/main.ts serves no /__test/ route", async () => {
  const child = spawnMain({ PULSE_API_URL: API_URL });
  let answer: Promise<{ status: number; body: string }> | undefined;
  const r = await collect(child, (all) => {
    const line = all.split("\n").find((l) => l.includes("pulse-console listening"));
    if (answer !== undefined || line === undefined) return;
    const fields: unknown = JSON.parse(line);
    const port: unknown =
      typeof fields === "object" && fields !== null ? Reflect.get(fields, "port") : 0;
    answer = fetch(`http://127.0.0.1:${String(port)}/__test/states/empty`).then(async (res) => ({
      status: res.status,
      body: await res.text(),
    }));
    void answer.finally(() => child.kill("SIGTERM"));
  });
  expect(r.code).toBe(0);
  expect(await answer).toEqual({ status: 404, body: "not found\n" });
}, 10_000);
