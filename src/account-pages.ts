import { escapeHtml } from "@lorenzh/pulse-kit";
import { csrfField, field, layout, paragraph } from "./pages.ts";

export const DECRYPT_FAILED_TEXT =
  "The authenticator secret cannot be read. Sign in with a recovery code.";
export const NO_KEY_TEXT =
  "Two-factor setup needs PULSE_CONSOLE_SECRET_KEY_FILE. Ask the operator to set it.";
export const PENDING_EXPIRED_TEXT = "The setup key expired. Create a new one.";
export const FACTOR_CHOICE_TEXT = "Enter the code from your authenticator app or a recovery code.";

function alert(text: string | undefined): string {
  return paragraph(text, ' role="alert" class="error"');
}

/** `YYYY-MM-DD HH:MM UTC` of an epoch millisecond value. */
export function utcMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The second-factor step of sign-in: TOTP, a recovery code, or cancel. */
export function factorPage(view: { csrf: string; error?: string | undefined }): string {
  return layout(
    "Two-factor sign-in",
    `${alert(view.error)}<form method="post" action="/sign-in/factor">
${csrfField(view.csrf)}
<label for="field-code">Code from your authenticator app
<input id="field-code" name="code" type="text" autocomplete="one-time-code" inputmode="numeric" maxlength="64">
</label>
<div class="actions"><button type="submit">Verify</button></div>
</form>
<form method="post" action="/sign-in/factor">
${csrfField(view.csrf)}
<label for="field-recovery_code">Recovery code
<input id="field-recovery_code" name="recovery_code" type="text" autocomplete="off" maxlength="64">
</label>
<div class="actions"><button type="submit" class="secondary">Use recovery code</button></div>
</form>
<form method="post" action="/sign-out">
${csrfField(view.csrf)}
<div class="actions"><button type="submit" class="secondary">Cancel</button></div>
</form>`,
  );
}

function groupKey(key: string): string {
  return key.match(/.{1,4}/g)?.join(" ") ?? key;
}

/** The otpauth URI of an authenticator. */
export function otpauthUri(email: string, key: string): string {
  return `otpauth://totp/pulse%20Console:${encodeURIComponent(email)}?secret=${key}&issuer=pulse%20Console&algorithm=SHA1&digits=6&period=30`;
}

function newForm(csrf: string, isReplace: boolean): string {
  const password = isReplace
    ? `${field({ label: "Current password", name: "password", type: "password", autocomplete: "current-password" })}\n`
    : "";
  const label = isReplace ? "Replace authenticator" : "Create a setup key";
  return `<form method="post" action="/account/authenticator">
${csrfField(csrf)}
<input type="hidden" name="action" value="new">
${password}<div class="actions"><button type="submit">${label}</button></div>
</form>`;
}

export type AuthenticatorView =
  | { kind: "pending"; csrf: string; email: string; key: string; error?: string | undefined }
  | { kind: "retry"; csrf: string; error?: string | undefined }
  | { kind: "new"; csrf: string; error?: string | undefined }
  | { kind: "replace"; csrf: string; confirmedAt: number; error?: string | undefined };

function pendingBody(view: { csrf: string; email: string; key: string }): string {
  return `<p>Add this setup key to your authenticator app, then enter the code it shows.</p>
<p>Setup key: <code class="secret" id="totp-secret">${escapeHtml(groupKey(view.key))}</code></p>
<p>Type: time-based (TOTP), SHA-1, 6 digits, 30 seconds.</p>
<p>URI: <code class="secret" id="totp-uri">${escapeHtml(otpauthUri(view.email, view.key))}</code></p>
${confirmForm(view.csrf)}`;
}

// Only GET shows the setup key; a failed confirmation links back to it.
function retryBody(csrf: string): string {
  return `<p>Enter the current code from your authenticator app. <a href="/account/authenticator">Show the setup key again</a>.</p>
${confirmForm(csrf)}`;
}

function confirmForm(csrf: string): string {
  return `<form method="post" action="/account/authenticator">
${csrfField(csrf)}
<input type="hidden" name="action" value="confirm">
<label for="field-code">Code from your authenticator app
<input id="field-code" name="code" type="text" autocomplete="one-time-code" inputmode="numeric" maxlength="64" required>
</label>
<div class="actions"><button type="submit">Confirm</button></div>
</form>`;
}

function authenticatorBody(view: AuthenticatorView): string {
  switch (view.kind) {
    case "pending":
      return pendingBody(view);
    case "retry":
      return retryBody(view.csrf);
    case "new":
      return `<p>Your account needs an authenticator app. Create a setup key to start.</p>\n${newForm(view.csrf, false)}`;
    case "replace":
      return `<p>Authenticator added ${escapeHtml(utcMinute(view.confirmedAt))}.</p>
<p>Replacing it ends every other session and makes new recovery codes.</p>
${newForm(view.csrf, true)}`;
    default: {
      const never: never = view;
      return never;
    }
  }
}

/** `/account/authenticator`: the setup key, a new-key form or the replace form. */
export function authenticatorPage(view: AuthenticatorView): string {
  return layout("Authenticator app", `${alert(view.error)}${authenticatorBody(view)}`);
}

/** The 409 page when the pending setup key is gone. */
export function pendingExpiredPage(csrf: string, isReplace: boolean): string {
  return layout("Authenticator app", `${alert(PENDING_EXPIRED_TEXT)}${newForm(csrf, isReplace)}`);
}

/** The only response that shows a set of recovery codes. */
export function recoveryCodesPage(view: { codes: readonly string[]; next: string }): string {
  const items = view.codes.map((code) => `<li><code>${escapeHtml(code)}</code></li>`).join("\n");
  return layout(
    "Recovery codes",
    `<p>Save these recovery codes now. Each works once, and this page does not show them again.</p>
<ol id="recovery-codes">
${items}
</ol>
<p><a href="${escapeHtml(view.next)}">Continue</a></p>`,
  );
}
