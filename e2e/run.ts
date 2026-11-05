// Browser checks of the console in Chromium: layout at 390 px and 1280 px, axe, keyboard focus,
// CSP and the busy button with and without JavaScript. `bun e2e/run.ts --serve` only starts the
// fixture console for a manual check and runs until stopped.
import { randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import type { ConsoleRole } from "../src/roles.ts";
import {
  checkConfig,
  checkExport,
  checkStates,
  checkUptime,
  webLatency,
  webLocationUptime,
  webResults,
  webState,
} from "../test/check-fixtures.ts";
import { checkWithState, emptyConfig, jsonReply, startFakeApi } from "../test/fake-api.ts";
import {
  type ConfirmTargetHolder,
  createFixtureRoutes,
  type Recorder,
} from "../test/fixture-routes.ts";
import {
  OWNER_PASSWORD,
  type SignedInConsole,
  startSignedInConsole,
} from "../test/signed-in-console.ts";

class CheckError extends Error {
  override name = "CheckError";
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new CheckError(message);
}

function ok(message: string): void {
  console.log(`ok: ${message}`);
}

const ADMIN_TOKEN = `e2e-admin-token-${randomBytes(12).toString("hex")}`;
const LONG_NAME = `Checkout-API-${"very-long-unbroken-name-".repeat(8)}end`;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const SERVE_WAIT_MS = 3000;
const DEMO_EMAIL = "demo-owner@example.com";
const LINK_COLOUR = "rgb(27, 79, 156)";

type Env = {
  ownerEmail: string;
  console: SignedInConsole;
  api: ReturnType<typeof startFakeApi>;
  recorder: Recorder;
  target: ConfirmTargetHolder;
  role: { current: ConsoleRole };
  hold: { current: Promise<void> | undefined };
  /** When set, every pulse-api read goes to this closed loopback origin. */
  refuse: { current: string | undefined };
  /** When true, the 5000 ms read deadline fires after a real 100 ms. */
  fastDeadline: { current: boolean };
};

const FAST_DEADLINE_MS = 100;

async function startEnv(waitMs: number, ownerEmail = DEMO_EMAIL): Promise<Env> {
  const api = startFakeApi();
  api.reply("/admin/config", jsonReply(emptyConfig));
  api.reply("/checks", jsonReply([checkWithState("web", "up")]));
  const recorder: Recorder = { actions: [] };
  const target: ConfirmTargetHolder = { current: { name: "Checkout API", revision: "rev-1" } };
  const role: { current: ConsoleRole } = { current: "owner" };
  const hold: { current: Promise<void> | undefined } = { current: undefined };
  const wait = (): Promise<void> => {
    if (hold.current !== undefined) return hold.current;
    return waitMs > 0 ? new Promise((resolve) => setTimeout(resolve, waitMs)) : Promise.resolve();
  };
  const refuse: { current: string | undefined } = { current: undefined };
  const fastDeadline = { current: false };
  const server = await startSignedInConsole({
    apiUrl: api.url,
    ownerEmail,
    adminToken: ADMIN_TOKEN,
    testRoutes: createFixtureRoutes({ recorder, target, wait }),
    roleOf: () => role.current,
    fetch: Object.assign(
      (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const closed = refuse.current;
        if (closed === undefined) return fetch(input, init);
        const url = new URL(input instanceof Request ? input.url : String(input));
        return fetch(`${closed}${url.pathname}`, init);
      },
      { preconnect: fetch.preconnect },
    ),
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, fastDeadline.current && ms === 5000 ? FAST_DEADLINE_MS : ms);
      return () => clearTimeout(timer);
    },
  });
  return { ownerEmail, console: server, api, recorder, target, role, hold, refuse, fastDeadline };
}

async function signIn(page: Page, env: Env): Promise<void> {
  const base = env.console.base;
  await page.goto(`${base}/sign-in`);
  await page.fill('input[name="email"]', env.ownerEmail);
  await page.fill('input[name="password"]', OWNER_PASSWORD);
  await Promise.all([
    page.waitForURL(`${base}/sign-in/factor`),
    page.click('button[type="submit"]'),
  ]);
  await page.fill('input[name="recovery_code"]', env.console.recoveryCodes.shift() ?? "");
  await Promise.all([
    page.waitForURL(`${base}/`),
    page.getByRole("button", { name: "Use recovery code" }).click(),
  ]);
  assert((await page.content()).includes("Signed in as"), "sign-in reaches the shell");
}

/** Collects CSP violations reported on the browser console of every page of a context. */
function watchCsp(context: BrowserContext, violations: string[]): void {
  context.on("page", (page) => watchPageCsp(page, violations));
}

function watchPageCsp(page: Page, violations: string[]): void {
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Content Security Policy|Refused to/i.test(text)) violations.push(text);
  });
}

async function newPage(context: BrowserContext, violations: string[]): Promise<Page> {
  const page = await context.newPage();
  watchPageCsp(page, violations);
  return page;
}

const FIXTURE_PAGES = [
  "/__test/states/empty",
  "/__test/states/busy",
  "/__test/states/already-submitted",
  "/__test/states/api-timeout",
  "/__test/states/api-refused",
  "/__test/states/api-network",
  "/__test/states/api-status",
  "/__test/states/token-rejected",
  "/__test/states/not-found",
  "/__test/states/conflict-409",
  "/__test/states/conflict-412",
  "/__test/states/invalid-422",
  "/__test/states/read-only-503",
  "/__test/confirm/typed/delete-check",
  "/__test/confirm/plain/resolve-incident",
  "/__test/confirm/done",
  "/does-not-exist",
];

type OverviewCase = { name: string; apply: (env: Env) => void };

const OVERVIEW_CASES: OverviewCase[] = [
  {
    name: "Overview success",
    apply: (env) => {
      env.api.reply("/admin/config", jsonReply(emptyConfig));
      env.api.reply("/checks", jsonReply([checkWithState("web", "down")]));
    },
  },
  { name: "Overview empty", apply: (env) => env.api.reply("/checks", jsonReply([])) },
  {
    name: "Overview unreachable",
    apply: (env) => env.api.reply("/checks", { status: 503 }),
  },
  {
    name: "Overview token banner",
    apply: (env) => {
      env.api.reply("/checks", jsonReply([]));
      env.api.reply("/admin/config", { status: 401 });
    },
  },
];

async function assertFits(page: Page, width: number, label: string): Promise<void> {
  const result = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    hidden: [document.documentElement, document.body].some(
      (el) => getComputedStyle(el).overflowX === "hidden",
    ),
  }));
  assert(result.scroll <= width, `${label}: scrollWidth ${result.scroll} > ${width}`);
  assert(!result.hidden, `${label}: overflow hidden on the root`);
}

const ACCOUNT_ROUTES = [
  "/account/security",
  "/account/sessions",
  "/account/sessions/sign-out-all",
  "/account/recovery-codes",
];

/** The account page is in the shell, fits, and its Overview link goes to `/`. */
async function assertAccountShell(page: Page, width: number, label: string): Promise<void> {
  await assertFits(page, width, `${width}px ${label}`);
  assert(await page.locator("header.shell-header").isVisible(), `${label}: header`);
  assert(await page.locator('nav[aria-label="Main"]').isVisible(), `${label}: Main nav`);
  assert((await page.locator("h1").count()) === 1, `${label}: one h1`);
}

async function checkAccountShell(env: Env, page: Page, width: number): Promise<void> {
  const base = env.console.base;
  const nav = page.locator('nav[aria-label="Main"]');
  const visits: [string, () => Promise<unknown>][] = ACCOUNT_ROUTES.map((path) => [
    path,
    () => page.goto(base + path),
  ]);
  visits.push([
    "wrong-password recovery confirmation",
    async () => {
      await page.goto(`${base}/account/recovery-codes`);
      await page.fill('input[name="password"]', "wrong-password-for-the-check");
      await page.getByRole("button", { name: "Create new recovery codes" }).click();
      await page.getByText("Wrong password", { exact: false }).first().waitFor();
    },
  ]);
  for (const [label, visit] of visits) {
    await visit();
    await assertAccountShell(page, width, label);
    await Promise.all([
      page.waitForURL(`${base}/`),
      nav.getByRole("link", { name: "Overview", exact: true }).click(),
    ]);
  }
  env.role.current = "viewer";
  await page.goto(`${base}/account/security`);
  assert((await nav.getByRole("link", { name: "Overview" }).count()) === 1, "viewer: Overview");
  assert((await nav.getByRole("link", { name: "Team" }).count()) === 0, "viewer: no Team");
  env.role.current = "owner";
  ok(
    `${width}px: ${ACCOUNT_ROUTES.join(", ")} and the wrong-password recovery confirmation fit, show header and Main nav, have 1 h1 and reach / through Overview; viewer has Overview and no Team`,
  );
}

async function checkLayout(env: Env, browser: Browser, width: number, height: number) {
  const violations: string[] = [];
  const context = await browser.newContext({ viewport: { width, height } });
  watchCsp(context, violations);
  const page = await newPage(context, violations);
  const base = env.console.base;
  await page.goto(`${base}/sign-in`);
  await assertFits(page, width, `${width}px sign-in`);
  await signIn(page, env);
  for (const c of OVERVIEW_CASES) {
    c.apply(env);
    await page.goto(`${base}/`);
    await assertFits(page, width, `${width}px ${c.name}`);
  }
  OVERVIEW_CASES[0]?.apply(env);
  env.role.current = "viewer";
  await page.goto(`${base}/__test/states/forbidden`);
  await assertFits(page, width, `${width}px forbidden`);
  env.role.current = "owner";
  for (const name of ["Checkout API", LONG_NAME]) {
    env.target.current = { name, revision: "rev-1" };
    for (const path of FIXTURE_PAGES) {
      await page.goto(base + path);
      await assertFits(page, width, `${width}px ${path} (${name.length} chars)`);
    }
  }
  env.target.current = { name: "Checkout API", revision: "rev-1" };
  await page.goto(`${base}/team`);
  await assertFits(page, width, `${width}px team`);
  await checkAccountShell(env, page, width);
  assert(violations.length === 0, `CSP violations: ${violations.join(" | ")}`);
  await context.close();
  ok(`${width} x ${height}: sign-in, 4 Overview states, 403, Team and every fixture page fit`);
}

async function closedOrigin(): Promise<string> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const origin = `http://127.0.0.1:${probe.port}`;
  await probe.stop(true);
  return origin;
}

async function overviewText(page: Page, base: string): Promise<string> {
  await page.goto(`${base}/`);
  return (await page.locator("main").textContent()) ?? "";
}

/** Each failure kind through `/`, `readOverview` and the real `fetchJson`, then recovery. */
async function checkFailureKinds(env: Env, browser: Browser): Promise<void> {
  const base = env.console.base;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const violations: string[] = [];
  watchCsp(context, violations);
  const page = await newPage(context, violations);
  await signIn(page, env);
  try {
    env.refuse.current = await closedOrigin();
    const refused = await overviewText(page, base);
    assert(refused.includes("Kind: connection refused"), "refused: kind");
    assert(refused.includes(`The connection to ${env.api.url} was refused.`), "refused: text");
    assert(!refused.includes("5 seconds"), "refused: no 5 seconds");
    env.refuse.current = undefined;
    ok("failure kinds: a bound-then-closed port shows Kind: connection refused without 5 seconds");

    env.api.reply("/checks", { status: 200, isHeld: true });
    env.fastDeadline.current = true;
    const timeout = await overviewText(page, base);
    assert(timeout.includes("Kind: timeout"), "timeout: kind");
    assert(timeout.includes("pulse-api did not answer within 5 seconds."), "timeout: text");
    ok("failure kinds: a held /checks with the real 5000 ms deadline shows Kind: timeout");

    env.fastDeadline.current = false;
    env.api.reply("/checks", { status: 503 });
    const status = await overviewText(page, base);
    assert(status.includes("Kind: status 503"), "status: kind");
    assert(status.includes("pulse-api answered 503."), "status: text");
    assert(!status.includes("5 seconds"), "status: no 5 seconds");
    ok("failure kinds: HTTP 503 shows Kind: status 503");
  } finally {
    env.refuse.current = undefined;
    env.fastDeadline.current = false;
    env.api.reply("/checks", jsonReply([checkWithState("web", "up")]));
  }
  const back = await overviewText(page, base);
  assert(back.includes("Overall state") && !back.includes("Kind:"), "failure kinds: recovery");
  assert(violations.length === 0, `failure kinds: CSP violations ${violations.join("; ")}`);
  ok("failure kinds: resetting every switch restores the summary");
  await context.close();
}

/** Distinct rounded tops of the client rects of a Range over the `.account-email` text. */
async function emailTops(page: Page): Promise<number> {
  return page.evaluate(() => {
    const span = document.querySelector(".account-email");
    if (span === null) return 0;
    const range = document.createRange();
    range.selectNodeContents(span);
    return new Set(Array.from(range.getClientRects(), (r) => Math.round(r.top))).size;
  });
}

async function checkEmail(env: Env, browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const base = env.console.base;
  await signIn(page, env);
  for (const path of ["/", ...ACCOUNT_ROUTES]) {
    await page.goto(base + path);
    const tops = await emailTops(page);
    assert(tops === 1, `${path}: e-mail on ${tops} lines`);
  }
  await context.close();
  ok(`390px: the Range over ${DEMO_EMAIL} has exactly 1 top on / and the four account pages`);
}

async function checkLongEmail(browser: Browser): Promise<void> {
  const email = `${"a".repeat(58)}@example.com`;
  assert(email.length === 70, `long e-mail has ${email.length} characters, expected 70`);
  const env = await startEnv(0, email);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await signIn(page, env);
    await page.goto(`${env.console.base}/`);
    const text = await page.locator(".account-email").textContent();
    assert(text === `(${email})`, `long e-mail span text: ${text}`);
    await assertFits(page, 390, "long e-mail");
    ok("390px: a 70-character e-mail is shown in full in parentheses and fits");
  } finally {
    await context.close();
    await env.console.close();
    env.api.stop();
  }
}

async function checkNotFound(env: Env, browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const base = env.console.base;
  await signIn(page, env);
  await page.goto(`${base}/does-not-exist`);
  const titles = page.getByText("Page not found", { exact: true });
  assert((await titles.count()) === 1 && (await titles.isVisible()), "404: one visible title");
  const sentence = "There is no page at this address; go to the overview.";
  assert(await page.getByText(sentence, { exact: true }).isVisible(), "404: sentence");
  const texts = await page
    .locator("main#main p")
    .evaluateAll((ps) => ps.filter((p) => !p.querySelector("a")).map((p) => p.textContent ?? ""));
  assert(texts.length === 1, `404: ${texts.length} explanatory paragraphs`);
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const sentences = [...segmenter.segment(texts[0] ?? "")].filter((s) => s.segment.trim() !== "");
  assert(sentences.length === 1, `404: ${sentences.length} sentences`);
  await Promise.all([
    page.waitForURL(`${base}/`),
    page.getByRole("link", { name: "Go to the overview", exact: true }).click(),
  ]);
  await context.close();
  ok("404: 1 visible Page not found, the fixed sentence and a working Go to the overview link");
}

/** Computed colour and keyboard outline of a link, reached by Tab. */
async function assertLink(page: Page, name: string, label: string): Promise<void> {
  const link = page.getByRole("link", { name, exact: true }).first();
  const colour = await link.evaluate((a) => getComputedStyle(a).color);
  assert(colour === LINK_COLOUR, `${label}: colour ${colour}`);
  await page.locator("body").focus();
  await tabTo(page, name);
  const outline = (await focusedOutline(page)).outline;
  assert(outline !== "none", `${label}: no focus outline`);
}

/** Reads the CSS rules, because getComputedStyle hides the visited colour for privacy. */
async function visitedRules(page: Page): Promise<{ matching: number; conflicting: string[] }> {
  return page.evaluate((colour) => {
    const rules = Array.from(document.styleSheets).flatMap((sheet) =>
      Array.from(sheet.cssRules).filter((rule) => rule instanceof CSSStyleRule),
    );
    const visited = rules.filter((rule) => rule.selectorText.includes(":visited"));
    const matching = visited.filter(
      (rule) =>
        rule.selectorText.split(",").some((s) => s.trim() === "a:visited") &&
        rule.style.color === colour,
    ).length;
    const conflicting = visited
      .filter((rule) => rule.style.color !== "" && rule.style.color !== colour)
      .map((rule) => rule.selectorText);
    return { matching, conflicting };
  }, LINK_COLOUR);
}

async function checkLinks(env: Env, browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const base = env.console.base;
  await signIn(page, env);
  await page.goto(`${base}/account/security`);
  await assertLink(page, "Account security", "header Account security");
  await assertLink(page, "Sessions", "account-content link");
  await page.goto(`${base}/account/sessions/sign-out-all`);
  await assertLink(page, "Cancel", "sign out all Cancel");
  await page.goto(`${base}/account/recovery-codes`);
  await assertLink(page, "Cancel", "recovery codes Cancel");
  const rules = await visitedRules(page);
  assert(rules.matching >= 1, "no a:visited rule with the link colour");
  assert(rules.conflicting.length === 0, `other visited colours: ${rules.conflicting.join(", ")}`);
  await page.fill('input[name="password"]', OWNER_PASSWORD);
  await page.getByRole("button", { name: "Create new recovery codes" }).click();
  const codes = await page.locator("#recovery-codes li").allTextContents();
  env.console.recoveryCodes.splice(0, env.console.recoveryCodes.length, ...codes);
  await assertLink(page, "Continue", "result Continue");
  await context.close();
  ok(`links: header, account, both Cancels and Continue are ${LINK_COLOUR} with a focus outline`);
  ok(`Visited links: an a:visited rule has ${LINK_COLOUR} and no :visited rule has another colour`);
}

/** Gaps between consecutive forms, top of the next minus bottom of the previous. */
async function formGaps(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const rects = Array.from(document.querySelectorAll("main form"), (f) =>
      f.getBoundingClientRect(),
    );
    return rects.slice(1).map((r, i) => r.top - (rects[i]?.bottom ?? r.top));
  });
}

async function checkGaps(env: Env, browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const base = env.console.base;
  await page.goto(`${base}/sign-in`);
  await page.fill('input[name="email"]', env.ownerEmail);
  await page.fill('input[name="password"]', OWNER_PASSWORD);
  await Promise.all([
    page.waitForURL(`${base}/sign-in/factor`),
    page.click('button[type="submit"]'),
  ]);
  const factor = await formGaps(page);
  assert(factor.length === 2 && factor.every((g) => g >= 12), `factor gaps ${factor.join(", ")}`);
  await page.fill('input[name="recovery_code"]', env.console.recoveryCodes.shift() ?? "");
  await Promise.all([
    page.waitForURL(`${base}/`),
    page.getByRole("button", { name: "Use recovery code" }).click(),
  ]);
  await page.goto(`${base}/account/authenticator`);
  const replace = await formGaps(page);
  assert(replace.length === 1 && replace.every((g) => g >= 12), `replace gap ${replace.join()}`);
  await context.close();
  ok(
    `Gap: 390px form gaps ${factor.join(", ")} px on /sign-in/factor and ${replace} px on replace`,
  );
}

async function axeOn(page: Page, url: string, label: string): Promise<void> {
  await page.goto(url);
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const ids = result.violations.map((v) => v.id);
  assert(ids.length === 0, `axe on ${label}: ${ids.join(", ")}`);
  ok(`axe: 0 violations on ${label}`);
}

async function checkAxe(env: Env, browser: Browser): Promise<void> {
  const violations: string[] = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await newPage(context, violations);
  const base = env.console.base;
  await axeOn(page, `${base}/sign-in`, "sign-in");
  await signIn(page, env);
  await axeOn(page, `${base}/`, "Overview");
  await axeOn(page, `${base}/does-not-exist`, "shell 404");
  await axeOn(page, `${base}/team`, "Team");
  for (const path of ACCOUNT_ROUTES) await axeOn(page, base + path, path);
  env.role.current = "viewer";
  await axeOn(page, `${base}/__test/states/forbidden`, "shell 403");
  env.role.current = "owner";
  await axeOn(page, `${base}/__test/confirm/typed/delete-check`, "typed confirmation");
  await axeOn(page, `${base}/__test/confirm/plain/resolve-incident`, "plain confirmation");
  assert(violations.length === 0, `CSP violations: ${violations.join(" | ")}`);
  await context.close();
}

async function focusedOutline(page: Page): Promise<{ text: string; outline: string }> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement)) return { text: "", outline: "none" };
    return { text: el.textContent?.trim() ?? "", outline: getComputedStyle(el).outlineStyle };
  });
}

async function checkFocus(env: Env, browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await signIn(page, env);
  await page.goto(`${env.console.base}/`);
  const expected = ["Skip to content", "Account security", "Sign out", "Overview"];
  for (const text of expected) {
    await page.keyboard.press("Tab");
    const got = await focusedOutline(page);
    assert(got.text === text, `Tab reached "${got.text}", expected "${text}"`);
    assert(got.outline !== "none", `${text} has no focus outline`);
  }
  await context.close();
  ok(
    "Tab reaches Skip to content, Account security, Sign out and Overview in order, each with an outline",
  );
}

/** Presses Tab from the top until the element with this text has focus. */
async function tabTo(page: Page, text: string): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press("Tab");
    if ((await focusedOutline(page)).text === text) return;
  }
  throw new CheckError(`Tab never reached ${text}`);
}

async function checkNoScript(env: Env, browser: Browser): Promise<void> {
  const violations: string[] = [];
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await newPage(context, violations);
  const base = env.console.base;
  await signIn(page, env);
  env.recorder.actions.length = 0;
  await page.goto(`${base}/__test/confirm/typed/delete-check`);
  await page.fill('input[name="confirm_name"]', "Checkout API");
  await Promise.all([page.waitForURL(`${base}/__test/confirm/done`), page.keyboard.press("Enter")]);
  assert(env.recorder.actions.length === 1, "typed confirmation records 1 action");
  ok("no JavaScript: typed Checkout API and Enter complete the typed confirmation");
  env.recorder.actions.length = 0;
  await page.goto(`${base}/__test/confirm/plain/resolve-incident`);
  await tabTo(page, "Resolve incident");
  await Promise.all([page.waitForURL(`${base}/__test/confirm/done`), page.keyboard.press("Enter")]);
  assert(env.recorder.actions.length === 1, "plain confirmation records 1 action");
  ok("no JavaScript: Tab and Enter complete the plain confirmation");
  await checkNoScriptBusy(env, context, page);
  assert(violations.length === 0, `CSP violations: ${violations.join(" | ")}`);
  await context.close();
}

async function checkNoScriptBusy(env: Env, context: BrowserContext, page: Page): Promise<void> {
  const base = env.console.base;
  env.recorder.actions.length = 0;
  await page.goto(`${base}/__test/states/busy`);
  const run = page.getByRole("button", { name: "Run" });
  assert(!(await run.isDisabled()), "Run is not disabled on load");
  let body = "";
  page.on("request", (req) => {
    if (req.method() === "POST") body = req.postData() ?? "";
  });
  await page.fill('input[name="choice"]', "first");
  await run.focus();
  const [answer] = await Promise.all([
    page.waitForResponse((res) => res.request().method() === "POST"),
    page.keyboard.press("Enter"),
  ]);
  assert(answer.status() === 200, `busy POST answers ${answer.status()}, expected 200`);
  await page.getByText("Submitted: go").waitFor();
  assert(env.recorder.actions.length === 1, "busy POST records 1 action");
  assert(env.recorder.actions[0]?.action === "go", "the action is go");
  ok("no JavaScript: Enter on Run gives Submitted: go with 1 action=go");
  const replay = await context.request.post(`${base}/__test/states/busy`, {
    headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
    data: body,
    maxRedirects: 0,
  });
  assert(replay.status() === 409, `replay answers ${replay.status()}, expected 409`);
  assert((await replay.text()).includes("Already submitted"), "replay shows Already submitted");
  assert(env.recorder.actions.length === 1, "replay records no second action");
  ok("no JavaScript: the captured POST replayed answers 409 Already submitted, still 1 action");
}

type RunState = { disabled: boolean; busy: string | null; text: string };

/**
 * Records the Run button 300 ms after the submit into sessionStorage, which survives into the
 * answer page. Playwright cannot evaluate in a page whose navigation is still pending, so the
 * check reads the record after the release.
 */
async function recordPendingRun(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.addEventListener("submit", () => {
      setTimeout(() => {
        const b = document.querySelector('form[action="/__test/states/busy"] button');
        if (!(b instanceof HTMLButtonElement)) return;
        const state = {
          disabled: b.disabled,
          busy: b.getAttribute("aria-busy"),
          text: b.textContent?.trim() ?? "",
        };
        sessionStorage.setItem("pending-run", JSON.stringify(state));
      }, 300);
    });
  });
}

async function pendingRun(page: Page): Promise<RunState | undefined> {
  const value = await page.evaluate(() => sessionStorage.getItem("pending-run"));
  return value === null ? undefined : (JSON.parse(value) as RunState);
}

async function checkBusyScript(env: Env, browser: Browser): Promise<void> {
  const violations: string[] = [];
  const context = await browser.newContext();
  const page = await newPage(context, violations);
  const base = env.console.base;
  await signIn(page, env);
  env.recorder.actions.length = 0;
  await page.goto(`${base}/__test/states/busy`);
  await page.fill('input[name="choice"]', "first");
  let posts = 0;
  page.on("request", (req) => {
    if (req.method() === "POST") posts += 1;
  });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The server holds the POST until the assertions on the pending page are done.
  env.hold.current = released;
  const run = page.getByRole("button", { name: /Run|Running/ });
  await recordPendingRun(page);
  const box = await run.boundingBox();
  if (box === null) throw new CheckError("Run has no box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await page.keyboard.press("Enter");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert(posts === 1, `${posts} POST requests while held, expected 1`);
  release();
  env.hold.current = undefined;
  await page.getByText("Submitted: go").waitFor();
  const pending = await pendingRun(page);
  assert(pending?.disabled === true, "Run was disabled while the POST ran");
  assert(pending?.busy === "true", 'aria-busy was "true"');
  assert(pending?.text === "Running…", "the label was Running…");
  ok("JavaScript: Run is disabled, aria-busy=true and Running…; 3 clicks and Enter send no POST");
  assert(posts === 1, `${posts} POST requests in total, expected 1`);
  assert(env.recorder.actions.length === 1, "1 action recorded");
  assert(env.recorder.actions[0]?.action === "go", "the submitter value go survived");
  ok("JavaScript: the release records exactly 1 action=go");
  await checkPageShow(env, page);
  assert(violations.length === 0, `CSP violations: ${violations.join(" | ")}`);
  ok("0 CSP violations reported by the browser");
  await context.close();
}

/** Decision 6: a form restored from the back/forward cache is usable again. */
async function checkPageShow(env: Env, page: Page): Promise<void> {
  await page.goto(`${env.console.base}/__test/states/busy`);
  await page.evaluate(() => {
    const form = document.querySelector("form");
    const button = form?.querySelector("button");
    if (button instanceof HTMLButtonElement) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    }
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  const state = await page.evaluate(() => {
    const button = document.querySelector("form button");
    return button instanceof HTMLButtonElement
      ? { disabled: button.disabled, busy: button.getAttribute("aria-busy") }
      : undefined;
  });
  assert(state !== undefined && !state.disabled && state.busy === null, "pageshow restores");
  ok("pageshow from the back/forward cache leaves the restored form usable");
}

/** Cancel on new recovery codes returns to security with the count unchanged. */
async function checkCodesCancel(owner: Page, base: string): Promise<void> {
  const left = /<p>(\d{1,2}) of 10 recovery codes left/;
  await owner.goto(`${base}/account/security`);
  const before = left.exec(await owner.content())?.[1];
  await owner.goto(`${base}/account/recovery-codes`);
  await Promise.all([
    owner.waitForURL(`${base}/account/security`),
    owner.getByRole("link", { name: "Cancel", exact: true }).click(),
  ]);
  const after = left.exec(await owner.content())?.[1];
  assert(before !== undefined && before === after, `Cancel kept the count (${before}, ${after})`);
  ok(`no JavaScript: recovery codes Cancel returns to /account/security with ${after} of 10 left`);
}

/** The account confirmations and two-browser revocation work with page JavaScript off. */
async function checkAccountNoScript(env: Env, browser: Browser): Promise<void> {
  const a = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  const b = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  const owner = await a.newPage();
  const other = await b.newPage();
  const base = env.console.base;
  try {
    await signIn(owner, env);
    await signIn(other, env);
    await owner.goto(`${base}/account/sessions/sign-out-all`);
    await Promise.all([
      owner.waitForURL(`${base}/account/sessions`),
      owner.getByRole("link", { name: "Cancel", exact: true }).click(),
    ]);
    const stillIn = await other.goto(`${base}/`);
    assert(stillIn?.status() === 200, "Cancel leaves the other browser at 200");
    assert((await other.content()).includes("Signed in as"), "Cancel keeps the other session");
    ok("no JavaScript: sign out all Cancel returns to /account/sessions and signs nobody out");
    await owner.goto(`${base}/account/sessions/sign-out-all`);
    await Promise.all([
      owner.waitForURL(`${base}/account/sessions?signed-out=others`),
      owner.getByRole("button", { name: "Sign out all other sessions", exact: true }).click(),
    ]);
    assert(
      (await owner.content()).includes("All other sessions are signed out."),
      "sign out all confirmed",
    );
    await other.goto(`${base}/`);
    assert(other.url().includes("/sign-in?next="), "other browser is signed out");
    await owner.goto(`${base}/`);
    assert((await owner.content()).includes("Signed in as"), "current browser stays signed in");
    await checkCodesCancel(owner, base);
    await owner.goto(`${base}/account/recovery-codes`);
    await owner.fill('input[name="password"]', OWNER_PASSWORD);
    await owner.getByRole("button", { name: "Create new recovery codes" }).click();
    const codes = await owner.locator("#recovery-codes li").allTextContents();
    assert(codes.length === 10, "new recovery codes confirmation shows ten codes");
    assert((await owner.getByRole("link", { name: "Cancel" }).count()) === 0, "no Cancel");
    await Promise.all([
      owner.waitForURL(`${base}/account/security`),
      owner.getByRole("link", { name: "Continue", exact: true }).click(),
    ]);
    ok(
      "no JavaScript: new recovery codes shows 10 codes once and Continue reaches /account/security",
    );
    // The old fixture codes stop working; later checks sign in with the new ones.
    env.console.recoveryCodes.splice(0, env.console.recoveryCodes.length, ...codes);
    await assertFits(owner, 390, "recovery codes");
    await owner.goto(`${base}/account/authenticator`);
    await owner.fill('input[name="password"]', OWNER_PASSWORD);
    await owner.getByRole("button", { name: "Replace authenticator", exact: true }).click();
    await owner.locator("#totp-secret").waitFor();
    await assertFits(owner, 390, "authenticator setup key");
    await other.fill('input[name="email"]', env.ownerEmail);
    await other.fill('input[name="password"]', OWNER_PASSWORD);
    await Promise.all([
      other.waitForURL(`${base}/sign-in/factor`),
      other.getByRole("button", { name: "Sign in", exact: true }).click(),
    ]);
    await assertFits(other, 390, "sign-in factor");
    await owner.goto(`${base}/account/sessions`);
    await Promise.all([
      owner.waitForURL(`${base}/sign-in`),
      owner.getByRole("button", { name: "Sign out", exact: true }).click(),
    ]);
    await owner.goto(`${base}/`);
    assert(owner.url().includes("/sign-in?next="), "final sign out ends this browser");
    ok(
      "no JavaScript: both account confirmations, two-browser sign out all, final sign out and 390px factor/key/code pages",
    );
  } finally {
    await a.close();
    await b.close();
  }
}

/** At 390 px: the invite form, link page, revoke confirmation, accept form and invalid link. */
async function checkInvites(env: Env, browser: Browser): Promise<void> {
  const violations: string[] = [];
  const viewport = { width: 390, height: 844 };
  const owner = await browser.newContext({ viewport });
  const invitee = await browser.newContext({ viewport });
  try {
    watchCsp(owner, violations);
    watchCsp(invitee, violations);
    const page = await newPage(owner, violations);
    const base = env.console.base;
    await signIn(page, env);
    await page.goto(`${base}/team`);
    await page.fill('input[name="email"]', `${"invited-person".repeat(4)}@example.com`);
    await page.selectOption('select[name="role"]', "viewer");
    await Promise.all([
      page.waitForURL(`${base}/team/invites`),
      page.getByRole("button", { name: "Create invite link" }).click(),
    ]);
    await assertFits(page, 390, "390px invite link page");
    const link = await page.inputValue("#invite-link");
    assert(/\/invite\/[A-Za-z0-9_-]{43}$/.test(link), "the link page shows the invite link");
    const linkResult = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    assert(linkResult.violations.length === 0, "axe on the invite link page");
    await page.goto(`${base}/team`);
    await assertFits(page, 390, "390px team with a pending invite");
    await axeOn(page, `${base}/team/invites/revoke?invite=1`, "revoke invite");
    await assertFits(page, 390, "390px revoke invite");
    const anon = await newPage(invitee, violations);
    await axeOn(anon, link, "invite accept form");
    await assertFits(anon, 390, "390px invite accept form");
    await axeOn(anon, `${base}/invite/${"A".repeat(43)}`, "invalid link");
    await assertFits(anon, 390, "390px invalid link");
    assert(violations.length === 0, `CSP violations: ${violations.join(" | ")}`);
    ok("390px: invite link page, Team with an invite, revoke, accept form and invalid link fit");
  } finally {
    await owner.close();
    await invitee.close();
  }
}

/**
 * At 390 px without JavaScript: an invitee joins, then the Owner opens the role form, the 2FA
 * reset and the removal confirmation from the Team page links and removes the person.
 */
async function checkTeamActions(env: Env, browser: Browser): Promise<void> {
  const violations: string[] = [];
  const viewport = { width: 390, height: 844 };
  const owner = await browser.newContext({ viewport, javaScriptEnabled: false });
  const invitee = await browser.newContext({ viewport, javaScriptEnabled: false });
  const scriptedContext = await browser.newContext({ viewport });
  try {
    watchCsp(scriptedContext, violations);
    const scripted = await newPage(scriptedContext, violations);
    watchCsp(owner, violations);
    watchCsp(invitee, violations);
    const page = await newPage(owner, violations);
    const base = env.console.base;
    await signIn(page, env);
    // The same session in the scripted context: one sign-in, one fixture recovery code.
    await scriptedContext.addCookies(await owner.cookies());
    await page.goto(`${base}/team`);
    await page.fill('input[name="email"]', "removable@example.com");
    await page.selectOption('select[name="role"]', "member");
    await Promise.all([
      page.waitForURL(`${base}/team/invites`),
      page.getByRole("button", { name: "Create invite link" }).click(),
    ]);
    const link = await page.inputValue("#invite-link");
    const anon = await newPage(invitee, violations);
    await anon.goto(link);
    await anon.fill('input[name="name"]', "Rem Ovable");
    await anon.fill('input[name="password"]', "removable-person-password");
    await anon.fill('input[name="password_confirm"]', "removable-person-password");
    await Promise.all([
      anon.waitForURL((url) => !url.pathname.startsWith("/invite/")),
      anon.getByRole("button", { name: "Create account" }).click(),
    ]);
    await page.goto(`${base}/team`);
    await assertFits(page, 390, "390px team with action links");
    for (const [name, label] of [
      ["Change role for Rem Ovable", "role form"],
      ["Reset 2FA for Rem Ovable", "2FA reset confirmation"],
      ["Remove for Rem Ovable", "removal confirmation"],
    ] as const) {
      await page.goto(`${base}/team`);
      const href = await page.getByRole("link", { name }).getAttribute("href");
      await page.goto(`${base}${href ?? ""}`);
      await assertFits(page, 390, `390px ${label}`);
      // axe needs JavaScript, so it runs in a second, scripted context.
      await axeOn(scripted, `${base}${href ?? ""}`, label);
    }
    await page.fill('input[name="confirm_name"]', "Rem Ovable");
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/team"),
      page.getByRole("button", { name: "Remove" }).click(),
    ]);
    assert(!(await page.content()).includes("removable@example.com"), "the person is removed");
    assert(violations.length === 0, `CSP violations: ${violations.join(" | ")}`);
    ok(
      "390px, no JavaScript: role form, 2FA reset and removal fit, pass axe and remove the person",
    );
  } finally {
    await owner.close();
    await invitee.close();
    await scriptedContext.close();
  }
}

/** At 390 px: the reset link page, the reset form, the invalid reset link and the own password form. */
async function checkResetAndPassword(env: Env, browser: Browser): Promise<void> {
  const violations: string[] = [];
  const viewport = { width: 390, height: 844 };
  const owner = await browser.newContext({ viewport });
  const person = await browser.newContext({ viewport });
  try {
    watchCsp(owner, violations);
    watchCsp(person, violations);
    const page = await newPage(owner, violations);
    const base = env.console.base;
    await signIn(page, env);
    await page.goto(`${base}/team`);
    await page.fill('input[name="email"]', "resettable@example.com");
    await page.selectOption('select[name="role"]', "member");
    await Promise.all([
      page.waitForURL(`${base}/team/invites`),
      page.getByRole("button", { name: "Create invite link" }).click(),
    ]);
    const invite = await page.inputValue("#invite-link");
    const anon = await newPage(person, violations);
    await anon.goto(invite);
    await anon.fill('input[name="name"]', "Re Settable");
    await anon.fill('input[name="password"]', "resettable-person-password");
    await anon.fill('input[name="password_confirm"]', "resettable-person-password");
    await Promise.all([
      anon.waitForURL((url) => !url.pathname.startsWith("/invite/")),
      anon.getByRole("button", { name: "Create account" }).click(),
    ]);
    await axeOn(anon, `${base}/account/password`, "own password form");
    await assertFits(anon, 390, "390px own password form");
    await page.goto(`${base}/team`);
    const href = await page
      .getByRole("link", { name: "Reset link for Re Settable" })
      .getAttribute("href");
    await axeOn(page, `${base}${href ?? ""}`, "reset link confirmation");
    await assertFits(page, 390, "390px reset link confirmation");
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/team/reset-link"),
      page.getByRole("button", { name: "Make reset link" }).click(),
    ]);
    await assertFits(page, 390, "390px reset link page");
    const link = await page.inputValue("#reset-link");
    assert(/\/reset\/[A-Za-z0-9_-]{43}$/.test(link), "the link page shows the reset link");
    const linkResult = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    assert(linkResult.violations.length === 0, "axe on the reset link page");
    await axeOn(anon, link, "reset form");
    await assertFits(anon, 390, "390px reset form");
    await axeOn(anon, `${base}/reset/${"A".repeat(43)}`, "invalid reset link");
    await assertFits(anon, 390, "390px invalid reset link");
    assert(violations.length === 0, `CSP violations: ${violations.join(" | ")}`);
    ok(
      "390px: own password form, reset link confirmation and page, reset form and invalid link fit",
    );
  } finally {
    await owner.close();
    await person.close();
  }
}

const HOST_LINE = String.raw`PULSE_PROBE_HEADER_HOSTS='{"PULSE_HEADER_TOKEN":["a'\'';id;'\''b"]}'`;
const PROBE_QUORUM =
  "Every probe runs this check. It is down when at least two locations report down; with one reporting location, that location decides. Choosing locations or a quorum per check is not available yet.";
const HEARTBEAT_RULE =
  "Heartbeat checks are not run by probes and have no quorum; your job pings pulse-api. With no ping for longer than the period plus the grace time, the check is down at once.";
const EDITORS: [string, boolean][] = [
  ...["http", "tls", "tcp", "dns", "domain"].map((t): [string, boolean] => [
    `/checks/new?type=${t}`,
    false,
  ]),
  ["/checks/new?type=heartbeat", true],
  ["/checks/edit?id=web", false],
  ["/checks/edit?id=cert", false],
  ["/checks/edit?id=domain-exp", false],
  ["/checks/edit?id=nightly-backup", true],
];

/** The paragraph above Submit is the fixed rule; no editor has a quorum or location input. */
async function assertQuorumText(page: Page, url: string, isHeartbeat: boolean): Promise<void> {
  await page.goto(url);
  const found = await page.evaluate(() => {
    const texts = [...document.querySelectorAll("form p")]
      .filter((p) => {
        const submit = p.closest("form")?.querySelector('button[type="submit"]');
        return submit != null && (p.compareDocumentPosition(submit) & 4) !== 0;
      })
      .map((p) => p.textContent?.trim() ?? "");
    const names = [...document.querySelectorAll("input, select, textarea")].map(
      (el) => el.getAttribute("name") ?? "",
    );
    return { texts, names };
  });
  const expected = isHeartbeat ? HEARTBEAT_RULE : PROBE_QUORUM;
  const other = isHeartbeat ? PROBE_QUORUM : HEARTBEAT_RULE;
  assert(found.texts.includes(expected), `${url}: rule paragraph above Submit`);
  assert(!found.texts.includes(other), `${url}: no other rule paragraph`);
  assert(
    !found.names.some((n) => /quorum|location/i.test(n)),
    `${url}: no quorum or location input`,
  );
}

function startChecksApi(): ReturnType<typeof startFakeApi> {
  const api = startFakeApi();
  api.reply("/admin/config", jsonReply(checkConfig));
  api.reply("/checks", jsonReply([webState, ...checkStates.slice(1)]));
  api.reply("/admin/config/export", jsonReply(checkExport));
  api.reply("/uptime", jsonReply(checkUptime));
  api.reply("/checks/web/results", jsonReply(webResults));
  api.reply("/checks/web/location-uptime", jsonReply(webLocationUptime));
  api.reply("/checks/web/latency", jsonReply(webLatency));
  return api;
}

async function checkScreensWith(browser: Browser, hasScript: boolean): Promise<void> {
  const env = await startEnv(0);
  env.api.stop();
  const api = startChecksApi();
  const server = await startSignedInConsole({
    apiUrl: api.url,
    ownerEmail: env.ownerEmail,
    adminToken: ADMIN_TOKEN,
  });
  await env.console.close();
  const local: Env = { ...env, console: server, api };
  const label = hasScript ? "JavaScript on" : "JavaScript off";
  const violations: string[] = [];
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    javaScriptEnabled: hasScript,
  });
  await context.addInitScript(() => {
    const copied: string[] = [];
    Object.assign(window, { copied });
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (text: string) => {
          copied.push(text);
          return Promise.resolve();
        },
      },
    });
  });
  const page = await newPage(context, violations);
  const base = server.base;
  try {
    await signIn(page, local);
    const nav = page.locator('nav[aria-label="Main"]');
    await Promise.all([
      page.waitForURL(`${base}/checks`),
      nav.getByRole("link", { name: "Checks", exact: true }).click(),
    ]);
    assert(
      (await page.getByText("6 checks, 1 shadowed definition").count()) === 1,
      `${label}: counts`,
    );
    await assertFits(page, 390, `${label} list`);
    await page.goto(`${base}/checks/check?id=web`);
    await assertFits(page, 390, `${label} detail`);
    const pre = await page.locator("pre").first().textContent();
    assert(pre === HOST_LINE, `${label}: detail host line is the literal`);
    const copy = page.locator("button[data-copy]").first();
    assert((await copy.isVisible()) === hasScript, `${label}: copy button visible ${hasScript}`);
    if (hasScript) {
      await copy.click();
      const copied = await page.evaluate(() => (window as unknown as { copied: string[] }).copied);
      assert(copied[0] === HOST_LINE, `${label}: copied host line is the literal`);
      await page.goto(`${base}/checks/check?id=nightly-backup`);
      const line = `curl -fsS -X POST -H 'Authorization: Bearer <secret>' '${api.url}/heartbeat/nightly-backup'`;
      assert(
        (await page.locator("pre").first().textContent()) === line,
        `${label}: heartbeat line`,
      );
      await page.locator("button[data-copy]").first().click();
      const beat = await page.evaluate(() => (window as unknown as { copied: string[] }).copied);
      assert(beat[0] === line, `${label}: copied heartbeat line is the literal`);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const [url, isHeartbeat] of EDITORS) await assertQuorumText(page, base + url, isHeartbeat);
    await page.goto(`${base}/checks/edit?id=web`);
    const editorPre = await page.locator("#editor-host-binding-line").textContent();
    assert(editorPre === HOST_LINE, `${label}: editor host line is the literal`);
    if (hasScript) {
      const pages = [
        "/checks",
        "/checks/check?id=web",
        "/checks/shadowed?id=dns-a",
        "/checks/delete?id=web",
      ];
      for (const path of [...pages, ...EDITORS.map(([url]) => url)])
        await axeOn(page, base + path, path);
    }
    assert(violations.length === 0, `${label}: CSP violations ${violations.join(" | ")}`);
    ok(
      `Checks, ${label}: entered through the Checks nav link, list and detail fit 390 px, literal host-binding${hasScript ? " and heartbeat copy" : " line selectable, copy hidden"}, fixed quorum or heartbeat rule on ${EDITORS.length} editors${hasScript ? ", axe 0 on list/detail/shadowed/delete/editors" : ""}, 0 CSP violations`,
    );
  } finally {
    await context.close();
    await server.close();
    api.stop();
  }
}

const WIRE = { "x-pulse-contract": "1", "content-type": "application/json" };
const NEW_REVISION = `sha256-${"c".repeat(64)}`;
type CreateCase = { type: string; id: string; fields: Record<string, string> };
const CREATE_CASES: CreateCase[] = [
  { type: "http", id: "e2e-http", fields: { url: "https://example.com/", interval_ms: "60000" } },
  { type: "tls", id: "e2e-tls", fields: { host: "example.com", interval_ms: "60000" } },
  {
    type: "tcp",
    id: "e2e-tcp",
    fields: { host: "db.example.com", port: "5432", interval_ms: "60000" },
  },
  {
    type: "dns",
    id: "e2e-dns",
    fields: { dns_name: "example.com", expected: "192.0.2.1", interval_ms: "60000" },
  },
  { type: "domain", id: "e2e-domain", fields: { domain: "example.org" } },
  {
    type: "heartbeat",
    id: "e2e-beat",
    fields: { period_ms: "60000", secret: "e2e-secret-ABCDEFGHIJ" },
  },
];

type ConfigEntry = Record<string, unknown>;
type StatefulApi = { api: ReturnType<typeof startFakeApi>; setChecks: (c: ConfigEntry[]) => void };

/** A fake api whose config answer follows the writes the console sends. */
function startStatefulChecksApi(): StatefulApi {
  const api = startChecksApi();
  const setChecks = (checks: ConfigEntry[]): void =>
    api.reply("/admin/config", jsonReply({ ...checkConfig, checks }));
  return { api, setChecks };
}

async function submitForm(page: Page): Promise<void> {
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST"),
    page.locator('main form button[type="submit"]').last().click(),
  ]);
  await page.waitForLoadState("load");
}

async function alertText(page: Page): Promise<string> {
  return (await page.locator("main").innerText()).slice(0, 600);
}

async function createEach(page: Page, base: string, state: StatefulApi, label: string) {
  const checks: ConfigEntry[] = [...checkConfig.checks];
  for (const c of CREATE_CASES) {
    const url = `${base}/checks/new?type=${c.type}`;
    await page.goto(url);
    await page.fill('input[name="id"]', c.id);
    await page.fill('input[name="name"]', `E2E ${c.type}`);
    for (const [name, value] of Object.entries(c.fields))
      await page.fill(`[name="${name}"]`, value);
    const template =
      checkConfig.checks.find((x) => ("type" in x ? x.type : "http") === c.type) ?? {};
    state.api.replyTo("POST", "/admin/checks", {
      status: 201,
      body: "{}",
      headers: { ...WIRE, etag: `"${NEW_REVISION}"` },
      after: () => {
        checks.push({ ...template, id: c.id, name: `E2E ${c.type}`, source: "database" });
        state.setChecks(checks);
      },
    });
    await submitForm(page);
    assert(
      page.url() === `${base}/checks/check?id=${c.id}&saved=1`,
      `${label}: create ${c.type} redirects, got ${page.url()} ${await alertText(page)}`,
    );
    assert((await page.getByText("Check saved.").count()) === 1, `${label}: ${c.type} saved`);
  }
  const posts = state.api.seen.filter((s) => s.method === "POST");
  assert(posts.length === CREATE_CASES.length, `${label}: one POST per create`);
  assert(
    posts.every((s) => s.headers["if-match"] === `"${checkConfig.revision}"`),
    `${label}: create sends If-Match of the POST-time read`,
  );
}

async function editAndConflict(page: Page, base: string, state: StatefulApi, label: string) {
  const url = `${base}/checks/edit?id=web`;
  state.api.replyTo("PUT", "/admin/checks/web", {
    status: 200,
    body: "{}",
    headers: { ...WIRE, etag: `"${NEW_REVISION}"` },
  });
  await page.goto(url);
  await page.fill('input[name="name"]', "Web shop renamed");
  await submitForm(page);
  assert(page.url() === `${base}/checks/check?id=web&saved=1`, `${label}: edit redirects`);
  const put = state.api.seen.filter((s) => s.method === "PUT").at(-1);
  const sent = JSON.parse(put?.body ?? "{}") as { headers?: unknown; body?: unknown };
  assert(
    JSON.stringify(sent.headers) ===
      '{"X-Api-Key":{"keep":true},"Authorization":{"env":"PULSE_HEADER_TOKEN"}}',
    `${label}: edit keeps the stored header`,
  );
  assert(JSON.stringify(sent.body) === '{"keep":true}', `${label}: edit keeps the stored body`);
  state.api.replyTo("PUT", "/admin/checks/web", { status: 412, body: "{}", headers: WIRE });
  await page.goto(url);
  await page.fill('input[name="name"]', "Web shop conflict");
  await submitForm(page);
  assert(
    (await page.getByText("Changed since you opened it").count()) === 1,
    `${label}: 412 shows the conflict`,
  );
  assert(
    (await page.getByText("Web shop conflict").count()) >= 1,
    `${label}: conflict keeps input`,
  );
  await Promise.all([
    page.waitForURL(url),
    page.getByRole("link", { name: "Reload", exact: true }).click(),
  ]);
  assert((await page.locator('input[name="name"]').count()) === 1, `${label}: reopened editor`);
}

async function exportAndFilter(page: Page, base: string, label: string) {
  const res = await page.request.get(`${base}/checks/export?id=dns-a&shadowed=1`);
  assert(res.status() === 200, `${label}: shadowed export 200`);
  assert(res.headers()["cache-control"] === "no-store", `${label}: export no-store`);
  assert(
    (res.headers()["content-disposition"] ?? "").startsWith("attachment"),
    `${label}: export is a download`,
  );
  const text = await res.text();
  assert(!/keep|hasSecret|"source"/.test(text), `${label}: export is redacted`);
  await page.goto(`${base}/checks/shadowed?id=dns-a`);
  assert(
    (await page.getByText("DNS record (old)").count()) >= 1,
    `${label}: shadowed page shows the database definition`,
  );
  await page.goto(`${base}/checks?type=tcp&source=file`);
  const rows = await page.locator("tbody tr").count();
  assert(rows === 1, `${label}: composed filters leave 1 row, got ${rows}`);
}

async function typedDelete(page: Page, base: string, state: StatefulApi, label: string) {
  const spaced = checkConfig.checks.map((c) =>
    c.id === "web" ? { ...c, name: " Checkout API " } : c,
  );
  state.setChecks(spaced);
  state.api.replyTo("DELETE", "/admin/checks/web", { status: 204, body: "", headers: WIRE });
  const url = `${base}/checks/delete?id=web`;
  await page.goto(url);
  await page.fill('input[name="confirm_name"]', "Checkout  API");
  await submitForm(page);
  assert(
    state.api.seen.every((s) => s.method !== "DELETE"),
    `${label}: a wrong typed name sends no DELETE`,
  );
  await page.goto(url);
  await page.fill('input[name="confirm_name"]', "Checkout API");
  await submitForm(page);
  assert(page.url() === `${base}/checks?deleted=1`, `${label}: delete redirects`);
  assert((await page.getByText("Check deleted.").count()) === 1, `${label}: deleted notice`);
  assert(
    state.api.seen.filter((s) => s.method === "DELETE").length === 1,
    `${label}: exactly one DELETE`,
  );
}

/** Create, edit, conflict recovery, export, filters and typed delete in a real browser. */
async function checkWriteFlowsWith(browser: Browser, hasScript: boolean): Promise<void> {
  const env = await startEnv(0);
  env.api.stop();
  const state = startStatefulChecksApi();
  const server = await startSignedInConsole({
    apiUrl: state.api.url,
    ownerEmail: env.ownerEmail,
    adminToken: ADMIN_TOKEN,
  });
  await env.console.close();
  const local: Env = { ...env, console: server, api: state.api };
  const label = hasScript ? "JavaScript on" : "JavaScript off";
  const violations: string[] = [];
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    javaScriptEnabled: hasScript,
  });
  const page = await newPage(context, violations);
  try {
    await signIn(page, local);
    await createEach(page, server.base, state, label);
    await editAndConflict(page, server.base, state, label);
    await exportAndFilter(page, server.base, label);
    await typedDelete(page, server.base, state, label);
    assert(violations.length === 0, `${label}: CSP violations ${violations.join(" | ")}`);
    ok(
      `Check writes, ${label}: created ${CREATE_CASES.map((c) => c.type).join("/")}, edit kept the stored header and body, 412 kept input and Reload reopened the editor, redacted no-store shadowed export, composed filters, typed delete of " Checkout API " (wrong spacing sent no DELETE), 0 CSP violations`,
    );
  } finally {
    await context.close();
    await server.close();
    state.api.stop();
  }
}

async function runChecks(): Promise<void> {
  const env = await startEnv(0);
  const browser = await chromium.launch();
  try {
    await checkLayout(env, browser, 390, 844);
    await checkLayout(env, browser, 1280, 800);
    await checkAxe(env, browser);
    await checkInvites(env, browser);
    await checkTeamActions(env, browser);
    await checkFocus(env, browser);
    await checkNoScript(env, browser);
    await checkBusyScript(env, browser);
    await checkAccountNoScript(env, browser);
    await checkResetAndPassword(env, browser);
    await checkLongEmail(browser);
    await checkScreensWith(browser, true);
    await checkScreensWith(browser, false);
    await checkWriteFlowsWith(browser, true);
    await checkWriteFlowsWith(browser, false);
    // A console of its own: each check signs in with a fixture recovery code.
    const shellEnv = await startEnv(0);
    try {
      await checkEmail(shellEnv, browser);
      await checkNotFound(shellEnv, browser);
      await checkGaps(shellEnv, browser);
      await checkLinks(shellEnv, browser);
    } finally {
      await shellEnv.console.close();
      shellEnv.api.stop();
    }
    // A console of its own: the first one has used up its fixture recovery codes.
    const failureEnv = await startEnv(0);
    try {
      await checkFailureKinds(failureEnv, browser);
    } finally {
      await failureEnv.console.close();
      failureEnv.api.stop();
    }
  } finally {
    await browser.close();
    await env.console.close();
    env.api.stop();
  }
}

async function serve(): Promise<void> {
  const env = await startEnv(SERVE_WAIT_MS);
  console.log(`url: ${env.console.base}`);
  console.log(`sign in: ${env.ownerEmail} / ${OWNER_PASSWORD}`);
  console.log(`fixture recovery codes: ${env.console.recoveryCodes.join(" ")}`);
  console.log(`busy page: ${env.console.base}/__test/states/busy (waits ${SERVE_WAIT_MS} ms)`);
  setInterval(() => {
    console.log(`recorder: ${JSON.stringify(env.recorder.actions)}`);
  }, 5000);
}

if (process.argv.includes("--serve")) {
  await serve();
} else {
  try {
    await runChecks();
  } catch (error) {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
  }
}
