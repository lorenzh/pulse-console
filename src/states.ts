import { escapeHtml } from "@lorenzh/pulse-kit";
import {
  type ApiFailure,
  apiFailureHeading,
  apiFailureKind,
  apiFailureText,
} from "./api-failure.ts";
import { calloutIcon } from "./icons.ts";
import { type ConsoleRole, roleLabel } from "./roles.ts";

export type CalloutKind = "info" | "success" | "warning" | "error" | "neutral";

/** The notice above a re-rendered form whose form token was invalid. */
export const formExpiredNotice = "This form has expired. Your input is kept below. Send it again.";
/** The same notice for forms that keep no input (setup code, sign-in, sign-out). */
export const formExpiredResendNotice = "This form has expired. Send it again.";

// A local copy of html.ts `paragraph`: html.ts imports `callout`, so states.ts stays a leaf.
function paragraph(text: string | undefined): string {
  return text === undefined ? "" : `<p>${escapeHtml(text)}</p>\n`;
}

function link(href: string, label: string): string {
  return `<p><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>\n`;
}

/**
 * The one banner and notice renderer. `body` is HTML that the caller escaped. Every kind has an
 * icon and a text, so a status is never colour only.
 */
export function callout(view: {
  kind: CalloutKind;
  title?: string | undefined;
  body: string;
  role?: "alert" | "status" | undefined;
  id?: string | undefined;
  action?: { href: string; label: string } | undefined;
}): string {
  const role = view.role === undefined ? "" : ` role="${view.role}"`;
  const id = view.id === undefined ? "" : ` id="${escapeHtml(view.id)}"`;
  const title =
    view.title === undefined ? "" : `<h2 class="callout-title">${escapeHtml(view.title)}</h2>\n`;
  const action =
    view.action === undefined
      ? ""
      : `<a class="button secondary small" href="${escapeHtml(view.action.href)}">${escapeHtml(view.action.label)}</a>\n`;
  return `<section class="callout callout-${view.kind}"${role}${id}>
${calloutIcon(view.kind)}
<div class="callout-body">
${title}${view.body}${action}</div>
</section>
`;
}

/**
 * The `role="alert"` callout of one plain sentence: a warning for the form-expired notices,
 * an error for every other refusal. Nothing for undefined.
 */
export function alertCallout(text: string | undefined): string {
  if (text === undefined) return "";
  const isExpired = text === formExpiredNotice || text === formExpiredResendNotice;
  return callout({ kind: isExpired ? "warning" : "error", body: paragraph(text), role: "alert" });
}

/** Empty state: heading, text and at most one next step (an action link or a button form HTML). */
export function emptyState(view: {
  title: string;
  text: string;
  action?: { href: string; label: string } | { html: string } | undefined;
}): string {
  let action = "";
  if (view.action !== undefined) {
    action =
      "html" in view.action
        ? `${view.action.html}\n`
        : `<p><a class="button" href="${escapeHtml(view.action.href)}">${escapeHtml(view.action.label)}</a></p>\n`;
  }
  return `<section class="empty-state">
<h2>${escapeHtml(view.title)}</h2>
${paragraph(view.text)}${action}</section>
`;
}

/** pulse-api cannot be reached, or sent an answer the console cannot use. */
export function apiUnavailableState(failure: ApiFailure, retryHref: string): string {
  const kind = apiFailureKind(failure);
  const kindLine = paragraph(kind === undefined ? undefined : `Kind: ${kind}`);
  return callout({
    kind: "error",
    title: apiFailureHeading(failure),
    body: `${kindLine}${paragraph(apiFailureText(failure))}${link(retryHref, "Retry")}`,
    role: "alert",
  });
}

/** The banner for an api 401. It never ends the console session. */
export function tokenRejectedBanner(): string {
  return callout({
    kind: "error",
    title: "pulse-api rejected the console token",
    body: paragraph(
      "Set a valid token in PULSE_CONSOLE_ADMIN_TOKEN or PULSE_CONSOLE_ADMIN_TOKEN_FILE and restart the console.",
    ),
    role: "alert",
  });
}

/** A 403 whose reason is the target, not the actor's role. */
export type ForbiddenTarget = "owner-target" | "transfer-not-admin";

function forbiddenTargetText(target: ForbiddenTarget): string {
  switch (target) {
    case "owner-target":
      return "No one can change the owner account in the console.";
    case "transfer-not-admin":
      return "Only an admin can become the owner.";
    default: {
      const unknown: never = target;
      return unknown;
    }
  }
}

/** The 403 body: the role sentence, or the fixed text of a target denial. */
export function forbiddenState(
  view: { requiredRole: ConsoleRole; role: ConsoleRole } | { target: ForbiddenTarget },
): string {
  const text =
    "target" in view
      ? forbiddenTargetText(view.target)
      : `This page needs the ${roleLabel(view.requiredRole)} role or higher. Your role is ${roleLabel(view.role)}.`;
  // No title: the shell h1 "Access denied" stays the one heading.
  return callout({ kind: "warning", body: `${paragraph(text)}${link("/", "Go to the overview")}` });
}

/** The 404 body. The shell h1 "Page not found" stays the heading. */
export function notFoundState(): string {
  return callout({
    kind: "neutral",
    body: `<p>There is no page at this address; go to the overview.</p>\n${link("/", "Go to the overview")}`,
  });
}

/** A 409 or 412 answer: the target changed since the form was opened. */
export function staleState(view: {
  status: 409 | 412;
  detail?: string | undefined;
  reloadHref: string;
}): string {
  return callout({
    kind: "warning",
    title: "Changed since you opened it",
    body: `${paragraph("Someone changed this since you opened it. Your input is kept below. Reload to see the current version, then apply your change again.")}${paragraph(view.detail)}${link(view.reloadHref, "Reload")}`,
    role: "alert",
  });
}

/** The 503 body when pulse-api reported its checks file as read-only. */
export function readOnlyState(): string {
  return callout({
    kind: "error",
    title: "The checks file is read-only",
    body: paragraph(
      "pulse-api cannot save changes until its checks file is writable. Your input is kept below.",
    ),
    role: "alert",
  });
}

/** The 409 body for a replayed form token. */
export function alreadySubmittedState(view: { reopenHref: string }): string {
  return callout({
    kind: "warning",
    title: "Already submitted",
    body: `${paragraph("This form was already sent. Nothing was changed by this request.")}${link(view.reopenHref, "Open the page again")}`,
  });
}
