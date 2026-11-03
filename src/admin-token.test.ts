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
const T31 = "abcdefghijklmnopqrstuvwxyz01234";
const T32 = "abcdefghijklmnopqrstuvwxyz012345";

// Each case: the token, the rule text that both sources must report.
const REFUSED: readonly (readonly [string, string])[] = [
  [T31, "must hold at least 32 characters"],
  ["exactly-16-chars", "must hold at least 32 characters"],
  ["replace-with-", "must hold at least 32 characters"],
  ["abcdefghijklmnop qrstuvwxyz012345", "must not contain whitespace"],
  ["abcdefghijklmnop\tqrstuvwxyz012345", "must not contain whitespace"],
  ["abcdefghijklmnopqrstuvwxyz012345\u0000", "must hold printable ASCII"],
  ["abcdefghijklmnopqrstuvwxyz012345é", "must hold printable ASCII"],
  ["replace-with-a-random-token-0123456789", "still has the example placeholder"],
  // The public example tokens are shorter than 32, so the length rule reports them first.
  ["example-token-change-me-0000", "must hold at least 32 characters"],
  ["example-token-0123456789abcdef", "must hold at least 32 characters"],
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
  test("32 characters after trim and a near example token are accepted", () => {
    expect(readAdminToken({ PULSE_CONSOLE_ADMIN_TOKEN: T32 }, noFile)).toBe(T32);
    expect(readAdminToken({ PULSE_CONSOLE_ADMIN_TOKEN: `  ${T32}\n` }, noFile)).toBe(T32);
    expect(
      readAdminToken({ PULSE_CONSOLE_ADMIN_TOKEN: "example-token-0123456789abcdef01" }, noFile),
    ).toBe("example-token-0123456789abcdef01");
  });

  test.each(REFUSED)("%p is refused with the rule and without the value", (token, rule) => {
    const message = envFailure(token);
    expect(message).toBe(`PULSE_CONSOLE_ADMIN_TOKEN ${rule}`);
    expect(message).not.toContain(token);
  });
});

describe("PULSE_CONSOLE_ADMIN_TOKEN_FILE", () => {
  test("32 characters after trim are accepted", () => {
    expect(readAdminToken({ PULSE_CONSOLE_ADMIN_TOKEN_FILE: PATH }, fileWith(`  ${T32}\n`))).toBe(
      T32,
    );
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

  test("a read error and file content never reach the message", () => {
    let err: unknown;
    try {
      readAdminToken({ PULSE_CONSOLE_ADMIN_TOKEN_FILE: PATH }, () => {
        throw new Error("secret-sentinel");
      });
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(StartupError);
    expect(err instanceof StartupError ? err.setting : undefined).toBe(
      "PULSE_CONSOLE_ADMIN_TOKEN_FILE",
    );
    expect(err instanceof Error ? err.message : "").not.toContain("secret-sentinel");
    expect(fileFailure("secret-sentinel-0000\nx")).not.toContain("secret-sentinel");
  });

  test("a short multi-line file reports one line before length", () => {
    expect(fileFailure("short\nline")).toBe(`${FILE_PREFIX}must hold one line`);
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
