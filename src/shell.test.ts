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
  expect(html).toContain(
    'Signed in as Owner &lt;Sentinel&gt; <span class="account-email">(o@example.com)</span>',
  );
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
  expect(html).toContain(
    '<main id="main" class="shell-main">\n<div class="page-head"><h1>Overview</h1></div>\n<p>body</p>',
  );
});

test("marks the current entry and has exactly one script element", () => {
  const html = shellPage(view);
  expect(html).toContain('<nav aria-label="Main">');
  expect(html).toContain('<a class="nav-item" href="/" aria-current="page"><svg class="icon"');
  expect(html).toContain("<span>Overview</span></a>");
  expect(html.match(/aria-current="page"/g)?.length).toBe(2);
  expect(html.match(/<script/g)?.length).toBe(1);
  expect(html).toContain('<script src="/console.js" defer></script>');
  expect(html).not.toMatch(/style=|\son[a-z]+=/);
  expect(shellPage({ ...view, current: undefined })).not.toMatch(
    /class="nav-item"[^>]*aria-current/,
  );
});

test("renders the banner slot before main and escapes the title", () => {
  const html = shellPage({ ...view, banner: "<section>b</section>\n", title: "<x>" });
  expect(html).toContain('<div class="banner">\n<section>b</section>\n</div>\n<main');
  expect(html).toContain('<li aria-current="page">&lt;x&gt;</li>');
  expect(html).toContain("<h1>&lt;x&gt;</h1>");
  expect(html).not.toContain("<x>");
  expect(html).toContain("<title>&lt;x&gt; · pulse Console</title>");
});

function avatarOf(name: string, email = "o@example.com"): string | undefined {
  const html = shellPage({ ...view, user: { name, email } });
  return /<span class="avatar" aria-hidden="true">([^<]*)<\/span>/.exec(html)?.[1];
}

test("the avatar shows escaped initials of the first and last word", () => {
  expect(avatarOf("Ada Lovelace")).toBe("AL");
  expect(avatarOf("  ada  ")).toBe("A");
  expect(avatarOf("Jean-Luc Picard Jr")).toBe("JJ");
  expect(avatarOf("", "ops@example.com")).toBe("O");
  expect(avatarOf("", "")).toBe("?");
  const smile = avatarOf("😀 Smile");
  expect(smile).toBe("😀S");
  expect(smile?.isWellFormed()).toBe(true);
  expect(avatarOf("<b>")).toBe("&lt;");
  const hostile = shellPage({ ...view, user: { name: "<b>x", email: "<e>" } });
  expect(hostile).not.toContain("<b>");
  expect(hostile).not.toContain("<e>");
});

test("the Instance group holds the admin entries and only appears for admins", () => {
  const admin = shellPage(view);
  const instance = admin.indexOf("Instance");
  expect(admin).toContain(
    '<p class="eyebrow nav-group" id="nav-instance">Instance</p>\n<ul aria-labelledby="nav-instance">',
  );
  expect(instance).toBeGreaterThan(admin.indexOf("<span>Checks</span>"));
  expect(instance).toBeLessThan(admin.indexOf("<span>Team</span>"));
  expect(admin.indexOf("<span>Tokens</span>")).toBeGreaterThan(instance);
  for (const role of ["viewer", "member"] as const) {
    const html = shellPage({ ...view, role });
    expect(html).not.toContain("Instance");
    expect(html).not.toContain("<span>Team</span>");
    expect(html).toContain("<span>Checks</span>");
  }
});

test("the breadcrumb links the current entry when the title differs", () => {
  const edit = shellPage({ ...view, current: "checks", title: "Edit check" });
  expect(edit).toContain(
    '<nav aria-label="Breadcrumb" class="breadcrumbs"><ol><li><a href="/checks">Checks</a></li><li aria-current="page">Edit check</li></ol></nav>',
  );
  expect(shellPage(view)).toContain('<ol><li aria-current="page">Overview</li></ol>');
  expect(shellPage({ ...view, current: undefined, title: "Page not found" })).toContain(
    '<ol><li aria-current="page">Page not found</li></ol>',
  );
});

test("the shell order: skip link, sidebar, top bar, main", () => {
  const html = shellPage({ ...view, current: "checks", title: "Edit check" });
  const order = [
    'class="skip-link"',
    '<p class="wordmark"><span class="wordmark-name">pulse</span><span class="cursor" aria-hidden="true"></span><span class="pill">self-hosted</span></p>',
    '<nav aria-label="Main">',
    'href="/account/security"',
    'action="/sign-out"',
    'aria-label="Breadcrumb"',
    '<main id="main"',
  ].map((part) => html.indexOf(part));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});
