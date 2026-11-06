import { describe, expect, test } from "bun:test";
import { type AdminCheckView, validateAdminConfigResponse } from "@lorenzh/pulse-contract";
import { escapeHtml } from "@lorenzh/pulse-kit";
import { checkConfig } from "../test/check-fixtures.ts";
import {
  checkEditorHtml,
  createInputOf,
  type EditorModel,
  editInputOf,
  type RetainedInput,
  retainedInputOf,
  storedRowsOf,
} from "./check-editor-page.ts";
import type { CheckType } from "./check-form.ts";

const PROBE_TEXT =
  "Every probe runs this check. It is down when at least two locations report down; with one reporting location, that location decides. Choosing locations or a quorum per check is not available yet.";
const HEARTBEAT_TEXT =
  "Heartbeat checks are not run by probes and have no quorum; your job pings pulse-api. With no ping for longer than the period plus the grace time, the check is down at once.";
const HOST_LINE = String.raw`PULSE_PROBE_HEADER_HOSTS='{"PULSE_HEADER_TOKEN":["a'\'';id;'\''b"]}'`;
const UNSAFE_LINE = `PULSE_PROBE_HEADER_HOSTS='{"PULSE_HEADER_TOKEN":["a';id;'b"]}'`;
const NOT_KEPT = "Not kept for safety: enter it again.";

function viewOf(config: unknown, id: string): AdminCheckView {
  const parsed = validateAdminConfigResponse(config);
  if (!parsed.ok) throw new Error(`fixture is not valid: ${parsed.error}`);
  const view = parsed.value.checks.find((c) => c.id === id);
  if (view === undefined) throw new Error(`no fixture ${id}`);
  return view;
}

const ID_OF: Record<CheckType, string> = {
  http: "web",
  tls: "cert",
  tcp: "db-port",
  dns: "dns-a",
  domain: "domain-exp",
  heartbeat: "nightly-backup",
};
const TYPES: readonly CheckType[] = ["http", "tls", "tcp", "dns", "domain", "heartbeat"];

function createModel(type: CheckType, over: Partial<EditorModel> = {}): EditorModel {
  return {
    type,
    stored: undefined,
    input: createInputOf(type),
    errors: [],
    revision: "rev-1",
    csrf: "csrf-1",
    formToken: "token-1",
    ...over,
  };
}

function editModel(view: AdminCheckView, over: Partial<EditorModel> = {}): EditorModel {
  const stored = storedRowsOf(view);
  return createModel(stored.type, { stored, input: editInputOf(view), ...over });
}

const inputNames = (html: string): string[] =>
  [...html.matchAll(/<(?:input|select|textarea)[^>]*\sname="([^"]*)"/g)].map((m) => m[1] ?? "");

describe("quorum rule above submit", () => {
  for (const type of TYPES) {
    const view = viewOf(checkConfig, ID_OF[type]);
    for (const [mode, html] of [
      ["create", checkEditorHtml(createModel(type))],
      ["edit", checkEditorHtml(editModel(view))],
    ] as const) {
      test(`${type} ${mode}`, () => {
        const expected = type === "heartbeat" ? HEARTBEAT_TEXT : PROBE_TEXT;
        const other = type === "heartbeat" ? PROBE_TEXT : HEARTBEAT_TEXT;
        const at = html.indexOf(expected);
        expect(at).toBeGreaterThan(-1);
        expect(at).toBeLessThan(html.indexOf('<button type="submit"'));
        expect(html).not.toContain(other);
        for (const name of inputNames(html)) {
          expect(name.toLowerCase()).not.toContain("quorum");
          expect(name.toLowerCase()).not.toContain("location");
        }
      });
    }
  }
});

describe("create form", () => {
  test("fields carry their widths and the submit sits in an actions row", () => {
    const http = checkEditorHtml(createModel("http"));
    expect(http).toContain('<input id="field-name" class="input-medium" name="name"');
    expect(http).toContain('<input id="field-interval_ms" class="input-narrow" name="interval_ms"');
    expect(http).toContain('<input id="field-timeout_ms" class="input-narrow" name="timeout_ms"');
    expect(http).toContain('<input id="field-retries" class="input-narrow" name="retries"');
    expect(http).toContain(
      '<input id="field-availability_target" class="input-narrow" name="availability_target"',
    );
    expect(http).toContain('<select id="field-method" class="input-narrow" name="method"');
    expect(http).toContain(
      '<input id="field-header_0_name" class="input-medium" name="header_0_name"',
    );
    expect(http).toContain('<input id="field-url" name="url" type="url"');
    expect(http).toContain(
      '<div class="actions"><button type="submit" data-busy-label="Saving…">Create check</button></div>\n</form>',
    );
    const dns = checkEditorHtml(createModel("dns"));
    expect(dns).toContain('<select id="field-record_type" class="input-narrow" name="record_type"');
    expect(checkEditorHtml(createModel("tcp"))).toContain(
      '<input id="field-port" class="input-narrow" name="port"',
    );
    expect(checkEditorHtml(createModel("tls"))).toContain(
      '<input id="field-warn_days" class="input-narrow" name="warn_days"',
    );
  });

  test("http has 20 header rows, 10 assertion rows, 5 visible header rows and ms labels", () => {
    const html = checkEditorHtml(createModel("http"));
    for (let i = 0; i < 20; i++) expect(html).toContain(`name="header_${i}_name"`);
    expect(html).not.toContain('name="header_20_name"');
    for (let i = 0; i < 10; i++) expect(html).toContain(`name="assert_${i}_mode"`);
    expect(html).not.toContain('name="assert_10_mode"');
    const [visible = ""] = html.split("<summary>More rows</summary>");
    expect(visible).toContain('name="header_4_name"');
    expect(visible).not.toContain('name="header_5_name"');
    expect(html).toContain("Interval (ms)");
    expect(html).toContain("Retry delay (ms)");
    expect(html).toContain('<input type="hidden" name="type" value="http">');
    expect(html).toContain('<input id="field-id" class="input-medium" name="id"');
    expect(html).toContain("<option selected>GET</option>");
    expect(html).toContain(
      '<input type="hidden" name="csrf" value="csrf-1">\n<input type="hidden" name="form_token" value="token-1">',
    );
    expect(html).toContain('action="/checks/new?type=http"');
  });

  test("heartbeat secret is a new-password input with no interval or retries", () => {
    const html = checkEditorHtml(createModel("heartbeat"));
    expect(html).toContain(
      '<input id="field-secret" name="secret" type="password" required autocomplete="new-password">',
    );
    expect(html).not.toContain('name="interval_ms"');
    expect(html).not.toContain('name="retries"');
    expect(html).toContain(
      'name="grace_ms" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" value="0"',
    );
  });

  test("tls shows the expiry note and defaults; domain the interval default", () => {
    const tls = checkEditorHtml(createModel("tls"));
    expect(tls).toContain(
      "This check judges the certificate&#39;s expiry date only. It does not verify the certificate chain or the host name.",
    );
    expect(tls).toContain(
      'name="port" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" value="443"',
    );
    const domain = checkEditorHtml(createModel("domain"));
    expect(domain).toContain('required autocomplete="off" value="86400000"');
    expect(domain).toContain('value="30"');
  });

  test("errors link to their fields and values are escaped", () => {
    const html = checkEditorHtml(
      createModel("http", {
        input: { values: { name: `<b>"x"</b>` }, dropped: new Set() },
        errors: [{ field: "interval_ms", message: "Enter a whole number of ms." }],
      }),
    );
    expect(html).toContain('<li><a href="#field-interval_ms">Enter a whole number of ms.</a></li>');
    expect(html).toContain(
      'aria-describedby="field-interval_ms-error" aria-invalid="true">\n<span class="error" id="field-interval_ms-error">Enter a whole number of ms.</span>',
    );
    expect(html).toContain('value="&lt;b&gt;&quot;x&quot;&lt;/b&gt;"');
    expect(html).not.toContain("<b>");
  });
});

describe("edit form uses the trusted view", () => {
  const web = viewOf(checkConfig, "web");

  test("id and type are fixed; stored literal row is text, env row follows it", () => {
    const html = checkEditorHtml(editModel(web));
    expect(html).not.toContain('name="id"');
    expect(html).not.toContain('name="type"');
    expect(html).toContain("<p>Id: <code>web</code></p>");
    expect(html).toContain("<p>Type: HTTP</p>");
    expect(html).not.toContain('name="header_0_name"');
    expect(html).not.toContain('name="header_0_kind"');
    expect(html).toContain("<legend>Header X-Api-Key</legend>\n<p>Value: set</p>");
    expect(html).toContain(
      '<label class="choice"><input type="radio" name="header_0_intent" value="keep" checked><span>Keep</span></label>',
    );
    expect(html).toContain(
      'name="header_1_name" type="text" autocomplete="off" value="Authorization"',
    );
    expect(html).toContain(
      'name="header_1_value" type="text" autocomplete="off" value="PULSE_HEADER_TOKEN"',
    );
    expect(html).toContain('<input type="radio" name="header_1_kind" value="env" checked>');
    expect(html).toContain("<p>Body: set</p>");
    expect(html).toContain(
      '<label class="choice"><input type="radio" name="body_intent" value="keep" checked><span>Keep</span></label>',
    );
    expect(html).toContain('action="/checks/edit?id=web"');
  });

  test("the host-binding line is the escaped literal, selectable and copyable", () => {
    const html = checkEditorHtml(editModel(web));
    expect(html).toContain(
      `<pre id="editor-host-binding-line">${escapeHtml(HOST_LINE)}</pre>\n<button type="button" class="secondary small" data-copy="editor-host-binding-line" hidden>Copy</button>`,
    );
    expect(html).not.toContain(UNSAFE_LINE);
    expect(html).not.toContain(escapeHtml(UNSAFE_LINE));
    expect(html).toContain(
      "Merge this into the value that each probe already has, and set PULSE_HEADER_TOKEN in the probe environment.",
    );
    expect(html).not.toMatch(/<script|<style|style=|onclick=/);
  });

  test("visible header rows are max(existing + 3, 5)", () => {
    const headers = {
      A: { keep: true },
      B: { keep: true },
      C: { env: "PULSE_HEADER_C" },
      D: { env: "PULSE_HEADER_D" },
    };
    const config = { ...checkConfig, checks: [{ ...checkConfig.checks[0], headers }] };
    const html = checkEditorHtml(editModel(viewOf(config, "web")));
    const [visible = ""] = html.split("<summary>More rows</summary>");
    expect(visible).toContain('name="header_6_name"');
    expect(visible).not.toContain('name="header_7_name"');
    expect(visible).toContain(
      'name="header_3_value" type="text" autocomplete="off" value="PULSE_HEADER_D"',
    );
  });

  test("heartbeat edit shows Secret: set with keep and replace, not required", () => {
    const html = checkEditorHtml(editModel(viewOf(checkConfig, "nightly-backup")));
    expect(html).toContain("<p>Secret: set</p>");
    expect(html).toContain(
      '<label class="choice"><input type="radio" name="secret_intent" value="keep" checked><span>Keep</span></label>',
    );
    expect(html).toContain(
      '<label class="choice"><input type="radio" name="secret_intent" value="replace"><span>Replace</span></label>',
    );
    const radios = html.match(/<input type="radio"[^>]*>/g) ?? [];
    expect(radios.length).toBeGreaterThan(0);
    expect(html.split('<label class="choice"><input type="radio"').length - 1).toBe(radios.length);
    expect(html.match(/<input type="radio"[^>]*><span>/g) ?? []).toHaveLength(radios.length);
    expect(html).not.toContain('name="secret_intent" value="remove"');
    expect(html).toContain(
      '<input id="field-secret" name="secret" type="password" autocomplete="new-password">',
    );
    expect(html).toContain('value="86400000"');
    expect(html).toContain('value="3600000"');
  });
});

describe("a failed form keeps no write-only value", () => {
  const web = viewOf(checkConfig, "web");
  const posted = {
    name: "Web shop 2",
    url: "https://a';id;'b/",
    secret: "SENTINEL-SECRET-abcdefghij",
    body: "SENTINEL-BODY",
    body_intent: "replace",
    header_0_intent: "replace",
    header_0_value: "SENTINEL-STORED",
    header_1_name: "Authorization",
    header_1_kind: "env",
    header_1_value: "PULSE_HEADER_TOKEN",
    header_2_name: "X-Plain",
    header_2_kind: "plain",
    header_2_value: "SENTINEL-LITERAL",
    header_3_name: "X-Forged",
    header_3_value: "SENTINEL-NOKIND",
    __proto__: "ignored",
  };
  const sentinels = [
    "SENTINEL-SECRET-abcdefghij",
    "SENTINEL-BODY",
    "SENTINEL-STORED",
    "SENTINEL-LITERAL",
    "SENTINEL-NOKIND",
  ];

  test("the retained model drops them and keeps the rest", () => {
    const input: RetainedInput = retainedInputOf(posted, storedRowsOf(web));
    expect(input.values).toEqual({
      name: "Web shop 2",
      url: "https://a';id;'b/",
      body_intent: "replace",
      header_0_intent: "replace",
      header_1_name: "Authorization",
      header_1_kind: "env",
      header_1_value: "PULSE_HEADER_TOKEN",
      header_2_name: "X-Plain",
      header_2_kind: "plain",
      header_3_name: "X-Forged",
    });
    expect([...input.dropped].sort((a, b) => a.localeCompare(b))).toEqual([
      "body",
      "header_0_value",
      "header_2_value",
      "header_3_value",
      "secret",
    ]);
  });

  test("the edit and create HTML show the not-kept text and no sentinel", () => {
    const stored = storedRowsOf(web);
    const edit = checkEditorHtml(
      editModel(web, {
        input: retainedInputOf(posted, stored),
        errors: [{ field: "name", message: "x" }],
      }),
    );
    const create = checkEditorHtml(
      createModel("heartbeat", { input: retainedInputOf(posted, undefined) }),
    );
    for (const html of [edit, create]) {
      expect(html).toContain(NOT_KEPT);
      for (const sentinel of sentinels) expect(html).not.toContain(sentinel);
    }
    expect(edit).toContain('<input type="radio" name="header_0_intent" value="replace" checked>');
    expect(edit).toContain(`<pre id="editor-host-binding-line">${escapeHtml(HOST_LINE)}</pre>`);
  });
});
