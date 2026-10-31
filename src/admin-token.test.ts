import { describe, expect, test } from "bun:test";
import { StartupError } from "@lorenzh/pulse-kit";
import { readAdminToken } from "./admin-token.ts";

const PATH = "/run/secrets/console-token";
const FILE_PREFIX = `PULSE_CONSOLE_ADMIN_TOKEN_FILE=${PATH}: `;

function noFile(path: string): string {
  throw new Error(`unexpected read of ${path}`);
}

function fileWith(content: string): (path: string) => string {
  return (path) => {
    expect(path).toBe(PATH);
    return content;
  };
}

function fsError(code: string): (path: string) => string {
  return () => {
    throw Object.assign(new Error(`${code}: raw message with file content xyz`), { code });
  };
}

function failure(env: Record<string, string>, readFile: (path: string) => string): string {
  try {
    readAdminToken(env, readFile);
  } catch (err) {
    expect(err).toBeInstanceOf(StartupError);
    return err instanceof Error ? err.message : "";
  }
  throw new Error("readAdminToken did not throw");
}

const envFailure = (token: string): string => failure({ PULSE_CONSOLE_ADMIN_TOKEN: token }, noFile);
const fileFailure = (content: string): string =>
  failure({ PULSE_CONSOLE_ADMIN_TOKEN_FILE: PATH }, fileWith(content));

// Each case: the token, the rule text that both sources must report.
const REFUSED: readonly (readonly [string, string])[] = [
  ["exactly-15-char", "must hold at least 16 characters"],
  ["replace-with-", "must hold at least 16 characters"],
  ["abcdefgh ijklmnop", "must not contain whitespace"],
  ["abcdefgh\tijklmnop", "must not contain whitespace"],
  ["abcdefghijklmnop\u0000", "must hold printable ASCII"],
  ["abcdefghijklmnopé", "must hold printable ASCII"],
  ["replace-with-a-random-token", "still has the example placeholder"],
  ["example-token-change-me-0000", "is a public example token: generate your own"],
  ["example-token-0123456789abcdef", "is a public example token: generate your own"],
];

describe("sources", () => {
  test("neither setting gives no token, and blank counts as unset", () => {
    expect(readAdminToken({}, noFile)).toBeUndefined();
    expect(
      readAdminToken(
        { PULSE_CONSOLE_ADMIN_TOKEN: "  ", PULSE_CONSOLE_ADMIN_TOKEN_FILE: "" },
        noFile,
      ),
    ).toBeUndefined();
  });

  test("both set is refused before the file is read", () => {
    const message = failure(
      {
        PULSE_CONSOLE_ADMIN_TOKEN: "abcdefghijklmnop0123",
        PULSE_CONSOLE_ADMIN_TOKEN_FILE: "/run/secrets/other-token",
      },
      noFile,
    );
    expect(message).toBe(
      "set only one of PULSE_CONSOLE_ADMIN_TOKEN and PULSE_CONSOLE_ADMIN_TOKEN_FILE",
    );
  });
});

describe("PULSE_CONSOLE_ADMIN_TOKEN", () => {
  test("16 characters after trim and a near example token are accepted", () => {
    expect(readAdminToken({ PULSE_CONSOLE_ADMIN_TOKEN: "exactly-16-chars" }, noFile)).toBe(
      "exactly-16-chars",
    );
    expect(readAdminToken({ PULSE_CONSOLE_ADMIN_TOKEN: "  exactly-16-chars\n" }, noFile)).toBe(
      "exactly-16-chars",
    );
    expect(
      readAdminToken({ PULSE_CONSOLE_ADMIN_TOKEN: "example-token-change-me-0001" }, noFile),
    ).toBe("example-token-change-me-0001");
  });

  test.each(REFUSED)("%p is refused with the rule and without the value", (token, rule) => {
    const message = envFailure(token);
    expect(message).toBe(`PULSE_CONSOLE_ADMIN_TOKEN ${rule}`);
    expect(message).not.toContain(token);
  });
});

describe("PULSE_CONSOLE_ADMIN_TOKEN_FILE", () => {
  test("the content is trimmed", () => {
    expect(
      readAdminToken({ PULSE_CONSOLE_ADMIN_TOKEN_FILE: PATH }, fileWith("abcdefghijklmnop0123\n")),
    ).toBe("abcdefghijklmnop0123");
    expect(
      readAdminToken(
        { PULSE_CONSOLE_ADMIN_TOKEN_FILE: PATH },
        fileWith("example-token-change-me-0001"),
      ),
    ).toBe("example-token-change-me-0001");
  });

  test("a read failure names the path and the code only", () => {
    for (const code of ["ENOENT", "EISDIR", "EACCES"]) {
      const message = failure({ PULSE_CONSOLE_ADMIN_TOKEN_FILE: PATH }, fsError(code));
      expect(message).toBe(`${FILE_PREFIX}cannot read (${code})`);
    }
    const noCode = failure({ PULSE_CONSOLE_ADMIN_TOKEN_FILE: PATH }, () => {
      throw new Error("xyz");
    });
    expect(noCode).toBe(`${FILE_PREFIX}cannot read`);
  });

  test("an empty file is refused", () => {
    expect(fileFailure("")).toBe(`${FILE_PREFIX}file is empty`);
    expect(fileFailure(" \n\n")).toBe(`${FILE_PREFIX}file is empty`);
  });

  test("two lines are refused without either line", () => {
    const message = fileFailure("abcdefghijklmnop0123\nsecond-line");
    expect(message).toBe(`${FILE_PREFIX}must hold one line`);
    expect(message).not.toContain("abcdefghijklmnop0123");
    expect(message).not.toContain("second-line");
    expect(fileFailure("abcdefghijklmnop\r\n0123")).toBe(`${FILE_PREFIX}must hold one line`);
  });

  test.each(REFUSED)("%p is refused with the rule and without the content", (token, rule) => {
    const message = fileFailure(token);
    expect(message).toBe(`${FILE_PREFIX}${rule}`);
    expect(message).not.toContain(token);
  });
});
