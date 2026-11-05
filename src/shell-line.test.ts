import { describe, expect, test } from "bun:test";
import { heartbeatLine, hostBindingLine, shellQuote } from "./shell-line.ts";

// Expected values are the literals of the spec, checked in /bin/sh, never built by the helper.
const HOSTILE_HOST_LINE = String.raw`PULSE_PROBE_HEADER_HOSTS='{"PULSE_HEADER_TOKEN":["a'\'';id;'\''b"]}'`;
const HOSTILE_HEARTBEAT_LINE = String.raw`curl -fsS -X POST -H 'Authorization: Bearer <secret>' 'https://a'\'';id;'\''b/heartbeat/x'`;

function runShell(script: string): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["/bin/sh", "-c", script], { stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
}

describe("shellQuote", () => {
  const rows: Array<[string, string]> = [
    ["", "''"],
    ["plain", "'plain'"],
    ["'", String.raw`''\'''`],
    ['a$(id)b"c', `'a$(id)b"c'`],
  ];
  for (const [value, expected] of rows) {
    test(`${JSON.stringify(value)} -> ${expected}`, () => {
      expect(shellQuote(value)).toBe(expected);
    });
  }
});

describe("hostBindingLine", () => {
  test("an apostrophe host stays inside one quoted word", () => {
    expect(hostBindingLine([{ variable: "PULSE_HEADER_TOKEN", host: "a';id;'b" }])).toBe(
      HOSTILE_HOST_LINE,
    );
  });

  test("dollar-parenthesis and double quote, two headers in order", () => {
    expect(
      hostBindingLine([
        { variable: "PULSE_HEADER_A", host: 'a$(id)b"c' },
        { variable: "PULSE_HEADER_B", host: "api.example.com" },
      ]),
    ).toBe(
      String.raw`PULSE_PROBE_HEADER_HOSTS='{"PULSE_HEADER_A":["a$(id)b\"c"],"PULSE_HEADER_B":["api.example.com"]}'`,
    );
  });

  test("/bin/sh assigns exactly the JSON text and runs nothing else", () => {
    const run = runShell(`${HOSTILE_HOST_LINE}\nprintf %s "$PULSE_PROBE_HEADER_HOSTS"`);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(`{"PULSE_HEADER_TOKEN":["a';id;'b"]}`);
  });

  test("/bin/sh round-trips the dollar-parenthesis line", () => {
    const line = hostBindingLine([{ variable: "PULSE_HEADER_A", host: 'a$(id)b"c' }]);
    const run = runShell(`${line}\nprintf %s "$PULSE_PROBE_HEADER_HOSTS"`);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe(String.raw`{"PULSE_HEADER_A":["a$(id)b\"c"]}`);
  });
});

describe("heartbeatLine", () => {
  test("a plain url", () => {
    expect(heartbeatLine("http://localhost:3000/heartbeat/nightly-backup")).toBe(
      "curl -fsS -X POST -H 'Authorization: Bearer <secret>' 'http://localhost:3000/heartbeat/nightly-backup'",
    );
  });

  test("an apostrophe url stays one quoted word", () => {
    expect(heartbeatLine("https://a';id;'b/heartbeat/x")).toBe(HOSTILE_HEARTBEAT_LINE);
  });

  test("/bin/sh splits the arguments into exactly six words", () => {
    const args = HOSTILE_HEARTBEAT_LINE.slice("curl ".length);
    const run = runShell(`set -- ${args}\nprintf '%s\\n' "$#"\nprintf '[%s]' "$@"`);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      "6\n[-fsS][-X][POST][-H][Authorization: Bearer <secret>][https://a';id;'b/heartbeat/x]",
    );
  });
});
