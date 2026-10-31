/* eslint-disable sonarjs/no-clear-text-protocols -- the URLs are setting values under test; no request is made */
import { describe, expect, test } from "bun:test";
import { StartupError } from "@lorenzh/pulse-kit";
import { readSettings } from "./settings.ts";

const API = "http://api:3000";
const URL_RULE = "PULSE_API_URL: must be an http(s) URL without credentials, query or fragment";
const WHITESPACE_RULE = "PULSE_API_URL: must not contain whitespace or control characters";

function noFile(path: string): string {
  throw new Error(`unexpected read of ${path}`);
}

/** The StartupError message of a failing read; fails the test when it does not throw one. */
function failure(env: Record<string, string>): string {
  try {
    readSettings(env, noFile);
  } catch (err) {
    expect(err).toBeInstanceOf(StartupError);
    return err instanceof Error ? err.message : "";
  }
  throw new Error("readSettings did not throw");
}

describe("PULSE_API_URL", () => {
  test("unset or blank stops the start", () => {
    expect(failure({})).toBe("PULSE_API_URL must be set");
    expect(failure({ PULSE_API_URL: "   " })).toBe("PULSE_API_URL must be set");
  });

  test("an invalid value gets kit's line without the value", () => {
    for (const value of [
      "not-a-url-secret",
      "ftp://api:3000",
      "http://u:hunter2-secret@api:3000",
      "http://api:3000/?x=1",
      "http://api:3000/#frag",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "http://",
    ]) {
      const message = failure({ PULSE_API_URL: value });
      expect(message).toBe(URL_RULE);
      expect(message).not.toContain("secret");
    }
  });

  test("whitespace or a control character inside is refused before the URL parser", () => {
    for (const value of [
      "http://api\n:3000",
      "http://api\t:3000",
      "http://ap\ri:3000",
      "http://api\x01:3000",
      "http://api :3000",
      "http://api\x7f:3000",
    ]) {
      expect(failure({ PULSE_API_URL: value })).toBe(WHITESPACE_RULE);
    }
  });

  test("whitespace at the ends and one trailing slash are dropped", () => {
    expect(readSettings({ PULSE_API_URL: "  http://api:3000\n" }, noFile).apiUrl).toBe(API);
    expect(readSettings({ PULSE_API_URL: "http://api:3000/" }, noFile).apiUrl).toBe(API);
    expect(readSettings({ PULSE_API_URL: "https://api.example/base" }, noFile).apiUrl).toBe(
      "https://api.example/base",
    );
  });
});

describe("PULSE_CONSOLE_PORT and PULSE_CONSOLE_HOST", () => {
  test("defaults are 8082 and 127.0.0.1, and no admin token", () => {
    expect(readSettings({ PULSE_API_URL: API }, noFile)).toEqual({
      apiUrl: API,
      port: 8082,
      host: "127.0.0.1",
      adminToken: undefined,
    });
    const blank = readSettings(
      { PULSE_API_URL: API, PULSE_CONSOLE_PORT: "", PULSE_CONSOLE_HOST: " " },
      noFile,
    );
    expect(blank.port).toBe(8082);
    expect(blank.host).toBe("127.0.0.1");
  });

  test("port 0 and a set host are accepted", () => {
    const s = readSettings(
      { PULSE_API_URL: API, PULSE_CONSOLE_PORT: "0", PULSE_CONSOLE_HOST: "0.0.0.0" },
      noFile,
    );
    expect(s.port).toBe(0);
    expect(s.host).toBe("0.0.0.0");
    expect(readSettings({ PULSE_API_URL: API, PULSE_CONSOLE_PORT: "65535" }, noFile).port).toBe(
      65535,
    );
  });

  test("a port outside 0 to 65535 or not an integer is refused", () => {
    for (const value of ["65536", "-1", "80a", "8082.0"]) {
      expect(failure({ PULSE_API_URL: API, PULSE_CONSOLE_PORT: value })).toBe(
        "PULSE_CONSOLE_PORT: must be an integer from 0 to 65535",
      );
    }
  });
});

describe("order of checks", () => {
  test("PULSE_API_URL is checked before the port, the port before the admin token", () => {
    expect(failure({ PULSE_CONSOLE_PORT: "x", PULSE_CONSOLE_ADMIN_TOKEN: "short" })).toBe(
      "PULSE_API_URL must be set",
    );
    expect(
      failure({ PULSE_API_URL: API, PULSE_CONSOLE_PORT: "x", PULSE_CONSOLE_ADMIN_TOKEN: "short" }),
    ).toBe("PULSE_CONSOLE_PORT: must be an integer from 0 to 65535");
  });

  test("the admin token is part of the settings", () => {
    const s = readSettings(
      { PULSE_API_URL: API, PULSE_CONSOLE_ADMIN_TOKEN: "abcdefghijklmnop0123" },
      noFile,
    );
    expect(s.adminToken).toBe("abcdefghijklmnop0123");
    expect(failure({ PULSE_API_URL: API, PULSE_CONSOLE_ADMIN_TOKEN: "exactly-15-char" })).toBe(
      "PULSE_CONSOLE_ADMIN_TOKEN must hold at least 16 characters",
    );
  });
});
