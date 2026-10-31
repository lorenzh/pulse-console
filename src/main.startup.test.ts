import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- the .invalid host is never resolved; no request is made
const API_URL = "http://api.invalid:3000";

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function spawnMain(env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ["src/main.ts"], {
    env: { PATH: process.env.PATH ?? "", PULSE_CONSOLE_PORT: "0", ...env },
  });
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
