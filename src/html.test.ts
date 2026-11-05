import { expect, test } from "bun:test";
import {
  documentHead,
  field,
  formErrorSummary,
  formTokenField,
  submitButton,
  textareaField,
} from "./html.ts";

test("the head has a script element only with the flag", () => {
  const plain = documentHead({ title: "T", instanceName: "pulse Console", hasScript: false });
  expect(plain).not.toContain("<script");
  const shell = documentHead({ title: "T", instanceName: "pulse Console", hasScript: true });
  expect(shell).toContain(
    '    <link rel="stylesheet" href="/console.css">\n    <script src="/console.js" defer></script>\n  </head>',
  );
});

test("submitButton starts enabled and carries the busy label", () => {
  expect(submitButton({ label: "Run", busyLabel: "Running…", name: "action", value: "go" })).toBe(
    '<button type="submit" name="action" value="go" data-busy-label="Running…">Run</button>',
  );
  expect(submitButton({ label: "<a>", busyLabel: '"b"', variant: "secondary" })).toBe(
    '<button type="submit" class="secondary" data-busy-label="&quot;b&quot;">&lt;a&gt;</button>',
  );
});

test("formTokenField escapes its value", () => {
  expect(formTokenField('a"b')).toBe('<input type="hidden" name="form_token" value="a&quot;b">');
});

test("field errors have labels, aria-invalid and aria-describedby", () => {
  const html = field({
    label: "Name",
    name: "name",
    type: "text",
    autocomplete: "off",
    value: "<v>",
    error: "Too <long>",
  });
  expect(html).toContain('<label for="field-name">Name');
  expect(html).toContain(
    'value="&lt;v&gt;" aria-describedby="field-name-error" aria-invalid="true"',
  );
  expect(html).toContain('<span class="error" id="field-name-error">Too &lt;long&gt;</span>');
});

test("textarea fields keep the value and show errors", () => {
  const html = textareaField({ label: "Note", name: "note", value: "</textarea>", error: "Bad" });
  expect(html).toContain('<label for="field-note">Note');
  expect(html).toContain(
    '<textarea id="field-note" name="note" rows="4" aria-describedby="field-note-error" aria-invalid="true">&lt;/textarea&gt;</textarea>',
  );
  expect(html).toContain('<span class="error" id="field-note-error">Bad</span>');
  expect(textareaField({ label: "Note", name: "note" })).not.toContain("aria-invalid");
});

test("formErrorSummary links each field", () => {
  expect(formErrorSummary([])).toBe("");
  const html = formErrorSummary([
    { name: "name", text: "Enter a <name>." },
    { name: "note", text: "Too long." },
  ]);
  expect(html).toContain('<a href="#field-name">Enter a &lt;name&gt;.</a>');
  expect(html).toContain('<a href="#field-note">Too long.</a>');
  expect(html).toContain('role="alert"');
});
