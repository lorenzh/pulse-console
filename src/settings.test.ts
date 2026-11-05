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
      probePrefill: { apiUrl: undefined, image: undefined, network: undefined },
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

describe("PULSE_CONSOLE_SECRET_KEY_FILE", () => {
  const KEY_HEX = "0123456789abcdef".repeat(4);
  const files: Record<string, string> = {
    "/run/key": `${KEY_HEX}\n`,
    "/run/short": "0".repeat(63),
    "/run/upper": KEY_HEX.toUpperCase(),
    "/run/two-newlines": `${KEY_HEX}\n\n`,
    "/run/same": KEY_HEX,
  };
  function read(path: string): string {
    const text = files[path];
    if (text === undefined) {
      throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
    }
    return text;
  }
  function keyFailure(env: Record<string, string>): string {
    try {
      readSettings({ PULSE_API_URL: API, ...env }, read);
    } catch (err) {
      expect(err).toBeInstanceOf(StartupError);
      return err instanceof Error ? err.message : "";
    }
    throw new Error("readSettings did not throw");
  }

  test("a valid file with one trailing newline gives the 32 key bytes; unset gives none", () => {
    const s = readSettings({ PULSE_API_URL: API, PULSE_CONSOLE_SECRET_KEY_FILE: "/run/key" }, read);
    expect(Buffer.from(s.secretKey ?? new Uint8Array()).toString("hex")).toBe(KEY_HEX);
    expect(readSettings({ PULSE_API_URL: API }, read).secretKey).toBeUndefined();
  });

  test("each start error has its literal text and never the file content", () => {
    const cases: [string, string, Record<string, string>][] = [
      ["/run/missing", "PULSE_CONSOLE_SECRET_KEY_FILE=/run/missing: cannot read (ENOENT)", {}],
      [
        "/run/short",
        "PULSE_CONSOLE_SECRET_KEY_FILE=/run/short: must hold 64 lowercase hex characters",
        {},
      ],
      [
        "/run/upper",
        "PULSE_CONSOLE_SECRET_KEY_FILE=/run/upper: must hold 64 lowercase hex characters",
        {},
      ],
      [
        "/run/two-newlines",
        "PULSE_CONSOLE_SECRET_KEY_FILE=/run/two-newlines: must hold 64 lowercase hex characters",
        {},
      ],
      [
        "/run/same",
        "PULSE_CONSOLE_SECRET_KEY_FILE=/run/same: must differ from the admin token",
        { PULSE_CONSOLE_ADMIN_TOKEN: KEY_HEX },
      ],
    ];
    for (const [path, text, extra] of cases) {
      const message = keyFailure({ PULSE_CONSOLE_SECRET_KEY_FILE: path, ...extra });
      expect(message).toBe(text);
      expect(message.toLowerCase()).not.toContain(KEY_HEX);
    }
  });

  test("the key is checked after the admin token", () => {
    expect(
      keyFailure({
        PULSE_CONSOLE_ADMIN_TOKEN: "short",
        PULSE_CONSOLE_SECRET_KEY_FILE: "/run/short",
      }),
    ).toBe("PULSE_CONSOLE_ADMIN_TOKEN must hold at least 32 characters");
  });
});

describe("PULSE_CONSOLE_PROBE_* prefills", () => {
  const IMAGE_RULE =
    "must hold 1 to 255 characters of A-Z a-z 0-9 . _ / : @ - and start with a letter or digit";
  const NETWORK_RULE =
    "must start with a letter or digit and hold at most 128 characters of A-Z a-z 0-9 _ . -";
  const API_URL_RULE =
    "must be an http(s) URL of at most 2048 characters without whitespace, credentials, query or fragment";

  test("set values are read, one trailing slash dropped, the console URL never copied", () => {
    const settings = readSettings(
      {
        PULSE_API_URL: API,
        PULSE_CONSOLE_PROBE_API_URL: " https://pulse.example/api/ ",
        PULSE_CONSOLE_PROBE_IMAGE: "ghcr.io/lorenzh/pulse-probe:1.2.3",
        PULSE_CONSOLE_PROBE_NETWORK: "pulse_default",
      },
      noFile,
    );
    expect(settings.probePrefill).toEqual({
      apiUrl: "https://pulse.example/api",
      image: "ghcr.io/lorenzh/pulse-probe:1.2.3",
      network: "pulse_default",
    });
  });

  test("blank counts as unset", () => {
    const settings = readSettings(
      {
        PULSE_API_URL: API,
        PULSE_CONSOLE_PROBE_API_URL: " ",
        PULSE_CONSOLE_PROBE_IMAGE: "",
        PULSE_CONSOLE_PROBE_NETWORK: "  ",
      },
      noFile,
    );
    expect(settings.probePrefill).toEqual({
      apiUrl: undefined,
      image: undefined,
      network: undefined,
    });
  });

  test("an invalid value stops the start with its rule and without the value", () => {
    for (const [name, value, rule] of [
      ["PULSE_CONSOLE_PROBE_API_URL", "ftp://secret-host", API_URL_RULE],
      ["PULSE_CONSOLE_PROBE_API_URL", "http://u:secret@api", API_URL_RULE],
      ["PULSE_CONSOLE_PROBE_API_URL", "http://api/?secret=1", API_URL_RULE],
      ["PULSE_CONSOLE_PROBE_IMAGE", "-secret", IMAGE_RULE],
      ["PULSE_CONSOLE_PROBE_IMAGE", "secret image", IMAGE_RULE],
      ["PULSE_CONSOLE_PROBE_NETWORK", "-secret", NETWORK_RULE],
    ] as const) {
      const message = failure({ PULSE_API_URL: API, [name]: value });
      expect(message).toBe(`${name}: ${rule}`);
      expect(message).not.toContain("secret");
    }
  });

  test("they are read after the key file, in URL, image, network order", () => {
    const allBad = {
      PULSE_API_URL: API,
      PULSE_CONSOLE_PROBE_API_URL: "ftp://x",
      PULSE_CONSOLE_PROBE_IMAGE: "-x",
      PULSE_CONSOLE_PROBE_NETWORK: "-x",
    };
    expect(failure(allBad)).toBe(`PULSE_CONSOLE_PROBE_API_URL: ${API_URL_RULE}`);
    const imageAndNetwork = { ...allBad, PULSE_CONSOLE_PROBE_API_URL: "" };
    expect(failure(imageAndNetwork)).toBe(`PULSE_CONSOLE_PROBE_IMAGE: ${IMAGE_RULE}`);
    const network = { ...imageAndNetwork, PULSE_CONSOLE_PROBE_IMAGE: "" };
    expect(failure(network)).toBe(`PULSE_CONSOLE_PROBE_NETWORK: ${NETWORK_RULE}`);
    expect(() =>
      readSettings({ ...allBad, PULSE_CONSOLE_SECRET_KEY_FILE: "/missing/key" }, noFile),
    ).toThrow("PULSE_CONSOLE_SECRET_KEY_FILE=/missing/key: cannot read");
  });
});
