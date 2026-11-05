import { escapeHtml } from "@lorenzh/pulse-kit";
import {
  csrfField,
  field,
  formErrorSummary,
  formTokenField,
  paragraph,
  submitButton,
} from "./html.ts";

/** The parts every confirmation page shares. The shell renders the heading as its `h1`. */
export type ConfirmView = {
  /** The consequence text, written by the caller. */
  consequence: string;
  action: string;
  csrf: string;
  formToken: string;
  /** The version of the target the user saw when the page opened. */
  revision: string;
  submitLabel: string;
  busyLabel: string;
  cancelHref: string;
  /** A notice above the form, such as the expired-token notice. */
  notice?: string | undefined;
  /** More hidden fields after `revision`, written by the caller from its own data. */
  hidden?: ReadonlyArray<readonly [string, string]> | undefined;
};

export type TypedConfirmView = ConfirmView & {
  /** The target's display name, read from the route's own data. */
  targetName: string;
  /** The kept typed value after a refused POST. */
  typed?: string | undefined;
  error?: string | undefined;
};

/** Decision 7: both names trimmed and NFC-normalized, case-sensitive, inner whitespace counts. */
export function isTypedNameConfirmed(typed: string, expected: string): boolean {
  return typed.trim().normalize("NFC") === expected.trim().normalize("NFC");
}

/** The error for a typed name that does not confirm, or undefined when it confirms. */
export function typedNameError(typed: string, expected: string): string | undefined {
  if (typed.trim() === "") return "Type the name to confirm.";
  if (isTypedNameConfirmed(typed, expected)) return undefined;
  return `The name does not match. Type ${expected.trim()} exactly.`;
}

function notice(text: string | undefined): string {
  return text === undefined ? "" : paragraph(text, ' role="alert"');
}

function hiddenFields(hidden: ConfirmView["hidden"]): string {
  return (hidden ?? [])
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">\n`,
    )
    .join("");
}

function confirmForm(view: ConfirmView, inner: string): string {
  return `<form method="post" action="${escapeHtml(view.action)}" class="confirm">
${csrfField(view.csrf)}
${formTokenField(view.formToken)}
<input type="hidden" name="revision" value="${escapeHtml(view.revision)}">
${hiddenFields(view.hidden)}${inner}<div class="actions">${submitButton({ label: view.submitLabel, busyLabel: view.busyLabel })}
<a class="cancel" href="${escapeHtml(view.cancelHref)}">Cancel</a></div>
</form>
`;
}

/** A confirmation that needs the target's name typed. GET never acts. */
export function typedConfirmPage(view: TypedConfirmView): string {
  const errors = view.error === undefined ? [] : [{ name: "confirm_name", text: view.error }];
  const input = field({
    label: `Type ${view.targetName} to confirm`,
    name: "confirm_name",
    type: "text",
    autocomplete: "off",
    value: view.typed,
    error: view.error,
  });
  return `${notice(view.notice)}${formErrorSummary(errors)}${paragraph(view.consequence)}<p class="confirm-target">${escapeHtml(view.targetName)}</p>
${confirmForm(view, input + "\n")}`;
}

/** A confirmation with one submit button. GET never acts. */
export function plainConfirmPage(view: ConfirmView): string {
  return `${notice(view.notice)}${paragraph(view.consequence)}${confirmForm(view, "")}`;
}
