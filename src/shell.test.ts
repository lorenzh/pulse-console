import { expect, test } from "bun:test";
import { type ShellView, shellPage } from "./shell.ts";

const view: ShellView = {
  instanceName: "pulse Console",
  user: { name: "Owner <Sentinel>", email: "o@example.com" },
  role: "admin",
  csrf: "csrf-value",
  signOutToken: "form-token-value",
  current: "overview",
  title: "Overview",
  body: "<p>body</p>",
};

test("renders the instance, account, role and sign-out form", () => {
  const html = shellPage(view);
  expect(html).toContain("pulse Console");
  expect(html).toContain("Signed in as Owner &lt;Sentinel&gt; (o@example.com)");
  expect(html).toContain("Role: Admin");
  expect(html).toContain('<form method="post" action="/sign-out" class="sign-out">');
  expect(html).toContain(
    '<input type="hidden" name="csrf" value="csrf-value">\n<input type="hidden" name="form_token" value="form-token-value">',
  );
  expect(html).toContain('data-busy-label="Signing out…">Sign out</button>');
  expect(html).not.toContain("disabled");
});

test("the skip link is the first focusable element", () => {
  const html = shellPage(view);
  const body = html.slice(html.indexOf("<body>"));
  const first = /<(a|button|input|select|textarea)\b[^>]*>/.exec(body);
  expect(first?.[0]).toBe('<a class="skip-link" href="#main">');
  expect(body).toContain("Skip to content</a>");
  expect(html).toContain('<main id="main" class="shell-main">\n<h1>Overview</h1>\n<p>body</p>');
});

test("marks the current entry and has exactly one script element", () => {
  const html = shellPage(view);
  expect(html).toContain('<nav aria-label="Main">');
  expect(html).toContain('<a href="/" aria-current="page">Overview</a>');
  expect(html.match(/<script/g)?.length).toBe(1);
  expect(html).toContain('<script src="/console.js" defer></script>');
  expect(html).not.toMatch(/style=|\son[a-z]+=/);
  expect(shellPage({ ...view, current: undefined })).not.toContain("aria-current");
});

test("renders the banner slot before main and escapes the title", () => {
  const html = shellPage({ ...view, banner: "<section>b</section>\n", title: "<x>" });
  expect(html).toContain('<div class="banner">\n<section>b</section>\n</div>\n<main');
  expect(html).toContain("<h1>&lt;x&gt;</h1>");
  expect(html).toContain("<title>&lt;x&gt; · pulse Console</title>");
});
