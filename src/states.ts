import { escapeHtml } from "@lorenzh/pulse-kit";
import { type ApiFailure, apiFailureHeading, apiFailureText } from "./api-failure.ts";
import { paragraph } from "./html.ts";
import { type ConsoleRole, roleLabel } from "./roles.ts";

/** The notice above a re-rendered form whose form token was invalid. */
export const formExpiredNotice = "This form has expired. Your input is kept below. Send it again.";
/** The same notice for forms that keep no input (setup code, sign-in, sign-out). */
export const formExpiredResendNotice = "This form has expired. Send it again.";

function link(href: string, label: string): string {
  return `<p><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>\n`;
}

// Every state has a text heading, so status is never colour only.
function state(kind: string, heading: string, inner: string, role = ""): string {
  return `<section class="state state-${kind}"${role}>
<h2>${escapeHtml(heading)}</h2>
${inner}</section>
`;
}

/** Empty state: heading, text and one next step (an action link or a button form HTML). */
export function emptyState(view: {
  title: string;
  text: string;
  action: { href: string; label: string } | { html: string };
}): string {
  const action =
    "html" in view.action ? `${view.action.html}\n` : link(view.action.href, view.action.label);
  return state("empty", view.title, `${paragraph(view.text)}${action}`);
}

/** pulse-api cannot be reached, or sent an answer the console cannot use. */
export function apiUnavailableState(failure: ApiFailure, retryHref: string): string {
  return state(
    "error",
    apiFailureHeading(failure),
    `${paragraph(apiFailureText(failure))}${link(retryHref, "Retry")}`,
    ' role="alert"',
  );
}

/** The banner for an api 401. It never ends the console session. */
export function tokenRejectedBanner(): string {
  return state(
    "error",
    "pulse-api rejected the console token",
    paragraph(
      "Set a valid token in PULSE_CONSOLE_ADMIN_TOKEN or PULSE_CONSOLE_ADMIN_TOKEN_FILE and restart the console.",
    ),
    ' role="alert"',
  );
}

/** The 403 body. */
export function forbiddenState(view: { requiredRole: ConsoleRole; role: ConsoleRole }): string {
  return state(
    "error",
    "Access denied",
    paragraph(
      `This page needs the ${roleLabel(view.requiredRole)} role or higher. Your role is ${roleLabel(view.role)}.`,
    ),
  );
}

/** The 404 body. */
export function notFoundState(): string {
  return state("error", "Page not found", link("/", "Go to the overview"));
}

/** A 409 or 412 answer: the target changed since the form was opened. */
export function staleState(view: {
  status: 409 | 412;
  detail?: string | undefined;
  reloadHref: string;
}): string {
  return state(
    "warning",
    "Changed since you opened it",
    `${paragraph("Someone changed this since you opened it. Your input is kept below. Reload to see the current version, then apply your change again.")}${paragraph(view.detail)}${link(view.reloadHref, "Reload")}`,
    ' role="alert"',
  );
}

/** The 503 body when pulse-api reported its checks file as read-only. */
export function readOnlyState(): string {
  return state(
    "error",
    "The checks file is read-only",
    paragraph(
      "pulse-api cannot save changes until its checks file is writable. Your input is kept below.",
    ),
    ' role="alert"',
  );
}

/** The 409 body for a replayed form token. */
export function alreadySubmittedState(view: { reopenHref: string }): string {
  return state(
    "warning",
    "Already submitted",
    `${paragraph("This form was already sent. Nothing was changed by this request.")}${link(view.reopenHref, "Open the page again")}`,
  );
}
