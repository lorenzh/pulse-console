import { escapeHtml } from "@lorenzh/pulse-kit";
import { callout } from "./states.ts";

// The one script element of the console. Only the shell sets `hasScript`.
const SCRIPT_ELEMENT = `\n    <script src="/console.js" defer></script>`;

/** The document head. Every value goes through escapeHtml. */
export function documentHead(view: {
  title: string;
  instanceName: string;
  hasScript: boolean;
}): string {
  return `  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(view.title)} · ${escapeHtml(view.instanceName)}</title>
    <link rel="stylesheet" href="/console.css">${view.hasScript ? SCRIPT_ELEMENT : ""}
  </head>`;
}

/** The pulse wordmark of the shell sidebar and the plain header. It is not a link. */
export function wordmark(): string {
  return `<p class="wordmark"><span class="wordmark-name">pulse</span><span class="cursor" aria-hidden="true"></span><span class="pill">self-hosted</span></p>`;
}

/** The plain document of setup and sign-in: no shell and no script element. */
export function plainDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
${documentHead({ title, instanceName: "pulse Console", hasScript: false })}
  <body class="plain">
<header class="plain-head">${wordmark()}</header>
<main class="plain-main"><div class="panel plain-panel">
<h1>${escapeHtml(title)}</h1>
${body}
</div></main>
  </body>
</html>
`;
}

export function csrfField(token: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(token)}">`;
}

/** The hidden single-use form token. It goes directly after `csrfField`. */
export function formTokenField(token: string): string {
  return `<input type="hidden" name="form_token" value="${escapeHtml(token)}">`;
}

/** A paragraph, or nothing when `text` is undefined. */
export function paragraph(text: string | undefined, extra = ""): string {
  return text === undefined ? "" : `<p${extra}>${escapeHtml(text)}</p>\n`;
}

/** An optional cap on a control's width: `input-narrow` (12rem) or `input-medium` (24rem). */
export type FieldWidth = "narrow" | "medium";

export type Field = {
  label: string;
  name: string;
  type: "text" | "email" | "password" | "url";
  autocomplete: string;
  value?: string | undefined;
  error?: string | undefined;
  width?: FieldWidth | undefined;
};

function fieldParts(name: string, error: string | undefined) {
  const id = `field-${name}`;
  const errorId = `${id}-error`;
  return {
    id,
    described: error === undefined ? "" : ` aria-describedby="${errorId}" aria-invalid="true"`,
    error:
      error === undefined
        ? ""
        : `\n<span class="error" id="${errorId}">${escapeHtml(error)}</span>`,
  };
}

/** The class attribute of an optional field width. */
export function widthClass(width: FieldWidth | undefined): string {
  return width === undefined ? "" : ` class="input-${width}"`;
}

/** A labelled input with its error message. */
export function field(f: Field): string {
  const parts = fieldParts(f.name, f.error);
  const value = f.value === undefined ? "" : ` value="${escapeHtml(f.value)}"`;
  return `<label for="${parts.id}">${escapeHtml(f.label)}
<input id="${parts.id}"${widthClass(f.width)} name="${escapeHtml(f.name)}" type="${f.type}" autocomplete="${escapeHtml(f.autocomplete)}" required${value}${parts.described}>${parts.error}
</label>`;
}

export type TextareaField = {
  label: string;
  name: string;
  value?: string | undefined;
  error?: string | undefined;
};

/** A labelled textarea with its error message. */
export function textareaField(f: TextareaField): string {
  const parts = fieldParts(f.name, f.error);
  return `<label for="${parts.id}">${escapeHtml(f.label)}
<textarea id="${parts.id}" name="${escapeHtml(f.name)}" rows="4"${parts.described}>${escapeHtml(f.value ?? "")}</textarea>${parts.error}
</label>`;
}

/**
 * A submit button. It is never rendered disabled: /console.js disables it after submit and
 * shows `busyLabel`; without JavaScript the form submits natively.
 */
export function submitButton(view: {
  label: string;
  busyLabel: string;
  name?: string | undefined;
  value?: string | undefined;
  variant?: "primary" | "secondary" | "ghost" | "danger" | undefined;
  size?: "small" | undefined;
}): string {
  const name = view.name === undefined ? "" : ` name="${escapeHtml(view.name)}"`;
  const value = view.value === undefined ? "" : ` value="${escapeHtml(view.value)}"`;
  const classes = [
    view.variant === undefined || view.variant === "primary" ? "" : view.variant,
    view.size ?? "",
  ].filter((c) => c !== "");
  const cls = classes.length === 0 ? "" : ` class="${classes.join(" ")}"`;
  return `<button type="submit"${name}${value}${cls} data-busy-label="${escapeHtml(view.busyLabel)}">${escapeHtml(view.label)}</button>`;
}

/** The error summary at the top of a form, with a link to each field. */
export function formErrorSummary(errors: ReadonlyArray<{ name: string; text: string }>): string {
  if (errors.length === 0) return "";
  const items = errors
    .map((e) => `<li><a href="#field-${escapeHtml(e.name)}">${escapeHtml(e.text)}</a></li>`)
    .join("\n");
  return callout({
    kind: "error",
    title: "There is a problem",
    body: `<ul class="error-summary">\n${items}\n</ul>\n`,
    role: "alert",
  });
}
