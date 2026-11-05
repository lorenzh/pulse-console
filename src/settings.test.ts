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
      publicOrigin: undefined,
      mode: "loopback",
      dbPath: "./console.db",
      secretKey: undefined,
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
      { PULSE_API_URL: API, PULSE_CONSOLE_ADMIN_TOKEN: "abcdefghijklmnopqrstuvwxyz012345" },
      noFile,
    );
    expect(s.adminToken).toBe("abcdefghijklmnopqrstuvwxyz012345");
    expect(
      failure({ PULSE_API_URL: API, PULSE_CONSOLE_ADMIN_TOKEN: "abcdefghijklmnopqrstuvwxyz01234" }),
    ).toBe("PULSE_CONSOLE_ADMIN_TOKEN must hold at least 32 characters");
  });
});

describe("PULSE_CONSOLE_DB", () => {
  test("defaults to ./console.db; blank counts as unset; the value is trimmed", () => {
    expect(readSettings({ PULSE_API_URL: API }, noFile).dbPath).toBe("./console.db");
    expect(readSettings({ PULSE_API_URL: API, PULSE_CONSOLE_DB: "  " }, noFile).dbPath).toBe(
      "./console.db",
    );
    expect(
      readSettings({ PULSE_API_URL: API, PULSE_CONSOLE_DB: " /data/console.db\n" }, noFile).dbPath,
    ).toBe("/data/console.db");
  });

  test("DATABASE_URL is not read", () => {
    const s = readSettings({ PULSE_API_URL: API, DATABASE_URL: "postgres://x/y" }, noFile);
    expect(s.dbPath).toBe("./console.db");
    expect(JSON.stringify(s)).not.toContain("postgres");
  });
});

describe("PULSE_CONSOLE_PUBLIC_URL and the mode", () => {
  const NAME = "PULSE_CONSOLE_PUBLIC_URL";
  const mode = (value: string): unknown =>
    readSettings({ PULSE_API_URL: API, [NAME]: value }, noFile).mode;

  test("unset, blank or an http loopback host selects loopback", () => {
    expect(readSettings({ PULSE_API_URL: API, [NAME]: " " }, noFile).mode).toBe("loopback");
    for (const value of ["http://127.0.0.1:8082", "http://localhost:8082/", "http://[::1]:8082"]) {
      expect(mode(value)).toBe("loopback");
    }
  });

  test("https selects strict-https, other http hosts select strict-http", () => {
    expect(mode("https://console.example.com")).toBe("strict-https");
    expect(mode("https://localhost")).toBe("strict-https");
    expect(mode("http://console.example.com")).toBe("strict-http");
    expect(mode("http://10.0.0.5:8082")).toBe("strict-http");
  });

  test("the value is kept as its origin", () => {
    const s = readSettings(
      { PULSE_API_URL: API, [NAME]: "https://Console.Example.com:443/" },
      noFile,
    );
    expect(s.publicOrigin).toBe("https://console.example.com");
  });

  test("invalid values get the PULSE_API_URL texts with this name, without the value", () => {
    const cases: [string, string][] = [
      ["http://con\tsole.example", `${NAME}: must not contain whitespace or control characters`],
      [
        "http://u:secret@console.example",
        `${NAME}: must be an http(s) URL without credentials, query or fragment`,
      ],
      [
        "http://console.example/?secret=1",
        `${NAME}: must be an http(s) URL without credentials, query or fragment`,
      ],
      [
        "http://console.example/#secret",
        `${NAME}: must be an http(s) URL without credentials, query or fragment`,
      ],
      [
        "ftp://console.example",
        `${NAME}: must be an http(s) URL without credentials, query or fragment`,
      ],
      ["http://console.example/secret", `${NAME}: must not have a path other than /`],
      ["https://console.example//", `${NAME}: must not have a path other than /`],
      ["https://console.example/a/", `${NAME}: must not have a path other than /`],
    ];
    for (const [value, text] of cases) {
      const message = failure({ PULSE_API_URL: API, [NAME]: value });
      expect(message).toBe(text);
      expect(message).not.toContain("secret");
    }
  });

  test("order: host, then public URL, then the admin token", () => {
    const bad = { PULSE_CONSOLE_PUBLIC_URL: "ftp://x", PULSE_CONSOLE_ADMIN_TOKEN: "short" };
    expect(failure({ PULSE_CONSOLE_PORT: "x", ...bad })).toBe("PULSE_API_URL must be set");
    expect(failure({ PULSE_API_URL: API, PULSE_CONSOLE_PORT: "x", ...bad })).toBe(
      "PULSE_CONSOLE_PORT: must be an integer from 0 to 65535",
    );
    expect(failure({ PULSE_API_URL: API, ...bad })).toBe(
      `${NAME}: must be an http(s) URL without credentials, query or fragment`,
    );
  });
});
