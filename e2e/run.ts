// Browser checks of the console in Chromium: layout at 390 px and 1280 px, axe, keyboard focus,
// CSP and the busy button with and without JavaScript. `bun e2e/run.ts --serve` only starts the
// fixture console for a manual check and runs until stopped.
import { randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import type { ConsoleRole } from "../src/roles.ts";
import { checkWithState, emptyConfig, jsonReply, startFakeApi } from "../test/fake-api.ts";
import {
  type ConfirmTargetHolder,
  createFixtureRoutes,
  type Recorder,
} from "../test/fixture-routes.ts";
import {
  OWNER_EMAIL,
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

type Env = {
  console: SignedInConsole;
  api: ReturnType<typeof startFakeApi>;
  recorder: Recorder;
  target: ConfirmTargetHolder;
  role: { current: ConsoleRole };
  hold: { current: Promise<void> | undefined };
};

async function startEnv(waitMs: number): Promise<Env> {
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
  const server = await startSignedInConsole({
    apiUrl: api.url,
    adminToken: ADMIN_TOKEN,
    testRoutes: createFixtureRoutes({ recorder, target, wait }),
    roleOf: () => role.current,
  });
  return { console: server, api, recorder, target, role, hold };
}

async function signIn(page: Page, env: Env): Promise<void> {
  const base = env.console.base;
  await page.goto(`${base}/sign-in`);
  await page.fill('input[name="email"]', OWNER_EMAIL);
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
  assert(violations.length === 0, `CSP violations: ${violations.join(" | ")}`);
  await context.close();
  ok(`${width} x ${height}: sign-in, 4 Overview states, 403, Team and every fixture page fit`);
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
    await owner.goto(`${base}/account/recovery-codes`);
    await owner.fill('input[name="password"]', OWNER_PASSWORD);
    await owner.getByRole("button", { name: "Create new recovery codes" }).click();
    const codes = await owner.locator("#recovery-codes li").allTextContents();
    assert(codes.length === 10, "new recovery codes confirmation shows ten codes");
    await assertFits(owner, 390, "recovery codes");
    await owner.goto(`${base}/account/authenticator`);
    await owner.fill('input[name="password"]', OWNER_PASSWORD);
    await owner.getByRole("button", { name: "Replace authenticator", exact: true }).click();
    await owner.locator("#totp-secret").waitFor();
    await assertFits(owner, 390, "authenticator setup key");
    await other.fill('input[name="email"]', OWNER_EMAIL);
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

async function runChecks(): Promise<void> {
  const env = await startEnv(0);
  const browser = await chromium.launch();
  try {
    await checkLayout(env, browser, 390, 844);
    await checkLayout(env, browser, 1280, 800);
    await checkAxe(env, browser);
    await checkFocus(env, browser);
    await checkNoScript(env, browser);
    await checkBusyScript(env, browser);
    await checkAccountNoScript(env, browser);
  } finally {
    await browser.close();
    await env.console.close();
    env.api.stop();
  }
}

async function serve(): Promise<void> {
  const env = await startEnv(SERVE_WAIT_MS);
  console.log(`url: ${env.console.base}`);
  console.log(`sign in: ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
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
