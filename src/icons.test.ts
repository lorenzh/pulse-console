import { expect, test } from "bun:test";
import { calloutIcon, navIcon } from "./icons.ts";

const HEAD =
  '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor"';

test("every nav entry has its own 16 px icon without a style or data URI", () => {
  const ids = [
    "overview",
    "checks",
    "incidents",
    "maintenance",
    "tokens",
    "probes",
    "status-page",
    "notifications",
    "team",
    "activity",
    "system",
  ] as const;
  const icons = ids.map((id) => navIcon(id));
  for (const icon of icons) {
    expect(icon).toStartWith(HEAD);
    expect(icon).toEndWith("</svg>");
    expect(icon).not.toMatch(/style|data:/);
  }
  expect(new Set(icons).size).toBe(11);
});

test("every callout kind has its own icon", () => {
  const kinds = ["info", "success", "warning", "error", "neutral"] as const;
  const icons = kinds.map((kind) => calloutIcon(kind));
  for (const icon of icons) expect(icon).toStartWith(HEAD);
  expect(new Set(icons).size).toBe(5);
});
