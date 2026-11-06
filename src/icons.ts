import type { NavId } from "./navigation.ts";
import type { CalloutKind } from "./states.ts";

// Presentation attributes, not style attributes: the CSP allows them. The CSS sets the color.
function icon(paths: string): string {
  return `<svg class="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

const CIRCLE = '<circle cx="8" cy="8" r="6.25"/>';

/** The 16 px glyph of a callout kind. */
export function calloutIcon(kind: CalloutKind): string {
  switch (kind) {
    case "info":
      return icon(`${CIRCLE}<path d="M8 7.25v4"/><path d="M8 4.75v.01"/>`);
    case "success":
      return icon(`${CIRCLE}<path d="M5.25 8.25l1.75 1.75 3.75-3.75"/>`);
    case "warning":
      return icon('<path d="M8 1.75l6.5 12h-13z"/><path d="M8 6.25v3.5"/><path d="M8 11.75v.01"/>');
    case "error":
      return icon(`${CIRCLE}<path d="M8 4.75v4"/><path d="M8 11.25v.01"/>`);
    case "neutral":
      return icon(CIRCLE);
    default: {
      const unknown: never = kind;
      return unknown;
    }
  }
}

/** The 16 px glyph before a nav entry. Every NavId has one. */
export function navIcon(id: NavId): string {
  switch (id) {
    case "overview":
      return icon(
        '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
      );
    case "checks":
      return icon('<path d="M1.75 8h3l1.5-4 3 8 1.5-4h3.5"/>');
    case "incidents":
      return icon('<path d="M8 1.75l6.5 12h-13z"/><path d="M8 6.25v3.5"/>');
    case "maintenance":
      return icon(
        '<path d="M10.5 2a3.5 3.5 0 0 0-3.2 4.9L2 12.2 3.8 14l5.3-5.3A3.5 3.5 0 0 0 14 5.5l-2 2-2-.5-.5-2 2-2z"/>',
      );
    case "tokens":
      return icon(
        '<circle cx="5.5" cy="10.5" r="3"/><path d="M7.6 8.4L14 2"/><path d="M11.5 4.5l2 2"/>',
      );
    case "probes":
      return icon(
        '<circle cx="8" cy="8" r="1.5"/><path d="M4.5 4.5a5 5 0 0 0 0 7"/><path d="M11.5 4.5a5 5 0 0 1 0 7"/>',
      );
    case "team":
      return icon(
        '<circle cx="6" cy="5.5" r="2.5"/><path d="M1.75 13.5a4.25 4.25 0 0 1 8.5 0"/><path d="M11 3.25a2.25 2.25 0 0 1 0 4.5"/><path d="M12.25 9.5a4 4 0 0 1 2 4"/>',
      );
    case "activity":
      return icon('<path d="M3 3.5h10"/><path d="M3 8h10"/><path d="M3 12.5h6"/>');
    case "system":
      return icon(
        '<rect x="2" y="2.5" width="12" height="4" rx="1"/><rect x="2" y="9.5" width="12" height="4" rx="1"/><path d="M4.5 4.5v.01"/><path d="M4.5 11.5v.01"/>',
      );
    default: {
      const unknown: never = id;
      return unknown;
    }
  }
}
