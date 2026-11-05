import { expect, test } from "bun:test";
import type { ApiFailure } from "./api-failure.ts";
import {
  alreadySubmittedState,
  apiUnavailableState,
  callout,
  emptyState,
  forbiddenState,
  formExpiredNotice,
  formExpiredResendNotice,
  notFoundState,
  readOnlyState,
  staleState,
  tokenRejectedBanner,
} from "./states.ts";

test("empty state with a link or a form action", () => {
  const html = emptyState({
    title: "No checks yet",
    text: "pulse-api has no active checks. Add a check in pulse-api, then reload this page.",
    action: { href: "/", label: "Reload" },
  });
  expect(html).toContain("<h2>No checks yet</h2>");
  expect(html).toContain(
    "<p>pulse-api has no active checks. Add a check in pulse-api, then reload this page.</p>",
  );
  expect(html).toContain('<section class="empty-state">');
  expect(html).toContain('<a class="button" href="/">Reload</a>');
  expect(emptyState({ title: "<t>", text: "x", action: { html: "<form></form>" } })).toContain(
    "<h2>&lt;t&gt;</h2>\n<p>x</p>\n<form></form>\n",
  );
});

test("empty state without an action renders no link", () => {
  const html = emptyState({ title: "No checks", text: "Nothing here." });
  expect(html).toBe(
    '<section class="empty-state">\n<h2>No checks</h2>\n<p>Nothing here.</p>\n</section>\n',
  );
  expect(html).not.toContain("<a");
});

test("callout renders kind, role, id, title, body and action", () => {
  const html = callout({
    kind: "success",
    title: "<T>",
    body: "<p>b</p>\n",
    id: "connection-result",
    role: "status",
    action: { href: "/x?a=1&b=2", label: "<Go>" },
  });
  expect(html).toStartWith(
    '<section class="callout callout-success" role="status" id="connection-result">\n<svg class="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"',
  );
  expect(html).toContain(
    '<div class="callout-body">\n<h2 class="callout-title">&lt;T&gt;</h2>\n<p>b</p>\n<a class="button secondary small" href="/x?a=1&amp;b=2">&lt;Go&gt;</a>\n</div>\n</section>\n',
  );
  for (const kind of ["info", "success", "warning", "error", "neutral"] as const) {
    const plain = callout({ kind, body: "<p>x</p>" });
    expect(plain).toStartWith(`<section class="callout callout-${kind}">\n<svg class="icon"`);
    expect(plain).not.toContain("<h2");
    expect(plain).not.toMatch(/style=|<style/);
  }
});

test("api unavailable state", () => {
  const html = apiUnavailableState({ kind: "timeout" }, "/");
  expect(html).toContain('<section class="callout callout-error" role="alert">');
  expect(html).toContain('<h2 class="callout-title">pulse-api cannot be reached</h2>');
  expect(html).toContain("<p>pulse-api did not answer within 5 seconds.</p>");
  expect(html).toContain('<a href="/">Retry</a>');
  const invalid = apiUnavailableState({ kind: "network", origin: "https://<x>" }, "/");
  expect(invalid).toContain("pulse-api cannot be reached at https://&lt;x&gt;.");
  expect(apiUnavailableState({ kind: "invalid" }, "/")).toContain(
    '<h2 class="callout-title">pulse-api sent an answer the console cannot use</h2>',
  );
});

test("api unavailable state names the kind before the detail", () => {
  const rows: Array<[ApiFailure, string, string]> = [
    [{ kind: "timeout" }, "Kind: timeout", "pulse-api did not answer within 5 seconds."],
    [
      { kind: "refused", origin: "http://127.0.0.1:9" },
      "Kind: connection refused",
      "The connection to http://127.0.0.1:9 was refused. Check that pulse-api is running at this address.",
    ],
    [
      { kind: "network", origin: "http://127.0.0.1:9" },
      "Kind: network error",
      "pulse-api cannot be reached at http://127.0.0.1:9.",
    ],
    [{ kind: "http", call: "checks", status: 503 }, "Kind: status 503", "pulse-api answered 503."],
  ];
  for (const [failure, kind, detail] of rows) {
    expect(apiUnavailableState(failure, "/")).toContain(
      `<h2 class="callout-title">pulse-api cannot be reached</h2>\n<p>${kind}</p>\n<p>${detail}</p>\n`,
    );
  }
  for (const failure of [
    { kind: "invalid" },
    { kind: "missing-header" },
    { kind: "wire-mismatch", label: "2" },
  ] satisfies ApiFailure[]) {
    expect(apiUnavailableState(failure, "/")).not.toContain("Kind:");
  }
});

test("token banner", () => {
  const html = tokenRejectedBanner();
  expect(html).toContain('<section class="callout callout-error" role="alert">');
  expect(html).toContain('<h2 class="callout-title">pulse-api rejected the console token</h2>');
  expect(html).toContain(
    "<p>Set a valid token in PULSE_CONSOLE_ADMIN_TOKEN or PULSE_CONSOLE_ADMIN_TOKEN_FILE and restart the console.</p>",
  );
});

test("forbidden and not found", () => {
  const html = forbiddenState({ requiredRole: "admin", role: "viewer" });
  expect(html).not.toContain("<h2");
  expect(html).not.toContain("Access denied");
  expect(html).toContain('<section class="callout callout-warning">');
  expect(html).toContain("<p>This page needs the Admin role or higher. Your role is Viewer.</p>");
  expect(html).toContain('<a href="/">Go to the overview</a>');
  const notFound = notFoundState();
  expect(notFound).not.toContain("Page not found");
  expect(notFound).not.toContain("<h2");
  expect(notFound).toContain('<section class="callout callout-neutral">');
  expect(notFound).toContain(
    '<p>There is no page at this address; go to the overview.</p>\n<p><a href="/">Go to the overview</a></p>\n',
  );
  expect(notFound).toContain('<a href="/">Go to the overview</a>');
});

test("forbidden state of a target denial has a fixed text", () => {
  const role = forbiddenState({ requiredRole: "owner", role: "admin" });
  expect(role).toContain(
    '<div class="callout-body">\n<p>This page needs the Owner role or higher. Your role is Admin.</p>\n<p><a href="/">Go to the overview</a></p>\n</div>\n</section>\n',
  );
  expect(forbiddenState({ target: "owner-target" })).toContain(
    "<p>No one can change the owner account in the console.</p>",
  );
  expect(forbiddenState({ target: "transfer-not-admin" })).toContain(
    "<p>Only an admin can become the owner.</p>",
  );
});

test("stale state for 409 and 412", () => {
  for (const status of [409, 412] as const) {
    const html = staleState({ status, reloadHref: "/x?a=1&b=2" });
    expect(html).toContain('<section class="callout callout-warning" role="alert">');
    expect(html).toContain('<h2 class="callout-title">Changed since you opened it</h2>');
    expect(html).toContain(
      "<p>Someone changed this since you opened it. Your input is kept below. Reload to see the current version, then apply your change again.</p>",
    );
    expect(html).toContain('<a href="/x?a=1&amp;b=2">Reload</a>');
  }
  expect(staleState({ status: 409, detail: "A <dup> name.", reloadHref: "/" })).toContain(
    "<p>A &lt;dup&gt; name.</p>",
  );
});

test("read-only state", () => {
  const html = readOnlyState();
  expect(html).toContain('<section class="callout callout-error" role="alert">');
  expect(html).toContain('<h2 class="callout-title">The checks file is read-only</h2>');
  expect(html).toContain(
    "<p>pulse-api cannot save changes until its checks file is writable. Your input is kept below.</p>",
  );
});

test("already submitted and the expired notices", () => {
  const html = alreadySubmittedState({ reopenHref: "/__test/states/busy" });
  expect(html).toContain('<section class="callout callout-warning">');
  expect(html).toContain('<h2 class="callout-title">Already submitted</h2>');
  expect(html).toContain("<p>This form was already sent. Nothing was changed by this request.</p>");
  expect(html).toContain('<a href="/__test/states/busy">Open the page again</a>');
  expect(formExpiredNotice).toBe("This form has expired. Your input is kept below. Send it again.");
  expect(formExpiredResendNotice).toBe("This form has expired. Send it again.");
});
