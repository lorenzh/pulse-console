/** The self-hosted font files: fixed routes, each mapped to one constant file name. */
export type FontFamily = "Space Grotesk" | "JetBrains Mono";
export type FontFile = {
  route: string;
  fileName: string;
  family: FontFamily;
  weight: number;
};

function font(fileName: string, family: FontFamily, weight: number): FontFile {
  return { route: `/fonts/${fileName}`, fileName, family, weight };
}

export const FONT_FILES: readonly FontFile[] = [
  font("space-grotesk-latin-400-normal.woff2", "Space Grotesk", 400),
  font("space-grotesk-latin-500-normal.woff2", "Space Grotesk", 500),
  font("space-grotesk-latin-600-normal.woff2", "Space Grotesk", 600),
  font("space-grotesk-latin-700-normal.woff2", "Space Grotesk", 700),
  font("jetbrains-mono-latin-400-normal.woff2", "JetBrains Mono", 400),
  font("jetbrains-mono-latin-500-normal.woff2", "JetBrains Mono", 500),
  font("jetbrains-mono-latin-600-normal.woff2", "JetBrains Mono", 600),
];

/** A font file could not be read when the server was created. */
export class FontLoadError extends Error {
  override name = "FontLoadError";
}

/** Reads every font once; `readFile` gets the file URL under `assets/fonts/`. */
export function loadFonts(readFile: (url: URL) => Uint8Array): ReadonlyMap<string, Uint8Array> {
  const fonts = new Map<string, Uint8Array>();
  for (const file of FONT_FILES) {
    try {
      fonts.set(file.route, readFile(new URL(`../assets/fonts/${file.fileName}`, import.meta.url)));
    } catch (err) {
      throw new FontLoadError(`cannot read font ${file.fileName}`, { cause: err });
    }
  }
  return fonts;
}
