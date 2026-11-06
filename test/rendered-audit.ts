import { expect } from "bun:test";

/**
 * R8 audit: every element with `role="alert"` or `role="status"` is a callout, and the page
 * has no style attribute and no style element.
 */
export function expectCalloutsOnly(body: string): void {
  const tags = body.match(/<[a-z0-9]+\b[^>]*\srole="(?:alert|status)"[^>]*>/g) ?? [];
  for (const tag of tags) {
    expect(tag).toMatch(/^<section class="callout callout-(?:info|success|warning|error|neutral)"/);
  }
  expect(body).not.toContain("style=");
  expect(body).not.toContain("<style");
}
