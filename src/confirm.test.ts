import { describe, expect, test } from "bun:test";
import {
  isTypedNameConfirmed,
  plainConfirmPage,
  typedConfirmPage,
  typedNameError,
} from "./confirm.ts";

const BASE = {
  consequence: "The check <b> is deleted.",
  action: "/x/delete",
  csrf: "csrf-1",
  formToken: "token-1",
  revision: "rev-1",
  submitLabel: "Delete check",
  busyLabel: "Deleting…",
  cancelHref: "/checks",
};

describe("isTypedNameConfirmed", () => {
  const rows: Array<[string, string, boolean]> = [
    ["api", "api", true],
    [" api ", "api", true],
    ["API", "api", false],
    ["my check", "my  check", false],
    ["", "api", false],
    ["Café", "Café", true],
    ["Café", "Café", true],
    ["Checkout API", " Checkout API ", true],
    [" Checkout API ", " Checkout API ", true],
    ["Checkout  API", " Checkout API ", false],
    ["checkout api", " Checkout API ", false],
  ];
  for (const [typed, expected, result] of rows) {
    test(`${JSON.stringify(typed)} against ${JSON.stringify(expected)} is ${result}`, () => {
      expect(isTypedNameConfirmed(typed, expected)).toBe(result);
    });
  }
});

describe("typedNameError", () => {
  test("blank, mismatch and match", () => {
    expect(typedNameError("   ", "api")).toBe("Type the name to confirm.");
    expect(typedNameError("API", "api")).toBe("The name does not match. Type api exactly.");
    expect(typedNameError(" api", "api")).toBeUndefined();
    expect(typedNameError("x", " Checkout API ")).toBe(
      "The name does not match. Type Checkout API exactly.",
    );
  });
});

describe("typedConfirmPage", () => {
  test("renders the target, the labelled field, hidden fields in order and Cancel", () => {
    const html = typedConfirmPage({ ...BASE, targetName: "Checkout <API>" });
    expect(html).toContain('<p class="confirm-title">The check &lt;b&gt; is deleted.</p>');
    expect(html).toContain('<p class="confirm-target mono">Checkout &lt;API&gt;</p>');
    expect(html).toContain('<label for="field-confirm_name">Type Checkout &lt;API&gt; to confirm');
    expect(html).toContain(
      '<input type="hidden" name="csrf" value="csrf-1">\n<input type="hidden" name="form_token" value="token-1">\n<input type="hidden" name="revision" value="rev-1">',
    );
    expect(html).toContain(
      '<form method="post" action="/x/delete" class="panel confirm confirm-danger">',
    );
    expect(html).toContain(
      '<div class="panel-foot"><a class="button ghost cancel" href="/checks">Cancel</a> <button type="submit" class="danger" data-busy-label="Deleting…">Delete check</button></div>',
    );
    expect(html).not.toContain("<h2");
    expect(html).not.toContain("error-summary");
  });

  test("keeps the typed value and shows the error with a summary", () => {
    const html = typedConfirmPage({
      ...BASE,
      targetName: "api",
      typed: "API<",
      error: "The name does not match. Type api exactly.",
      notice: "Expired.",
    });
    expect(html).toContain('<section class="callout callout-warning" role="alert">');
    expect(html).toContain("<p>Expired.</p>");
    expect(html).toContain('value="API&lt;"');
    expect(html).toContain(
      '<li><a href="#field-confirm_name">The name does not match. Type api exactly.</a></li>',
    );
    expect(html).toContain('aria-describedby="field-confirm_name-error" aria-invalid="true"');
  });
});

describe("plainConfirmPage", () => {
  test("renders consequence, hidden fields, submit and Cancel without a name field", () => {
    const html = plainConfirmPage({ ...BASE, tone: "danger", hidden: [["kind", "x"]] });
    expect(html).toContain('<p class="confirm-title">The check &lt;b&gt; is deleted.</p>');
    expect(html).toContain(
      '<input type="hidden" name="csrf" value="csrf-1">\n<input type="hidden" name="form_token" value="token-1">\n<input type="hidden" name="revision" value="rev-1">\n<input type="hidden" name="kind" value="x">\n<div class="panel-body">',
    );
    expect(html).toContain('class="panel confirm confirm-danger"');
    expect(html).toContain(
      '<a class="button ghost cancel" href="/checks">Cancel</a> <button type="submit" class="danger"',
    );
    expect(html).not.toContain("confirm_name");
  });

  test("a safe confirmation has a primary submit and no danger class", () => {
    const html = plainConfirmPage({ ...BASE, tone: "safe", submitLabel: "Resolve incident" });
    expect(html).toContain('class="panel confirm confirm-safe"');
    expect(html).not.toContain("danger");
    expect(html).toContain(
      '<a class="button ghost cancel" href="/checks">Cancel</a> <button type="submit" data-busy-label="Deleting…">Resolve incident</button>',
    );
  });
});
