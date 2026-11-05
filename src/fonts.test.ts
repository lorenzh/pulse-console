import { describe, expect, test } from "bun:test";
import { FontLoadError, loadFonts } from "./fonts.ts";

describe("loadFonts", () => {
  test("reads the seven fixed routes from assets/fonts", () => {
    const read: string[] = [];
    const fonts = loadFonts((url) => {
      read.push(url.pathname.split("/").slice(-3).join("/"));
      return new Uint8Array([read.length]);
    });
    expect([...fonts.keys()]).toEqual([
      "/fonts/space-grotesk-latin-400-normal.woff2",
      "/fonts/space-grotesk-latin-500-normal.woff2",
      "/fonts/space-grotesk-latin-600-normal.woff2",
      "/fonts/space-grotesk-latin-700-normal.woff2",
      "/fonts/jetbrains-mono-latin-400-normal.woff2",
      "/fonts/jetbrains-mono-latin-500-normal.woff2",
      "/fonts/jetbrains-mono-latin-600-normal.woff2",
    ]);
    expect(read[0]).toBe("assets/fonts/space-grotesk-latin-400-normal.woff2");
    expect(fonts.get("/fonts/jetbrains-mono-latin-600-normal.woff2")).toEqual(new Uint8Array([7]));
  });

  test("a missing file throws the named error", () => {
    const load = (): unknown =>
      loadFonts((url) => {
        if (url.pathname.endsWith("/jetbrains-mono-latin-600-normal.woff2")) {
          throw new Error("ENOENT");
        }
        return new Uint8Array(1);
      });
    expect(load).toThrow(FontLoadError);
    try {
      load();
    } catch (err) {
      expect(err instanceof Error ? err.name : "").toBe("FontLoadError");
    }
  });
});
