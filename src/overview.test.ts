import { describe, expect, test } from "bun:test";
import type { CheckState, CheckWithState } from "@lorenzh/pulse-contract";
import { overallState, overviewView, summarizeChecks } from "./overview.ts";

describe("overallState", () => {
  const rows: [CheckState[], CheckState | undefined][] = [
    [["up", "unknown"], "unknown"],
    [["maintenance", "unknown"], "unknown"],
    [["up", "maintenance"], "maintenance"],
    [["maintenance", "maintenance"], "maintenance"],
    [["degraded", "down", "up"], "down"],
    [["degraded", "up", "unknown"], "degraded"],
    [["up", "up"], "up"],
    [[], undefined],
  ];
  for (const [states, expected] of rows) {
    test(`[${states.join(",")}] gives ${String(expected)}`, () => {
      expect(overallState(summarizeChecks(states))).toBe(expected);
    });
  }
});

describe("summarizeChecks", () => {
  test("[down,down,up] keeps zero counts", () => {
    expect(summarizeChecks(["down", "down", "up"])).toEqual({
      down: 2,
      degraded: 0,
      unknown: 0,
      maintenance: 0,
      up: 1,
      total: 3,
    });
  });
});

const check = (state: CheckState): CheckWithState => ({
  id: "a",
  name: "A",
  url: "https://a.test",
  intervalMs: 1000,
  state,
  consecutiveDown: 0,
  lastResultAt: null,
  lastReason: null,
  locations: [],
});

describe("overviewView", () => {
  const origin = "http://api.test:3000";

  test("counts in order with labels and the overall text", () => {
    const view = overviewView(origin, {
      kind: "ok",
      checks: [check("down"), check("down"), check("up")],
    });
    expect(view.banner).toBe("");
    expect(view.body).toContain('<p class="mono">pulse-api: http://api.test:3000</p>');
    expect(view.body).toContain("<p>Overall state: Down. At least one check is down.</p>");
    expect(view.body).toContain(
      '<ul class="counts mono">\n<li><span class="check-state check-state-down"><span class="dot" aria-hidden="true"></span></span>Down: 2</li>\n<li><span class="check-state check-state-degraded"><span class="dot" aria-hidden="true"></span></span>Degraded: 0</li>\n<li><span class="check-state check-state-unknown"><span class="dot" aria-hidden="true"></span></span>Unknown: 0</li>\n<li><span class="check-state check-state-maintenance"><span class="dot" aria-hidden="true"></span></span>Maintenance: 0</li>\n<li><span class="check-state check-state-up"><span class="dot" aria-hidden="true"></span></span>Up: 1</li>\n<li>Total: 3</li>\n</ul>',
    );
  });

  const texts: [CheckState, string][] = [
    ["degraded", "Overall state: Degraded. At least one check is degraded, none is down."],
    ["unknown", "Overall state: Unknown. At least one check has no result yet."],
    [
      "maintenance",
      "Overall state: Maintenance. Some checks are in maintenance, the others are up.",
    ],
    ["up", "Overall state: Up. All checks are up."],
  ];
  for (const [state, text] of texts) {
    test(`overall text for ${state}`, () => {
      expect(overviewView(origin, { kind: "ok", checks: [check(state)] }).body).toContain(text);
    });
  }

  test("zero checks is the empty state, not Up", () => {
    const body = overviewView(origin, { kind: "ok", checks: [] }).body;
    expect(body).toContain("<h2>No checks yet</h2>");
    expect(body).toContain(
      "pulse-api has no active checks. Add a check in pulse-api, then reload this page.",
    );
    expect(body).toContain('<a class="button" href="/">Reload</a>');
    expect(body).not.toContain("Overall state");
  });

  test("a failure shows the unavailable state with Retry and no summary", () => {
    const body = overviewView(origin, { kind: "failed", failure: { kind: "timeout" } }).body;
    expect(body).toContain('<h2 class="callout-title">pulse-api cannot be reached</h2>');
    expect(body).toContain("pulse-api did not answer within 5 seconds.");
    expect(body).toContain('<a href="/">Retry</a>');
    expect(body).not.toContain("Overall state");
  });

  test("a rejected token fills the banner and shows no summary", () => {
    const view = overviewView(origin, { kind: "token-rejected" });
    expect(view.banner).toContain(
      '<h2 class="callout-title">pulse-api rejected the console token</h2>',
    );
    expect(view.body).not.toContain("Overall state");
  });

  test("no token is an error callout with its title and no inline style", () => {
    const { body } = overviewView(origin, { kind: "no-token" });
    expect(body).toContain('<section class="callout callout-error" role="alert">');
    expect(body).toContain('<h2 class="callout-title">pulse-api is not available</h2>');
    expect(body).not.toContain("state-error");
    expect(body).not.toContain("style=");
  });

  test("no token shows the no-token text", () => {
    expect(overviewView(origin, { kind: "no-token" }).body).toContain(
      "The console has no pulse-api token. Set PULSE_CONSOLE_ADMIN_TOKEN_FILE and restart the console.",
    );
  });
});
