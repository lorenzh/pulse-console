import { escapeHtml } from "@lorenzh/pulse-kit";
import { csrfField, field, formTokenField, paragraph, plainDocument } from "./html.ts";
import { alertCallout, alreadySubmittedState, callout } from "./states.ts";

// Every value goes through escapeHtml. The CSP allows only the /console.css stylesheet.

/** The setup code form. */
export function setupCodePage(view: {
  csrf: string;
  formToken: string;
  error?: string | undefined;
}): string {
  return plainDocument(
    "Set up pulse Console",
    `<p>Enter the setup code from the console log. It is the line that starts with "pulse-console setup code:".</p>
<form method="post" action="/setup">
${csrfField(view.csrf)}
${formTokenField(view.formToken)}
${field({ label: "Setup code", name: "code", type: "text", autocomplete: "one-time-code", error: view.error })}
<div class="actions"><button type="submit">Unlock setup</button></div>
</form>`,
  );
}

export type OwnerValues = { apiUrl: string; email: string; name: string };
export type OwnerErrors = Partial<Record<"apiUrl" | "email" | "name" | "password", string>>;
export type ConnectionView =
  | { isOk: true; checkCount: number; isScopeChecked: boolean }
  | { isOk: false; text: string };

function connectionHtml(view: ConnectionView | undefined): string {
  if (view === undefined) return "";
  if (!view.isOk) {
    return callout({
      kind: "error",
      body: paragraph(view.text),
      role: "alert",
      id: "connection-result",
    });
  }
  const scope = view.isScopeChecked
    ? ""
    : "<p>This pulse-api has no token routes, so the admin scope was not checked.</p>\n";
  // Deploy greps this line byte for byte.
  const line = `<p>Connected. Wire version: 1. Checks: ${view.checkCount}.</p>\n`;
  return callout({ kind: "success", body: line, id: "connection-result" }) + scope;
}

/** The owner and API form of setup. Password fields are never filled in. */
export function setupOwnerPage(view: {
  csrf: string;
  formToken: string;
  values: OwnerValues;
  errors?: OwnerErrors | undefined;
  connection?: ConnectionView | undefined;
  message?: string | undefined;
}): string {
  const errors = view.errors ?? {};
  return plainDocument(
    "Create the owner account",
    `${alertCallout(view.message)}${connectionHtml(view.connection)}<p>The console needs a pulse-api token with the read or checks scope and the admin scope. If pulse-api answers that it is throttling, wait a minute before the next test.</p>
<form method="post" action="/setup/owner">
${csrfField(view.csrf)}
${formTokenField(view.formToken)}
${field({ label: "pulse-api URL", name: "api_url", type: "url", autocomplete: "url", value: view.values.apiUrl, error: errors.apiUrl })}
${field({ label: "Owner email", name: "email", type: "email", autocomplete: "username", value: view.values.email, error: errors.email })}
${field({ label: "Owner name", name: "name", type: "text", autocomplete: "name", value: view.values.name, error: errors.name })}
${field({ label: "Password", name: "password", type: "password", autocomplete: "new-password", error: errors.password })}
${field({ label: "Confirm password", name: "password_confirm", type: "password", autocomplete: "new-password" })}
<div class="actions">
<button type="submit" name="action" value="test" class="secondary">Test connection</button>
<button type="submit" name="action" value="complete">Finish setup</button>
</div>
</form>`,
  );
}

/** The sign-in form. */
export function signInPage(view: {
  csrf: string;
  formToken: string;
  next: string;
  notice?: string | undefined;
  error?: string | undefined;
}): string {
  return plainDocument(
    "Sign in",
    `${view.notice === undefined ? "" : callout({ kind: "info", body: paragraph(view.notice) })}${alertCallout(view.error)}<form method="post" action="/sign-in">
${csrfField(view.csrf)}
${formTokenField(view.formToken)}
<input type="hidden" name="next" value="${escapeHtml(view.next)}">
${field({ label: "Email", name: "email", type: "email", autocomplete: "username" })}
${field({ label: "Password", name: "password", type: "password", autocomplete: "current-password" })}
<div class="actions"><button type="submit">Sign in</button></div>
</form>`,
  );
}

/** The "already submitted" state in the plain document of setup and sign-in. */
export function alreadySubmittedPage(reopenHref: string): string {
  return plainDocument("Already submitted", alreadySubmittedState({ reopenHref }));
}

/** A page with one message and an optional link. */
export function messagePage(
  title: string,
  text: string,
  link?: { href: string; label: string },
): string {
  const a =
    link === undefined
      ? ""
      : `<p class="plain-foot"><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>\n`;
  return plainDocument(title, `${paragraph(text)}${a}`);
}
