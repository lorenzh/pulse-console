import { expect, test } from "bun:test";
import {
  alreadySubmittedState,
  apiUnavailableState,
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
  expect(html).toContain('<a href="/">Reload</a>');
  expect(emptyState({ title: "<t>", text: "x", action: { html: "<form></form>" } })).toContain(
    "<h2>&lt;t&gt;</h2>\n<p>x</p>\n<form></form>\n",
  );
});

test("api unavailable state", () => {
  const html = apiUnavailableState({ kind: "timeout" }, "/");
  expect(html).toContain("<h2>pulse-api cannot be reached</h2>");
  expect(html).toContain("<p>pulse-api did not answer within 5 seconds.</p>");
  expect(html).toContain('<a href="/">Retry</a>');
  const invalid = apiUnavailableState({ kind: "network", origin: "https://<x>" }, "/");
  expect(invalid).toContain("pulse-api cannot be reached at https://&lt;x&gt;.");
  expect(apiUnavailableState({ kind: "invalid" }, "/")).toContain(
    "<h2>pulse-api sent an answer the console cannot use</h2>",
  );
});

test("token banner", () => {
  const html = tokenRejectedBanner();
  expect(html).toContain("<h2>pulse-api rejected the console token</h2>");
  expect(html).toContain(
    "<p>Set a valid token in PULSE_CONSOLE_ADMIN_TOKEN or PULSE_CONSOLE_ADMIN_TOKEN_FILE and restart the console.</p>",
  );
});

test("forbidden and not found", () => {
  const html = forbiddenState({ requiredRole: "admin", role: "viewer" });
  expect(html).toContain("<h2>Access denied</h2>");
  expect(html).toContain("<p>This page needs the Admin role or higher. Your role is Viewer.</p>");
  const notFound = notFoundState();
  expect(notFound).toContain("<h2>Page not found</h2>");
  expect(notFound).toContain('<a href="/">Go to the overview</a>');
});

test("stale state for 409 and 412", () => {
  for (const status of [409, 412] as const) {
    const html = staleState({ status, reloadHref: "/x?a=1&b=2" });
    expect(html).toContain("<h2>Changed since you opened it</h2>");
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
  expect(html).toContain("<h2>The checks file is read-only</h2>");
  expect(html).toContain(
    "<p>pulse-api cannot save changes until its checks file is writable. Your input is kept below.</p>",
  );
});

test("already submitted and the expired notices", () => {
  const html = alreadySubmittedState({ reopenHref: "/__test/states/busy" });
  expect(html).toContain("<h2>Already submitted</h2>");
  expect(html).toContain("<p>This form was already sent. Nothing was changed by this request.</p>");
  expect(html).toContain('<a href="/__test/states/busy">Open the page again</a>');
  expect(formExpiredNotice).toBe("This form has expired. Your input is kept below. Send it again.");
  expect(formExpiredResendNotice).toBe("This form has expired. Send it again.");
});
