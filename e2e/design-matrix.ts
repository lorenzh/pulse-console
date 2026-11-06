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
  checks: ["Check", "Target", "State", "Actions"],
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
  const cell = 'table.checks tr:has(td code:text-is("long-url")) td.actions-cell';
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

/** R1 at 1280: the Checks box does not scroll, its table and last action end inside it. */
export async function assertChecksFit(page: Page, label: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const got = await page.locator("main .table-scroll:has(table.checks)").evaluate((box) => {
    box.scrollLeft = 0;
    const table = box.querySelector("table.checks");
    const links = Array.from(box.querySelectorAll("td.actions-cell a"));
    const last = links.reduce<Element | undefined>(
      (best, a) =>
        best === undefined || a.getBoundingClientRect().right > best.getBoundingClientRect().right
          ? a
          : best,
      undefined,
    );
    const td = last?.closest("td");
    return {
      overflowX: getComputedStyle(box).overflowX,
      scrollWidth: box.scrollWidth,
      clientWidth: box.clientWidth,
      boxRight: box.getBoundingClientRect().right,
      tableRight: table?.getBoundingClientRect().right ?? Number.NaN,
      linkText: last?.textContent ?? "",
      linkRight: last?.getBoundingClientRect().right ?? Number.NaN,
      linkFont: last === undefined ? "" : getComputedStyle(last).fontSize,
      cellEnd:
        td === null || td === undefined
          ? Number.NaN
          : td.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(td).paddingRight),
    };
  });
  check(got.overflowX === "auto", `${label}: Checks box overflow-x ${got.overflowX}, want auto`);
  check(
    got.scrollWidth <= got.clientWidth,
    `${label}: Checks box scrollWidth ${got.scrollWidth} > ${got.clientWidth}`,
  );
  check(
    got.tableRight <= got.boxRight + 0.5,
    `${label}: Checks table right ${got.tableRight} > box right ${got.boxRight} + 0.5`,
  );
  check(
    got.linkRight <= got.cellEnd + 0.5,
    `${label}: action "${got.linkText}" right ${got.linkRight} > cell content right ${got.cellEnd} + 0.5`,
  );
  near(got.linkFont, 15, 0.01, `${label}: action "${got.linkText}" font size`);
}

type Unit = { text: string; lines: number };
type WordsReport = { texts: string[]; units: Unit[]; nowrap: Measured[] };

/** Splits every visible td text node into units (non-space runs, also after - and /). */
function measureWords(table: Element): WordsReport {
  const tops = (range: Range): number => {
    const set = new Set<number>();
    for (const r of Array.from(range.getClientRects())) {
      if (r.width > 0) set.add(Math.round(r.top));
    }
    return set.size;
  };
  // Units are runs of non-space characters, each also ended after "-" or "/".
  const spansOf = (text: string): [number, number][] => {
    const spans: [number, number][] = [];
    let start = -1;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charAt(i);
      const isSpace = /\s/.test(ch);
      if (start < 0 && !isSpace) start = i;
      if (start >= 0 && isSpace) {
        spans.push([start, i]);
        start = -1;
      } else if (start >= 0 && (ch === "-" || ch === "/")) {
        spans.push([start, i + 1]);
        start = -1;
      }
    }
    if (start >= 0) spans.push([start, text.length]);
    return spans;
  };
  const texts: string[] = [];
  const units: Unit[] = [];
  const cells = Array.from(table.querySelectorAll("td"));
  for (const td of cells) {
    texts.push((td.textContent ?? "").trim());
    for (const el of Array.from(td.querySelectorAll("*")))
      texts.push((el.textContent ?? "").trim());
    const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.parentElement?.closest(".visually-hidden")) continue;
      const text = node.textContent ?? "";
      for (const span of spansOf(text)) {
        const range = document.createRange();
        range.setStart(node, span[0]);
        range.setEnd(node, span[1]);
        units.push({ text: text.slice(span[0], span[1]), lines: tops(range) });
      }
    }
  }
  const nowrap = Array.from(table.querySelectorAll("td.cell-nowrap")).map((td) => {
    const range = document.createRange();
    range.selectNodeContents(td);
    return { text: (td.textContent ?? "").trim(), lines: tops(range) };
  });
  return { texts, units, nowrap };
}

/** R2: the required texts exist in a td or its descendant, and no word breaks inside. */
export async function assertWordsIntact(
  page: Page,
  tableSelector: string,
  required: readonly (string | RegExp)[],
  label: string,
): Promise<number> {
  await page.evaluate(() => document.fonts.ready);
  const reports: WordsReport[] = [];
  for (const table of await page.locator(tableSelector).all()) {
    reports.push(await table.evaluate(measureWords));
  }
  check(reports.length > 0, `${label}: no table ${tableSelector}`);
  const texts = reports.flatMap((r) => r.texts);
  for (const want of required) {
    const isFound = texts.some((t) =>
      typeof want === "string" ? t === want : new RegExp(`^(?:${want.source})$`).test(t),
    );
    check(isFound, `${label}: no cell text ${String(want)} in ${tableSelector}`);
  }
  const units = reports.flatMap((r) => r.units);
  for (const unit of units) {
    check(unit.lines === 1, `${label}: unit "${unit.text}" has ${unit.lines} lines, want 1`);
  }
  for (const cell of reports.flatMap((r) => r.nowrap)) {
    check(cell.lines === 1, `${label}: nowrap cell "${cell.text}" has ${cell.lines} lines, want 1`);
  }
  return units.length;
}

/** R1 fallback: the unbroken name and id keep their text and end inside the cell, cut. */
export async function assertUnbrokenRow(
  page: Page,
  name: string,
  id: string,
  label: string,
): Promise<void> {
  const row = page.locator(`table.checks tr:has(td code:text-is("${id}"))`);
  check((await row.count()) === 1, `${label}: no Checks row with code ${id}`);
  const got = await row
    .locator("td")
    .first()
    .evaluate((td) => {
      const end =
        td.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(td).paddingRight);
      return [".cell-title", ".cell-sub"].map((sel) => {
        const el = td.querySelector(sel);
        if (el === null)
          return { sel, missing: true, overflowX: "", ellipsis: "", sw: 0, cw: 0, right: 0, end };
        const style = getComputedStyle(el);
        return {
          sel,
          missing: false,
          overflowX: style.overflowX,
          ellipsis: style.textOverflow,
          sw: el.scrollWidth,
          cw: el.clientWidth,
          right: el.getBoundingClientRect().right,
          end,
        };
      });
    });
  for (const g of got) {
    check(!g.missing, `${label}: unbroken row has no ${g.sel}`);
    check(g.overflowX === "hidden", `${label}: unbroken ${g.sel} overflow-x ${g.overflowX}`);
    check(g.ellipsis === "ellipsis", `${label}: unbroken ${g.sel} text-overflow ${g.ellipsis}`);
    check(g.sw > g.cw, `${label}: unbroken ${g.sel} scrollWidth ${g.sw} <= clientWidth ${g.cw}`);
    check(g.right <= g.end + 0.5, `${label}: unbroken ${g.sel} right ${g.right} > ${g.end} + 0.5`);
  }
  const title = await row.locator(".cell-title").textContent();
  const code = await row.locator("td code").first().textContent();
  check(title === name, `${label}: unbroken .cell-title text ${title?.length} chars, want ${name}`);
  check(code === id, `${label}: unbroken code text ${code}, want ${id}`);
}

/** R9: the owner row shows On/Off and —, no 2FA: text; action cells have only the row divider. */
export async function assertTeamTable(page: Page, ownerName: string, label: string) {
  const table = page.locator('[aria-label="Team table"] table');
  const owner = table.locator(`tr:has(td:text-is("${ownerName}"))`);
  check((await owner.count()) === 1, `${label}: no Team row for ${ownerName}`);
  const twoFactor = ((await owner.locator("td").nth(3).textContent()) ?? "").trim();
  check(/^(On|Off)$/.test(twoFactor), `${label}: owner 2FA cell "${twoFactor}", want On or Off`);
  const empty = (
    (await owner.locator("td.actions-cell .cell-empty [aria-hidden]").textContent()) ?? ""
  ).trim();
  check(empty === "—", `${label}: owner action cell "${empty}", want —`);
  const prefixed = await page
    .locator("main td")
    .evaluateAll((tds) =>
      tds.map((td) => (td.textContent ?? "").trim()).filter((t) => t.startsWith("2FA:")),
    );
  check(prefixed.length === 0, `${label}: cells start with 2FA: ${JSON.stringify(prefixed)}`);
  const bad = await page.locator("main td.actions-cell").evaluateAll((cells) =>
    cells.flatMap((td) => {
      const out: string[] = [];
      const cs = getComputedStyle(td);
      const first = td.parentElement?.querySelector("td");
      const rowBottom =
        first === null || first === undefined ? "" : getComputedStyle(first).borderBottomWidth;
      const text = (td.textContent ?? "").trim();
      if (cs.borderLeftWidth !== "0px" || cs.borderRightWidth !== "0px")
        out.push(`"${text}" cell side borders ${cs.borderLeftWidth}/${cs.borderRightWidth}`);
      if (cs.borderBottomWidth !== rowBottom)
        out.push(`"${text}" bottom ${cs.borderBottomWidth}, row ${rowBottom}`);
      for (const el of Array.from(td.querySelectorAll("*"))) {
        const s = getComputedStyle(el);
        const widths = [
          s.borderTopWidth,
          s.borderRightWidth,
          s.borderBottomWidth,
          s.borderLeftWidth,
        ];
        if (widths.some((w) => w !== "0px"))
          out.push(`"${text}" ${el.tagName} border ${widths.join(" ")}`);
      }
      const start = td.querySelector("a, .cell-empty");
      const left =
        td.getBoundingClientRect().left +
        Number.parseFloat(cs.paddingLeft) +
        Number.parseFloat(cs.borderLeftWidth);
      const at = start?.getBoundingClientRect().left;
      if (at === undefined || Math.abs(at - left) > 1)
        out.push(`"${text}" first action left ${at}, content left ${left}`);
      return out;
    }),
  );
  check(bad.length === 0, `${label}: Team action cells ${bad.join(" | ")}`);
}

const RECOVERY_CODE = /^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/;

/** R3: ten codes of 39 characters, each on 1 line, unclipped, inside the panel content box. */
export async function assertRecoveryCodes(page: Page, label: string): Promise<string[]> {
  await page.evaluate(() => document.fonts.ready);
  const codes = await page.locator("#recovery-codes li code").evaluateAll((els) =>
    els.map((el) => {
      const panel = el.closest(".plain-panel");
      const r = el.getBoundingClientRect();
      const tops = new Set<number>();
      const range = document.createRange();
      range.selectNodeContents(el);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width > 0) tops.add(Math.round(rect.top));
      }
      let inside = "no .plain-panel";
      if (panel !== null) {
        const p = panel.getBoundingClientRect();
        const s = getComputedStyle(panel);
        const left =
          p.left + Number.parseFloat(s.paddingLeft) + Number.parseFloat(s.borderLeftWidth);
        const right =
          p.right - Number.parseFloat(s.paddingRight) - Number.parseFloat(s.borderRightWidth);
        inside =
          r.left >= left - 0.5 && r.right <= right + 0.5
            ? ""
            : `rect ${r.left}-${r.right} outside content ${left}-${right}`;
      }
      return {
        text: el.textContent ?? "",
        lines: tops.size,
        scroll: el.scrollWidth,
        client: el.clientWidth,
        inside,
      };
    }),
  );
  check(codes.length === 10, `${label}: ${codes.length} recovery codes, want 10`);
  for (const code of codes) {
    check(RECOVERY_CODE.test(code.text), `${label}: code "${code.text}" has the wrong format`);
    check(code.lines === 1, `${label}: code "${code.text}" has ${code.lines} lines, want 1`);
    check(
      code.scroll <= code.client,
      `${label}: code "${code.text}" scrollWidth ${code.scroll} > ${code.client}`,
    );
    check(code.inside === "", `${label}: code "${code.text}" ${code.inside}`);
  }
  await assertNoSidewaysScroll(page, label);
  return codes.map((c) => c.text);
}

/** R4 literals, written from the spec. */
export const PRESET_CARDS = [
  ["read", "Reads the checks and their configuration. Changes nothing."],
  ["checks", "Reads checks and creates, changes and deletes them."],
  ["incidents", "Reads checks and posts incidents."],
  ["full", "Reads and changes checks and posts incidents."],
] as const;

export const PRESET_NOTE =
  "Manage checks, Post incidents and Full access can also create, rotate and revoke tokens with the same or fewer scopes, and read the audit log.";

type CardGeometry = {
  radios: number;
  value: string;
  description: string;
  width: number;
  height: number;
  gap: number;
  centers: number;
  inside: boolean;
  checked: boolean;
  disabled: boolean;
};

/** R4 on /tokens/new: four cards in order, literal texts, radio geometry and native behavior. */
export async function assertPresetCards(page: Page, label: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const cards: CardGeometry[] = await page.locator("label.choice.option-card").evaluateAll((els) =>
    els.map((card) => {
      const radios = card.querySelectorAll('input[name="preset"]');
      const radio = radios[0];
      const title = card.querySelector(".choice-title");
      const hint = card.querySelector(".choice-text small.hint");
      const c = card.getBoundingClientRect();
      const i = radio?.getBoundingClientRect();
      const t = title?.getBoundingClientRect();
      return {
        radios: radios.length,
        value: radio?.getAttribute("value") ?? "",
        description: (hint?.textContent ?? "").trim(),
        width: i?.width ?? 0,
        height: i?.height ?? 0,
        gap: i === undefined || t === undefined ? -1 : t.left - i.right,
        centers:
          i === undefined || t === undefined
            ? 99
            : Math.abs(i.top + i.height / 2 - (t.top + t.height / 2)),
        inside:
          i !== undefined &&
          i.left >= c.left &&
          i.right <= c.right &&
          i.top >= c.top &&
          i.bottom <= c.bottom,
        checked: radio instanceof HTMLInputElement && radio.checked,
        disabled: radio instanceof HTMLInputElement && radio.disabled,
      };
    }),
  );
  check(cards.length === 4, `${label}: ${cards.length} option cards, want 4`);
  PRESET_CARDS.forEach(([id, text], n) => {
    const card = cards[n];
    check(card !== undefined, `${label}: card ${n + 1} missing`);
    if (card === undefined) return;
    check(card.radios === 1, `${label}: card ${id} has ${card.radios} radios, want 1`);
    check(card.value === id, `${label}: card ${n + 1} is "${card.value}", want ${id}`);
    check(card.description === text, `${label}: card ${id} text "${card.description}"`);
    check(
      Math.abs(card.width - 18) <= 0.5 && Math.abs(card.height - 18) <= 0.5,
      `${label}: card ${id} radio ${card.width}x${card.height}`,
    );
    check(Math.abs(card.gap - 12) <= 1, `${label}: card ${id} title gap ${card.gap}`);
    check(card.centers <= 2, `${label}: card ${id} radio center offset ${card.centers}`);
    check(card.inside, `${label}: card ${id} radio outside its card`);
    check(!card.checked, `${label}: card ${id} checked on load`);
  });
  const note = (await page.locator("#preset-note").textContent())?.trim();
  check(note === PRESET_NOTE, `${label}: preset note "${note}"`);
  const enabled = cards.filter((c) => !c.disabled).map((c) => c.value);
  const [first, second] = enabled;
  if (first === undefined || second === undefined) return;
  await page
    .locator("label.choice.option-card", { has: page.locator(`input[value="${first}"]`) })
    .locator("small.hint")
    .first()
    .click();
  check(
    await page.locator(`input[name="preset"][value="${first}"]`).isChecked(),
    `${label}: a click on the ${first} description checks its radio`,
  );
  await page.locator(`input[name="preset"][value="${first}"]`).focus();
  await page.keyboard.press("ArrowDown");
  check(
    await page.locator(`input[name="preset"][value="${second}"]`).isChecked(),
    `${label}: ArrowDown from ${first} checks ${second}`,
  );
}

type Box = { left: number; width: number; contentLeft: number; contentWidth: number };

function boxOf(page: Page, selector: string): Promise<Box | undefined> {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const form = el.closest("form");
      if (!form) return undefined;
      const r = el.getBoundingClientRect();
      const f = form.getBoundingClientRect();
      const s = getComputedStyle(form);
      const pl = Number.parseFloat(s.paddingLeft) + Number.parseFloat(s.borderLeftWidth);
      const pr = Number.parseFloat(s.paddingRight) + Number.parseFloat(s.borderRightWidth);
      return {
        left: r.left,
        width: r.width,
        contentLeft: f.left + pl,
        contentWidth: f.width - pl - pr,
      };
    });
}

/** R6 on /checks/edit?id=web: Save check keeps its width, narrow and medium fields are capped. */
export async function assertEditorWidths(page: Page, width: number, label: string): Promise<void> {
  const save = await boxOf(page, 'button[type="submit"]:has-text("Save check")');
  const interval = await boxOf(page, 'input[name="interval_ms"]');
  const name = await boxOf(page, 'input[name="name"]');
  check(save !== undefined && interval !== undefined && name !== undefined, `${label}: fields`);
  if (save === undefined || interval === undefined || name === undefined) return;
  if (width === 1280) {
    check(
      save.width < 0.5 * save.contentWidth,
      `${label}: Save check width ${save.width}, form content ${save.contentWidth}`,
    );
    check(
      Math.abs(save.left - save.contentLeft) <= 1,
      `${label}: Save check left ${save.left}, form content left ${save.contentLeft}`,
    );
    check(interval.width <= 192.5, `${label}: interval_ms width ${interval.width}`);
    check(name.width <= 384.5, `${label}: name width ${name.width}`);
  }
  for (const [field, box] of [
    ["interval_ms", interval],
    ["name", name],
  ] as const) {
    check(
      box.width <= box.contentWidth + 0.5,
      `${label}: ${field} width ${box.width} > form ${box.contentWidth}`,
    );
  }
}

/** R6: a Copy button is small, 36px high with a 44px hit area, and left aligned. */
export async function assertCopyButton(page: Page, selector: string, label: string): Promise<void> {
  const got = await page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const parent = el.parentElement;
    const p = parent?.getBoundingClientRect();
    const ps = parent === null ? undefined : getComputedStyle(parent);
    const left =
      p === undefined || ps === undefined
        ? Number.NaN
        : p.left + Number.parseFloat(ps.paddingLeft) + Number.parseFloat(ps.borderLeftWidth);
    return {
      isSmall: el.classList.contains("small"),
      minHeight: getComputedStyle(el).minHeight,
      after: getComputedStyle(el, "::after").top,
      width: r.width,
      left: r.left,
      parentLeft: left,
    };
  });
  check(got.isSmall, `${label}: Copy has no class small`);
  check(got.minHeight === "36px", `${label}: Copy min-height ${got.minHeight}`);
  check(got.width < 200, `${label}: Copy width ${got.width}`);
  check(
    Math.abs(got.left - got.parentLeft) <= 1,
    `${label}: Copy left ${got.left}, parent content left ${got.parentLeft}`,
  );
  check(got.after === "-4px", `${label}: Copy ::after top ${got.after}`);
}

/** R5 `--rule` colors from `src/styles.ts`, written here as literals. */
const RULE: Readonly<Record<Scheme, string>> = {
  light: "rgb(223, 215, 212)",
  dark: "rgb(62, 48, 73)",
};

/** Browser 5: the sidebar border spans a long page and the Main nav stays in view. */
export async function assertSidebarSpans(page: Page, scheme: Scheme, label: string) {
  const read = () =>
    page.evaluate(() => {
      const bar = document.querySelector("header.sidebar");
      const nav = document.querySelector('nav[aria-label="Main"]');
      if (bar === null || nav === null) return undefined;
      const r = bar.getBoundingClientRect();
      const n = nav.getBoundingClientRect();
      const s = getComputedStyle(bar);
      return {
        top: r.top + scrollY,
        bottom: r.bottom + scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        border: `${s.borderRightWidth} ${s.borderRightStyle} ${s.borderRightColor}`,
        isNavInside: n.top >= -0.5 && n.bottom <= innerHeight + 0.5 && n.height > 0,
      };
    });
  await page.evaluate(() => window.scrollTo(0, 0));
  const first = await read();
  check(first !== undefined, `${label}: no header.sidebar or Main nav`);
  if (first === undefined) return;
  check(first.scrollHeight >= 1200, `${label}: page scrollHeight ${first.scrollHeight} < 1200`);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const second = await read();
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const [where, got] of [
    ["top", first],
    ["bottom", second],
  ] as const) {
    check(got !== undefined, `${label} at ${where}: no sidebar`);
    if (got === undefined) return;
    check(Math.abs(got.top) <= 0.5, `${label} at ${where}: sidebar top ${got.top}`);
    check(
      got.bottom >= got.scrollHeight - 1,
      `${label} at ${where}: sidebar bottom ${got.bottom} < scrollHeight ${got.scrollHeight}`,
    );
    const want = `1px solid ${RULE[scheme]}`;
    check(got.border === want, `${label} at ${where}: sidebar border ${got.border}, want ${want}`);
  }
  check(second?.isNavInside === true, `${label}: Main nav outside the viewport after the scroll`);
}

/** Browser 6: the edge hints show only where the Main nav has hidden content. */
export async function assertNavEdges(page: Page, label: string): Promise<void> {
  const want: ReadonlyArray<readonly [string, number, string]> = [
    ["start", 0, "0/1"],
    ["middle", 0.5, "1/1"],
    ["end", 1, "1/0"],
  ];
  for (const [where, share, expected] of want) {
    const got = await page.evaluate(async (part) => {
      const nav = document.querySelector('nav[aria-label="Main"]');
      const start = document.querySelector(".nav-edge-start");
      const end = document.querySelector(".nav-edge-end");
      if (!(nav instanceof HTMLElement) || start === null || end === null) return "missing";
      nav.scrollLeft = (nav.scrollWidth - nav.clientWidth) * part;
      for (let i = 0; i < 2; i += 1) await new Promise((r) => requestAnimationFrame(r));
      const o = (el: Element) => Number(getComputedStyle(el).opacity);
      return `${o(start)}/${o(end)}`;
    }, share);
    check(got !== "missing", `${label}: missing .nav-edge or Main nav`);
    check(got === expected, `${label}: nav edges at ${where} ${got}, want ${expected}`);
  }
  await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Main"]');
    if (nav instanceof HTMLElement) nav.scrollLeft = 0;
  });
}

/** Browser 7: the phone account row is one compact row with both controls in view. */
export async function assertCompactAccount(
  page: Page,
  width: number,
  email: string,
  label: string,
): Promise<void> {
  const got = await page.evaluate(() => {
    const rect = (s: string) => document.querySelector(s)?.getBoundingClientRect();
    const foot = rect(".sidebar-foot");
    const header = rect("header.sidebar");
    const account = rect(".account");
    const link = [...document.querySelectorAll(".sidebar-foot a")]
      .find((a) => a.textContent?.trim() === "Account security")
      ?.getBoundingClientRect();
    const button = rect(".sidebar-foot button");
    const role = document.querySelector(".account-role");
    const tops = new Set<number>();
    if (role !== null) {
      const range = document.createRange();
      range.selectNodeContents(role);
      for (const r of Array.from(range.getClientRects())) {
        if (r.width > 0) tops.add(Math.round(r.top));
      }
    }
    if ([foot, header, account, link, button].some((r) => r === undefined)) return undefined;
    const center = (r: DOMRect | undefined) => (r === undefined ? 0 : r.top + r.height / 2);
    return {
      parts: [...document.querySelectorAll(".sidebar-inner > *, .sidebar-foot > *")]
        .map((e) => `${e.className} ${Math.round(e.getBoundingClientRect().height)}`)
        .join(", "),
      foot: foot?.height ?? 0,
      header: header?.height ?? 0,
      centers: [center(account), center(link), center(button)],
      edges: [link?.left ?? 0, link?.right ?? 0, button?.left ?? 0, button?.right ?? 0],
      text: document.querySelector(".account")?.textContent ?? "",
      roleLines: tops.size,
      isRoleVisible: role !== null && getComputedStyle(role).visibility === "visible",
    };
  });
  check(got !== undefined, `${label}: account row parts missing`);
  if (got === undefined) return;
  check(got.foot <= 56, `${label}: .sidebar-foot height ${got.foot} > 56 (${got.parts})`);
  check(got.header <= 240, `${label}: header.sidebar height ${got.header} > 240 (${got.parts})`);
  const spread = Math.max(...got.centers) - Math.min(...got.centers);
  check(spread <= 6, `${label}: account row centers ${got.centers.join(", ")} differ by ${spread}`);
  check(
    got.edges.every((x) => x >= -0.5 && x <= width + 0.5),
    `${label}: account controls ${got.edges.join(", ")} outside 0-${width}`,
  );
  for (const part of ["Signed in as", email, "Role: Owner"]) {
    check(got.text.includes(part), `${label}: account text "${got.text}" lacks ${part}`);
  }
  check(got.isRoleVisible && got.roleLines === 1, `${label}: role has ${got.roleLines} lines`);
}
