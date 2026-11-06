// Page-level checks of the design matrix (browser checks 1, 3–7, 9, 11 and 12 of the design
// spec). Every expected value is a literal written here from the spec, never read from the
// console's stylesheet. `run.ts` drives them in light and dark at 1280 x 800 and 390 x 844.
import type { Page } from "playwright";

export class MatrixError extends Error {
  override name = "MatrixError";
}

export function check(condition: boolean, message: string): void {
  if (!condition) throw new MatrixError(message);
}

export type Scheme = "light" | "dark";

type Palette = {
  primary: [string, string];
  danger: [string, string, string];
  input: [string, string, string];
  focus: string;
  body: string;
  currentNav: string;
  warning: string;
  link: string;
  text: string;
  lead: string;
};

/** The computed colors of R1, per scheme. */
export const PALETTE: Readonly<Record<Scheme, Palette>> = {
  light: {
    primary: ["rgb(39, 27, 50)", "rgb(242, 238, 236)"],
    danger: ["rgb(164, 38, 44)", "rgb(164, 38, 44)", "rgb(242, 238, 236)"],
    input: ["rgb(250, 248, 247)", "rgb(147, 132, 126)", "rgb(39, 27, 50)"],
    focus: "rgb(138, 79, 159)",
    body: "rgb(242, 238, 236)",
    currentNav: "rgb(230, 219, 227)",
    warning: "rgb(244, 229, 200)",
    link: "rgb(122, 66, 144)",
    text: "rgb(39, 27, 50)",
    lead: "rgb(74, 63, 82)",
  },
  dark: {
    primary: ["rgb(223, 215, 212)", "rgb(39, 27, 50)"],
    danger: ["rgb(242, 167, 171)", "rgb(242, 167, 171)", "rgb(39, 27, 50)"],
    input: ["rgb(31, 21, 41)", "rgb(118, 104, 119)", "rgb(223, 215, 212)"],
    focus: "rgb(194, 155, 211)",
    body: "rgb(39, 27, 50)",
    currentNav: "rgb(61, 45, 72)",
    warning: "rgb(61, 48, 32)",
    link: "rgb(194, 155, 211)",
    text: "rgb(223, 215, 212)",
    lead: "rgb(201, 191, 196)",
  },
};

/** The seven R15 font routes. */
export const FONT_PATHS: readonly string[] = [
  "/fonts/space-grotesk-latin-400-normal.woff2",
  "/fonts/space-grotesk-latin-500-normal.woff2",
  "/fonts/space-grotesk-latin-600-normal.woff2",
  "/fonts/space-grotesk-latin-700-normal.woff2",
  "/fonts/jetbrains-mono-latin-400-normal.woff2",
  "/fonts/jetbrains-mono-latin-500-normal.woff2",
  "/fonts/jetbrains-mono-latin-600-normal.woff2",
];

export const FONT_BYTES_BOUND = 117684;

async function rest(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
}

function colors(page: Page, selector: string, props: readonly string[]): Promise<string[]> {
  return page
    .locator(selector)
    .first()
    .evaluate((el, names) => {
      const style = getComputedStyle(el);
      return names.map((n) => style.getPropertyValue(n));
    }, props);
}

function same(got: readonly string[], want: readonly string[], label: string): void {
  check(
    got.join(" | ") === want.join(" | "),
    `${label}: ${got.join(" | ")}, want ${want.join(" | ")}`,
  );
}

export async function assertPrimary(page: Page, selector: string, scheme: Scheme, label: string) {
  await rest(page);
  same(await colors(page, selector, ["background-color", "color"]), PALETTE[scheme].primary, label);
}

export async function assertDanger(page: Page, selector: string, scheme: Scheme, label: string) {
  await rest(page);
  const props = ["background-color", "border-top-color", "color"];
  same(await colors(page, selector, props), PALETTE[scheme].danger, label);
}

/** Base colors at rest, then the focus ring after focus(). */
export async function assertInput(page: Page, selector: string, scheme: Scheme, label: string) {
  await rest(page);
  const props = ["background-color", "border-top-color", "color"];
  same(await colors(page, selector, props), PALETTE[scheme].input, label);
  await page.locator(selector).first().focus();
  const ring = await colors(page, selector, ["outline-color", "outline-width", "outline-offset"]);
  same(ring, [PALETTE[scheme].focus, "2px", "3px"], `${label} focus`);
  await rest(page);
}

export async function assertOverviewColors(page: Page, scheme: Scheme): Promise<void> {
  await rest(page);
  same(await colors(page, "body", ["background-color"]), [PALETTE[scheme].body], "body");
  const current = '.sidebar nav [aria-current="page"]';
  same(
    await colors(page, current, ["background-color"]),
    [PALETTE[scheme].currentNav],
    "current nav",
  );
  same(await colors(page, current, ["color"]), [PALETTE[scheme].text], "current nav text");
  const checks = page.locator(".sidebar nav").getByRole("link", { name: "Checks", exact: true });
  const lead = await checks.evaluate((a) => getComputedStyle(a).color);
  check(lead === PALETTE[scheme].lead, `nav Checks: ${lead}`);
}

export async function assertLinkColor(page: Page, name: string, want: string, label: string) {
  await rest(page);
  const link = page.getByRole("link", { name, exact: true }).first();
  const color = await link.evaluate((a) => getComputedStyle(a).color);
  check(color === want, `${label}: ${color}, want ${want}`);
}

/** Check 3: the first radio of the edit form. */
export async function assertRadio(page: Page, label: string): Promise<void> {
  const geometry = await page.evaluate(() => {
    const input = document.querySelector('label.choice input[type="radio"]');
    const row = input?.closest("label");
    const text = row?.querySelector("span");
    const fieldset = row?.closest("fieldset");
    if (!input || !row || !text || !fieldset) return undefined;
    const i = input.getBoundingClientRect();
    const t = text.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return {
      width: i.width,
      height: i.height,
      gap: t.left - i.right,
      centers: Math.abs(i.top + i.height / 2 - (t.top + t.height / 2)),
      rowHeight: r.height,
      rowWidth: r.width,
      fieldsetWidth: fieldset.getBoundingClientRect().width,
    };
  });
  check(geometry !== undefined, `${label}: radio row`);
  if (geometry === undefined) return;
  check(
    Math.abs(geometry.width - 18) <= 0.5 && Math.abs(geometry.height - 18) <= 0.5,
    `${label}: radio ${geometry.width}x${geometry.height}`,
  );
  check(
    geometry.gap >= 0 && Math.abs(geometry.gap - 12) <= 1,
    `${label}: radio gap ${geometry.gap}`,
  );
  check(geometry.centers <= 2, `${label}: centers differ by ${geometry.centers}`);
  check(geometry.rowHeight >= 44, `${label}: row height ${geometry.rowHeight}`);
  check(geometry.rowWidth < geometry.fieldsetWidth, `${label}: row width ${geometry.rowWidth}`);
  const group = page.locator('label.choice input[type="radio"]').first();
  const name = await group.getAttribute("name");
  const radios = page.locator(`input[type="radio"][name="${name ?? ""}"]`);
  await radios.first().check();
  await radios.first().focus();
  await page.keyboard.press("ArrowDown");
  const second = await radios.nth(1).isChecked();
  check(second, `${label}: ArrowDown moves the checked radio`);
  await page.keyboard.press("ArrowUp");
  check(await radios.first().isChecked(), `${label}: ArrowUp moves it back`);
}

/** Check 4: no sideways scroll of the document, and no hidden overflow on html or body. */
export async function assertNoSidewaysScroll(page: Page, label: string): Promise<void> {
  const result = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    html: getComputedStyle(document.documentElement).overflowX,
    body: getComputedStyle(document.body).overflowX,
  }));
  check(
    result.scroll <= result.client,
    `${label}: scrollWidth ${result.scroll} > ${result.client}`,
  );
  check(
    result.html === "visible" && result.body === "visible",
    `${label}: overflow-x ${result.html}/${result.body}`,
  );
}

/** Check 4 on /checks at 390 px: the named box scrolls to Actions and shows its outline. */
export async function assertChecksBoxEnd(page: Page, label: string): Promise<void> {
  const box = page.getByRole("region", { name: "Checks table", exact: true });
  check((await box.getAttribute("tabindex")) === "0", `${label}: box tabindex`);
  check(
    await page.getByText("Scroll sideways to see all columns.", { exact: true }).isVisible(),
    `${label}: hint`,
  );
  await box.focus();
  for (let i = 0; i < 5; i += 1) await page.keyboard.press("ArrowRight");
  // Keyboard scrolling is animated; wait for it instead of reading mid-flight.
  await box.evaluate(
    (el) => new Promise((resolve) => setTimeout(resolve, el.scrollLeft > 0 ? 0 : 500)),
  );
  const dims = await box.evaluate(
    (el) => `${el.scrollLeft} ${el.scrollWidth} ${el.clientWidth} ${document.activeElement === el}`,
  );
  check(Number(dims.split(" ")[0]) > 0, `${label}: ArrowRight scrolls (${dims})`);
  await page.keyboard.press("End");
  // One ArrowRight scrolls 40 px; the nowrap Actions column makes the table wider than the
  // 1800 px that 5 + 40 presses reach at 390 px, so press until well past the end.
  for (let i = 0; i < 80; i += 1) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
  const seen = await box.evaluate((el) => {
    const head = Array.from(el.querySelectorAll("th")).find(
      (th) => th.textContent?.trim() === "Actions",
    );
    if (head === undefined) return { isInside: false, outline: "no header", at: "" };
    const b = el.getBoundingClientRect();
    const h = head.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      isInside: h.left >= b.left - 0.5 && h.right <= b.right + 0.5,
      outline: `${style.outlineStyle} ${style.outlineWidth}`,
      at: `${h.left}-${h.right} in ${b.left}-${b.right}, scrollLeft ${el.scrollLeft}`,
    };
  });
  check(seen.isInside, `${label}: Actions header inside the box (${seen.at})`);
  check(seen.outline === "solid 2px", `${label}: box outline ${seen.outline}`);
}

/** Check 4 on the overview at 390 px: the account line stays inside the viewport. */
export async function assertAccountVisible(page: Page, label: string): Promise<void> {
  for (const name of ["Account security", "Sign out"]) {
    const role = name === "Sign out" ? "button" : "link";
    const box = await page.getByRole(role, { name, exact: true }).first().boundingBox();
    check(box !== null && box.x >= 0 && box.x + box.width <= 390.5, `${label}: ${name} visible`);
  }
}

/** Check 5: the sidebar and top bar at 1280 px, the column switch at 720/719 and main padding at 390. */
export async function assertShellGeometry(page: Page, label: string): Promise<void> {
  const sizes = async () =>
    page.evaluate(() => ({
      sidebar: document.querySelector("header.sidebar")?.getBoundingClientRect().width ?? 0,
      topbar: document.querySelector(".topbar")?.getBoundingClientRect().height ?? 0,
      viewport: document.documentElement.clientWidth,
      padding: getComputedStyle(document.querySelector("main") ?? document.body).padding,
    }));
  await page.setViewportSize({ width: 1280, height: 800 });
  const wide = await sizes();
  check(Math.abs(wide.sidebar - 236) <= 1, `${label}: sidebar ${wide.sidebar}`);
  check(wide.topbar >= 64, `${label}: topbar ${wide.topbar}`);
  await page.setViewportSize({ width: 720, height: 800 });
  const column = await sizes();
  check(
    column.sidebar < column.viewport,
    `${label}: 720 px sidebar is a column (${column.sidebar})`,
  );
  await page.setViewportSize({ width: 719, height: 800 });
  const row = await sizes();
  check(Math.abs(row.sidebar - row.viewport) <= 0.5, `${label}: 719 px sidebar ${row.sidebar}`);
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = await sizes();
  check(phone.padding === "20px 16px 40px", `${label}: main padding ${phone.padding}`);
}

/** Check 6: dl.settings has two columns at 901 px and one at 900 px. */
export async function assertSettingsBreakpoint(page: Page, label: string): Promise<void> {
  const columns = () =>
    page
      .locator("dl.settings")
      .first()
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  await page.setViewportSize({ width: 901, height: 800 });
  const wide = await columns();
  await page.setViewportSize({ width: 900, height: 800 });
  const narrow = await columns();
  check(wide === 2 && narrow === 1, `${label}: settings columns ${wide} at 901, ${narrow} at 900`);
}

/** Check 7: one heading, the warning callout fill and a working overview link. */
export async function assertForbidden(page: Page, base: string, scheme: Scheme): Promise<void> {
  const answer = await page.goto(`${base}/team`);
  check(answer?.status() === 403, `403: status ${answer?.status()}`);
  const headings = page.getByRole("heading", { name: "Access denied" });
  check((await headings.count()) === 1, `403: ${await headings.count()} headings`);
  same(
    await colors(page, ".callout-warning", ["background-color"]),
    [PALETTE[scheme].warning],
    "403 callout",
  );
  await Promise.all([
    page.waitForURL(`${base}/`),
    page.getByRole("link", { name: "Go to the overview", exact: true }).click(),
  ]);
}

export async function assertNotFound(page: Page, base: string): Promise<void> {
  const answer = await page.goto(`${base}/does-not-exist`);
  check(answer?.status() === 404, `404: status ${answer?.status()}`);
  check((await page.locator("h1").count()) === 1, "404: one h1");
  check((await page.locator("h1").textContent())?.trim() === "Page not found", "404: h1 text");
  check((await page.locator(".callout-neutral").count()) === 1, "404: neutral callout");
}

/** Check 11: the hostile name renders as text; no element is created and no dialog opens. */
export async function assertHostileText(page: Page, name: string, label: string): Promise<void> {
  check(
    (await page.getByText(name, { exact: false }).count()) >= 1,
    `${label}: hostile name as text`,
  );
  check((await page.locator("main img").count()) === 0, `${label}: no img element`);
}

type PlatformFont = { familyName: string; isCustomFont: boolean; glyphCount: number };

async function platformFonts(page: Page, selector: string): Promise<PlatformFont[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const doc = await cdp.send("DOM.getDocument");
    const node = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
    check(node.nodeId !== 0, `CDP: no ${selector}`);
    const result = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: node.nodeId });
    return result.fonts;
  } finally {
    await cdp.detach();
  }
}

/** Check 12: FontFace 700 loaded, h1 starts with Space Grotesk, CDP proves the custom fonts. */
export async function assertFontsUsed(page: Page, monoSelector: string | undefined, label: string) {
  await page.evaluate(() => document.fonts.ready);
  const state = await page.evaluate(() => ({
    hasBold: Array.from(document.fonts).some(
      (f) =>
        f.family.replaceAll('"', "") === "Space Grotesk" &&
        f.weight === "700" &&
        f.status === "loaded",
    ),
    family: getComputedStyle(document.querySelector("h1") ?? document.body).fontFamily,
  }));
  check(state.hasBold, `${label}: FontFace Space Grotesk 700 loaded`);
  check(state.family.startsWith('"Space Grotesk"'), `${label}: h1 family ${state.family}`);
  const title = await platformFonts(page, "h1");
  const sum = title.reduce((n, f) => n + f.glyphCount, 0);
  const grotesk = title.find((f) => f.familyName.startsWith("Space Grotesk") && f.isCustomFont);
  check(
    grotesk !== undefined && grotesk.glyphCount === sum,
    `${label}: h1 platform fonts ${JSON.stringify(title)}`,
  );
  if (monoSelector === undefined) return;
  const mono = await platformFonts(page, monoSelector);
  const jet = mono.find((f) => f.familyName.startsWith("JetBrains Mono") && f.isCustomFont);
  check(jet !== undefined, `${label}: ${monoSelector} platform fonts ${JSON.stringify(mono)}`);
}

/** The literal header lists of R4 (spec 777), in page order. */
export const HEADERS = {
  checks: ["Name", "Id", "Type", "Target", "Source", "State", "Last result", "Actions"],
  members: ["Name", "Email", "Role", "2FA", "Actions"],
  invites: ["Email", "Role", "Created by", "Expires", "State", "Actions"],
  sessions: ["Signed in", "Last used", ""],
  tokens: ["Name", "Id", "Access", "Source", "Created", "Last used", "State", "Actions"],
  probes: ["Name", "Id", "Source", "Created", "Last used", "State", "Actions"],
} as const;

/** The R3 computed sizes in px, worked out in the spec from the #774 formulas. */
export const TYPE_SCALE: Readonly<
  Record<number, { body: number; h1: number; h2: number; h1Line: number; h1Spacing: number }>
> = {
  1280: { body: 15, h1: 39.04, h2: 23.52, h1Line: 42.944, h1Spacing: -0.7808 },
  390: { body: 15, h1: 32, h2: 20, h1Line: 35.2, h1Spacing: -0.64 },
};

type Measured = { text: string; lines: number };

/**
 * The text and line count of each element: distinct rounded tops of the client rects wider
 * than 0 of a Range over each visible text node. `.visually-hidden` text is skipped, because
 * its 1 px clipped rect would count as a second line.
 */
function measureLines(elements: Element[]): Measured[] {
  return elements.map((el) => {
    const tops = new Set<number>();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.parentElement?.closest(".visually-hidden")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of Array.from(range.getClientRects())) {
        if (r.width > 0) tops.add(Math.round(r.top));
      }
    }
    return { text: (el.textContent ?? "").trim(), lines: tops.size };
  });
}

async function measure(page: Page, selector: string): Promise<Measured[]> {
  await page.evaluate(() => document.fonts.ready);
  return page.locator(selector).evaluateAll(measureLines);
}

/** R1: each table's headers equal the literal list; 1 line per entry, 0 for an empty one. */
export async function assertHeaderLines(
  page: Page,
  tableSelector: string,
  want: readonly string[],
  label: string,
): Promise<number> {
  const tables = await page.locator(tableSelector).count();
  check(tables > 0, `${label}: no table ${tableSelector}`);
  for (let i = 0; i < tables; i += 1) {
    const heads = await page.locator(tableSelector).nth(i).locator("th").evaluateAll(measureLines);
    const texts = heads.map((h) => h.text);
    check(
      texts.join("|") === want.join("|"),
      `${label}: headers ${JSON.stringify(texts)}, want ${JSON.stringify(want)}`,
    );
    want.forEach((text, k) => {
      const expected = text === "" ? 0 : 1;
      const got = heads[k]?.lines;
      check(got === expected, `${label}: header "${text}" has ${got} lines, want ${expected}`);
    });
  }
  return tables;
}

/** R2: every link in an action cell is 1 line; returns the labels it measured. */
export async function assertActionLines(
  page: Page,
  selector: string,
  label: string,
): Promise<string[]> {
  const links = await measure(page, selector);
  for (const link of links) {
    check(link.lines === 1, `${label}: action "${link.text}" has ${link.lines} lines, want 1`);
  }
  return links.map((l) => l.text);
}

/** R2 on /checks: the long-url row shows View, Edit, Export, Delete, each on 1 line. */
export async function assertChecksActions(page: Page, width: number, label: string) {
  const cell = 'table.checks tr:has(td:text-is("long-url")) td.actions-cell';
  const links = await measure(page, `${cell} a`);
  const want = ["View", "Edit", "Export", "Delete"];
  const got = links.map((l) => l.text);
  check(
    got.join("|") === want.join("|"),
    `${label}: long-url actions ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
  );
  await assertActionLines(page, `${cell} a`, `${label} long-url`);
  const [actions] = await measure(page, 'table.checks th:text-is("Actions")');
  check(actions?.lines === 1, `${label}: header "Actions" has ${actions?.lines} lines, want 1`);
  await assertHeaderLines(page, "table.checks", HEADERS.checks, label);
  if (width !== 390) return;
  const at = await page.locator(cell).evaluate((td) => {
    const box = td.closest(".table-scroll")?.getBoundingClientRect();
    const c = td.getBoundingClientRect();
    if (box === undefined) return "no box";
    const isInside = c.left >= box.left - 0.5 && c.right <= box.right + 0.5;
    return isInside ? "" : `${c.left}-${c.right} in ${box.left}-${box.right}`;
  });
  check(at === "", `${label}: long-url Actions cell outside the box (${at})`);
}

function near(got: string, want: number, tolerance: number, label: string): void {
  const value = Number.parseFloat(got);
  check(Math.abs(value - want) <= tolerance, `${label} ${got}, want ${want} ± ${tolerance}`);
}

/** R3: body, page title and the #people-heading section heading on /team. */
export async function assertTypeScale(page: Page, width: number, label: string): Promise<void> {
  const want = TYPE_SCALE[width];
  check(want !== undefined, `${label}: no type scale for ${width}`);
  if (want === undefined) return;
  const got = await page.evaluate(() => {
    const read = (selector: string) => {
      const el = document.querySelector(selector);
      if (el === null) return { fontSize: "none", lineHeight: "", letterSpacing: "", weight: "" };
      const s = getComputedStyle(el);
      return {
        fontSize: s.fontSize,
        lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing,
        weight: s.fontWeight,
      };
    };
    return { body: read("body"), h1: read(".page-head h1"), h2: read("#people-heading") };
  });
  near(got.body.fontSize, want.body, 0.01, `${label}: body font size`);
  near(got.h1.fontSize, want.h1, 0.01, `${label}: h1 font size`);
  near(got.h2.fontSize, want.h2, 0.01, `${label}: h2 font size`);
  near(got.h1.lineHeight, want.h1Line, 0.05, `${label}: h1 line height`);
  near(got.h1.letterSpacing, want.h1Spacing, 0.05, `${label}: h1 letter spacing`);
  check(got.h1.weight === "700", `${label}: h1 weight ${got.h1.weight}, want 700`);
  check(got.h2.weight === "500", `${label}: h2 weight ${got.h2.weight}, want 500`);
}
