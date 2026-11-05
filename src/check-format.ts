import type { AdminCheckView } from "@lorenzh/pulse-contract";

/**
 * A percentage for display, never rounded up: `99.995` must not read `100.00 %`. `100` exactly
 * prints `100 %`; `null` means no results.
 */
export function formatPercent(value: number | null): string {
  if (value === null) return "No results";
  if (value === 100) return "100 %";
  // The 1e-6 keeps a float like 12.34 * 100 = 1233.9999 from losing a hundredth.
  const hundredths = Math.min(Math.floor(value * 100 + 1e-6), 9999);
  return `${(hundredths / 100).toFixed(2)} %`;
}

/** The error budget with one decimal. The sign comes from the raw value, not the rounded text. */
export function budgetText(budgetRemaining: number): string {
  const text = `${budgetRemaining.toFixed(1)} %`;
  return budgetRemaining >= 0
    ? `${text} of the error budget left`
    : `Error budget exceeded (${text})`;
}

/** `YYYY-MM-DD HH:MM:SS UTC` of epoch ms, or `No results yet` for `null`. */
export function utcTime(epochMs: number | null): string {
  if (epochMs === null) return "No results yet";
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/** What a check looks at, as the list shows it. */
export function targetText(check: AdminCheckView): string {
  switch (check.type) {
    case undefined:
    case "http":
      return check.url;
    case "tls":
    case "tcp":
      return `${check.host}:${check.port}`;
    case "dns":
      return `${check.dnsName} ${check.recordType}`;
    case "domain":
      return check.domain;
    case "heartbeat":
      return "Heartbeat";
    default: {
      const never: never = check;
      return never;
    }
  }
}
