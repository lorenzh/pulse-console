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

/**
 * The error budget with one decimal while some is left. An exceeded budget has no number: a
 * large negative value means nothing to a reader. Above 100 the api formula cannot answer.
 */
export function budgetText(budgetRemaining: number): string {
  if (budgetRemaining < 0) return "Error budget exceeded";
  if (budgetRemaining > 100) return "Error budget not available";
  return `${budgetRemaining.toFixed(1)} % of the error budget left`;
}

// Anchored and without a nested quantifier, so one test is linear in the reason length.
const LATENCY_REASON = /^latency (\d+\.\d+)ms/;

/**
 * A stored reason for display. An older probe wrote `latency <float>ms …`; that number is
 * rounded to whole ms. Every other reason, and a number that rounds past 2^53 - 1, stays as is.
 */
export function reasonText(reason: string): string {
  const match = LATENCY_REASON.exec(reason);
  if (match === null) return reason;
  const rounded = Math.round(Number(match[1]));
  if (!Number.isSafeInteger(rounded)) return reason;
  return `latency ${rounded}ms${reason.slice(match[0].length)}`;
}

/** `YYYY-MM-DD HH:MM:SS.mmm UTC` of epoch ms, for rows that can share a second. */
export function utcTimeMs(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)} UTC`;
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
