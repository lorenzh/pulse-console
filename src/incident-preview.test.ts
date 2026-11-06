import { describe, expect, test } from "bun:test";
import type { ManualIncident } from "@lorenzh/pulse-contract";
import { openPreview, previewSection, resolvedPreview } from "./incident-preview.ts";

const COMPONENTS = [
  { id: "web", name: "Web" },
  { id: "public-api", name: "Public API" },
];

function partTexts(html: string, part: string): string[] {
  const re = new RegExp(`data-part="${part}"[^>]*>([^<]*)<`, "g");
  return [...html.matchAll(re)].map((m) => m[1] ?? "");
}

describe("previewSection", () => {
  test("the spec's literal parts, escaped", () => {
    const html = previewSection(
      openPreview(
        {
          title: "<b>Checkout</b> slow",
          impact: "major",
          status: "investigating",
          components: ["web", "public-api"],
          message: "Line 1\nLine <2>",
        },
        COMPONENTS,
      ),
    );
    expect(partTexts(html, "impact")).toEqual(["Impact: major"]);
    expect(partTexts(html, "status")).toEqual(["Status: investigating"]);
    expect(partTexts(html, "title")).toEqual(["&lt;b&gt;Checkout&lt;/b&gt; slow"]);
    expect(partTexts(html, "affects")).toEqual(["Affects: Web, Public API"]);
    expect(partTexts(html, "update-status")).toEqual(["investigating"]);
    expect(partTexts(html, "message")).toEqual(["Line 1\nLine &lt;2&gt;"]);
    expect(partTexts(html, "time")).toEqual(["when published"]);
    expect(html).not.toContain("<b>");
    expect(html).toContain('<section aria-labelledby="preview-heading">');
    expect(html).toContain('<h2 id="preview-heading">Status page preview</h2>');
    expect(html).toContain('<div class="incident-preview" data-preview="open">');
    expect(html).not.toContain("aria-live");
    expect(html).not.toContain('data-part="affects" hidden');
  });

  test("no component hides affects; an unknown id shows the id", () => {
    const none = previewSection(
      openPreview(
        { title: "T", impact: "none", status: "identified", components: [], message: "m" },
        COMPONENTS,
      ),
    );
    expect(none).toContain('<p data-part="affects" hidden>Affects: </p>');
    const gone = previewSection(
      openPreview(
        { title: "T", impact: "none", status: "identified", components: ["db"], message: "m" },
        COMPONENTS,
      ),
    );
    expect(partTexts(gone, "affects")).toEqual(["Affects: db"]);
  });

  test("the resolved card shows every update oldest first, then the new one", () => {
    const incident: ManualIncident = {
      id: 4,
      title: " Slow",
      impact: "minor",
      componentIds: ["web"],
      visibility: "public",
      status: "monitoring",
      createdAt: 1793959200000,
      resolvedAt: null,
      updates: [
        { status: "investigating", message: "first", at: 1793959200000 },
        { status: "monitoring", message: "second", at: 1793962800000 },
      ],
    } as ManualIncident;
    const html = previewSection(resolvedPreview(incident, "Resolved.", COMPONENTS));
    expect(html).toContain('data-preview="resolved"');
    expect(partTexts(html, "status")).toEqual(["Status: resolved"]);
    expect(partTexts(html, "title")).toEqual([" Slow"]);
    expect(partTexts(html, "update-status")).toEqual(["investigating", "monitoring", "resolved"]);
    expect(partTexts(html, "message")).toEqual(["first", "second", "Resolved."]);
    expect(partTexts(html, "time").at(-1)).toBe("when published");
  });
});
