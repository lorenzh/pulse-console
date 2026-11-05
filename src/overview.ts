import type { CheckState } from "@lorenzh/pulse-contract";
import { escapeHtml } from "@lorenzh/pulse-kit";
import { NO_TOKEN_TEXT } from "./connection-test.ts";
import { paragraph } from "./html.ts";
import type { OverviewRead } from "./overview-read.ts";
import { apiUnavailableState, emptyState, tokenRejectedBanner } from "./states.ts";

/** The number of checks per state, and the total. */
export type CheckCounts = Record<CheckState, number> & { total: number };

/** Counts the states of one `/checks` answer. */
export function summarizeChecks(states: readonly CheckState[]): CheckCounts {
  const counts: CheckCounts = { down: 0, degraded: 0, unknown: 0, maintenance: 0, up: 0, total: 0 };
  for (const state of states) {
    counts[state] += 1;
    counts.total += 1;
  }
  return counts;
}

/**
 * The overall state: first match of down, degraded, unknown, maintenance, else up.
 * `undefined` for zero checks. Unlike contract `combineStates`, unknown ranks above up, so a
 * check without a result never reads as healthy.
 */
export function overallState(counts: CheckCounts): CheckState | undefined {
  if (counts.total === 0) {
    return undefined;
  }
  for (const state of ["down", "degraded", "unknown", "maintenance"] as const) {
    if (counts[state] > 0) {
      return state;
    }
  }
  return "up";
}

const OVERALL_TEXT: Record<CheckState, string> = {
  down: "Overall state: Down. At least one check is down.",
  degraded: "Overall state: Degraded. At least one check is degraded, none is down.",
  unknown: "Overall state: Unknown. At least one check has no result yet.",
  maintenance: "Overall state: Maintenance. Some checks are in maintenance, the others are up.",
  up: "Overall state: Up. All checks are up.",
};

const COUNT_ROWS = [
  ["Down", "down"],
  ["Degraded", "degraded"],
  ["Unknown", "unknown"],
  ["Maintenance", "maintenance"],
  ["Up", "up"],
  ["Total", "total"],
] as const;

function summary(counts: CheckCounts): string {
  const state = overallState(counts);
  if (state === undefined) {
    return emptyState({
      title: "No checks yet",
      text: "pulse-api has no active checks. Add a check in pulse-api, then reload this page.",
      action: { href: "/", label: "Reload" },
    });
  }
  const rows = COUNT_ROWS.map(
    ([label, key]) => `<li>${escapeHtml(label)}: ${String(counts[key])}</li>`,
  ).join("\n");
  return `${paragraph(OVERALL_TEXT[state])}<ul class="counts">
${rows}
</ul>
`;
}

/** The Overview main content and the banner for the shell slot (empty when none). */
export type OverviewView = { banner: string; body: string };

/** Renders the Overview for one read. `apiOrigin` is the origin of the saved API URL. */
export function overviewView(apiOrigin: string, read: OverviewRead): OverviewView {
  const origin = paragraph(`pulse-api: ${apiOrigin}`);
  switch (read.kind) {
    case "no-token":
      return {
        banner: "",
        body: `${origin}<section class="state state-error" role="alert">
<h2>${escapeHtml("pulse-api is not available")}</h2>
${paragraph(NO_TOKEN_TEXT)}</section>
`,
      };
    case "token-rejected":
      return { banner: tokenRejectedBanner(), body: origin };
    case "failed":
      return { banner: "", body: `${origin}${apiUnavailableState(read.failure, "/")}` };
    case "ok":
      return {
        banner: "",
        body: `${origin}${summary(summarizeChecks(read.checks.map((c) => c.state)))}`,
      };
    default: {
      const never: never = read;
      return never;
    }
  }
}
