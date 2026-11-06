import { expect, test } from "bun:test";
import {
  documentHead,
  field,
  formErrorSummary,
  formTokenField,
  plainDocument,
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
  expect(submitButton({ label: "A", busyLabel: "B" })).toBe(
    '<button type="submit" data-busy-label="B">A</button>',
  );
  expect(submitButton({ label: "A", busyLabel: "B", variant: "primary" })).toBe(
    '<button type="submit" data-busy-label="B">A</button>',
  );
  expect(submitButton({ label: "A", busyLabel: "B", variant: "secondary" })).toBe(
    '<button type="submit" class="secondary" data-busy-label="B">A</button>',
  );
});

test("submitButton renders the ghost and danger variants as classes", () => {
  expect(submitButton({ label: "A", busyLabel: "B", variant: "ghost" })).toBe(
    '<button type="submit" class="ghost" data-busy-label="B">A</button>',
  );
  expect(submitButton({ label: "Remove", busyLabel: "Removing…", variant: "danger" })).toBe(
    '<button type="submit" class="danger" data-busy-label="Removing…">Remove</button>',
  );
});

test("plainDocument has the wordmark, one h1 in the plain panel and no script", () => {
  const html = plainDocument("Sign <in>", "<p>body</p>");
  expect(html).toContain('<body class="plain">');
  expect(html).toContain(
    '<header class="plain-head"><p class="wordmark"><span class="wordmark-name">pulse</span><span class="cursor" aria-hidden="true"></span><span class="pill">self-hosted</span></p></header>',
  );
  expect(html).toContain(
    '<main class="plain-main"><div class="panel plain-panel">\n<h1>Sign &lt;in&gt;</h1>\n<p>body</p>\n</div></main>',
  );
  expect(html.match(/<h1/g)?.length).toBe(1);
  expect(html).not.toContain("<script");
  expect(html).not.toMatch(/style=|<style/);
  expect(html).toContain("<title>Sign &lt;in&gt; · pulse Console</title>");
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

test("a field width adds its class to the input only", () => {
  const base = { label: "Name", name: "name", type: "text", autocomplete: "off" } as const;
  expect(field({ ...base, width: "medium" })).toContain(
    '<input id="field-name" class="input-medium" name="name" type="text"',
  );
  expect(field({ ...base, width: "narrow" })).toContain(
    '<input id="field-name" class="input-narrow"',
  );
  expect(field(base)).toContain('<input id="field-name" name="name"');
  expect(field({ ...base, width: "medium" })).toContain('<label for="field-name">Name\n<input');
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
  expect(html).toStartWith('<section class="callout callout-error" role="alert">');
  expect(html).toContain('<h2 class="callout-title">There is a problem</h2>');
  expect(html).not.toMatch(/style=|<style/);
});
