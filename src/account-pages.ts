import { escapeHtml } from "@lorenzh/pulse-kit";
import { csrfField, field, formTokenField, plainDocument as layout, paragraph } from "./html.ts";

import type { SessionForm } from "./http-context.ts";

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
export function factorPage(view: SessionForm & { error?: string | undefined }): string {
  return layout(
    "Two-factor sign-in",
    `${alert(view.error)}<form method="post" action="/sign-in/factor">
${csrfField(view.csrf)}
${formTokenField(view.formToken)}
<label for="field-code">Code from your authenticator app
<input id="field-code" name="code" type="text" autocomplete="one-time-code" inputmode="numeric" maxlength="64">
</label>
<div class="actions"><button type="submit">Verify</button></div>
</form>
<form method="post" action="/sign-in/factor">
${csrfField(view.csrf)}
${formTokenField(view.formToken)}
<label for="field-recovery_code">Recovery code
<input id="field-recovery_code" name="recovery_code" type="text" autocomplete="off" maxlength="64">
</label>
<div class="actions"><button type="submit" class="secondary">Use recovery code</button></div>
</form>
<form method="post" action="/sign-out">
${csrfField(view.csrf)}
${formTokenField(view.signOutToken)}
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

function newForm(view: SessionForm, isReplace: boolean): string {
  const password = isReplace
    ? `${field({ label: "Current password", name: "password", type: "password", autocomplete: "current-password" })}\n`
    : "";
  const label = isReplace ? "Replace authenticator" : "Create a setup key";
  return `<form method="post" action="/account/authenticator">
${csrfField(view.csrf)}
${formTokenField(view.formToken)}
<input type="hidden" name="action" value="new">
${password}<div class="actions"><button type="submit">${label}</button></div>
</form>`;
}

export type AuthenticatorView = SessionForm &
  (
    | { kind: "pending"; csrf: string; email: string; key: string; error?: string | undefined }
    | { kind: "retry"; csrf: string; error?: string | undefined }
    | { kind: "new"; csrf: string; error?: string | undefined }
    | { kind: "replace"; csrf: string; confirmedAt: number; error?: string | undefined }
  );

function pendingBody(view: SessionForm & { email: string; key: string }): string {
  return `<p>Add this setup key to your authenticator app, then enter the code it shows.</p>
<p>Setup key: <code class="secret" id="totp-secret">${escapeHtml(groupKey(view.key))}</code></p>
<p>Type: time-based (TOTP), SHA-1, 6 digits, 30 seconds.</p>
<p>URI: <code class="secret" id="totp-uri">${escapeHtml(otpauthUri(view.email, view.key))}</code></p>
${confirmForm(view)}`;
}

// Only GET shows the setup key; a failed confirmation links back to it.
function retryBody(view: SessionForm): string {
  return `<p>Enter the current code from your authenticator app. <a href="/account/authenticator">Show the setup key again</a>.</p>
${confirmForm(view)}`;
}

function confirmForm(view: SessionForm): string {
  return `<form method="post" action="/account/authenticator">
${csrfField(view.csrf)}
${formTokenField(view.formToken)}
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
      return retryBody(view);
    case "new":
      return `<p>Your account needs an authenticator app. Create a setup key to start.</p>\n${newForm(view, false)}`;
    case "replace":
      return `<p>Authenticator added ${escapeHtml(utcMinute(view.confirmedAt))}.</p>
<p>Replacing it ends every other session and makes new recovery codes.</p>
${newForm(view, true)}`;
    default: {
      const never: never = view;
      return never;
    }
  }
}

/** `/account/authenticator`: the setup key, a new-key form or the replace form. */
export function authenticatorPage(view: AuthenticatorView): string {
  return layout(
    "Authenticator app",
    `${alert(view.error)}${authenticatorBody(view)}
<form method="post" action="/sign-out">
${csrfField(view.csrf)}
${formTokenField(view.signOutToken)}
<div class="actions"><button type="submit" class="secondary">Sign out</button></div>
</form>`,
  );
}

/** The 409 page when the pending setup key is gone. */
export function pendingExpiredPage(view: SessionForm, isReplace: boolean): string {
  return layout("Authenticator app", `${alert(PENDING_EXPIRED_TEXT)}${newForm(view, isReplace)}`);
}

/** The account security overview. */
export function securityPage(view: { confirmedAt: number | undefined; codesLeft: number }): string {
  const added =
    view.confirmedAt === undefined
      ? "<p>No authenticator app is set up.</p>"
      : `<p>Authenticator added ${escapeHtml(utcMinute(view.confirmedAt))}.</p>`;
  return layout(
    "Account security",
    `${added}
<p>${escapeHtml(String(view.codesLeft))} of 10 recovery codes left.</p>
<ul class="links">
<li><a href="/account/authenticator">Replace authenticator</a></li>
<li><a href="/account/recovery-codes">New recovery codes</a></li>
<li><a href="/account/sessions">Sessions</a></li>
<li><a href="/account/password">Change password</a></li>
</ul>`,
  );
}

/** The password confirmation before a new set of recovery codes. */
export function newCodesPage(
  view: SessionForm & {
    csrf: string;
    codesLeft: number;
    error?: string | undefined;
  },
): string {
  return layout(
    "New recovery codes",
    `${alert(view.error)}<p>${escapeHtml(String(view.codesLeft))} of 10 recovery codes left.</p>
<p>Your current recovery codes stop working.</p>
<form method="post" action="/account/recovery-codes">
${csrfField(view.csrf)}
${formTokenField(view.formToken)}
${field({ label: "Current password", name: "password", type: "password", autocomplete: "current-password" })}
<div class="actions"><button type="submit">Create new recovery codes</button></div>
</form>`,
  );
}

export interface SessionRow {
  createdAt: number;
  lastSeenAt: number;
  isCurrent: boolean;
}

/** The live `full` sessions of the user; it never holds a session id or another CSRF token. */
export function sessionsPage(
  view: SessionForm & {
    csrf: string;
    rows: readonly SessionRow[];
    notice?: string | undefined;
  },
): string {
  const rows = view.rows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(utcMinute(row.createdAt))}</td><td>${escapeHtml(utcMinute(row.lastSeenAt))}</td><td>${row.isCurrent ? "This browser" : ""}</td></tr>`,
    )
    .join("\n");
  return layout(
    "Sessions",
    `${paragraph(view.notice, ' role="status" class="notice"')}<table id="sessions">
<thead><tr><th>Signed in</th><th>Last used</th><th></th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p><a href="/account/sessions/sign-out-all">Sign out all other sessions</a></p>
<form method="post" action="/sign-out">
${csrfField(view.csrf)}
${formTokenField(view.signOutToken)}
<div class="actions"><button type="submit" class="secondary">Sign out</button></div>
</form>`,
  );
}

/** The confirmation of sign out all: only the CSRF field and the button. */
export function signOutAllPage(view: SessionForm, error?: string): string {
  return layout(
    "Sign out all other sessions",
    `${alert(error)}<p>Sign out all other sessions? This browser stays signed in.</p>
<form method="post" action="/account/sessions/sign-out-all">
${csrfField(view.csrf)}
${formTokenField(view.formToken)}
<div class="actions"><button type="submit">Sign out all other sessions</button></div>
</form>`,
  );
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

/** The text of a guarded write whose session or password changed during the request. */
export const CREDENTIALS_CHANGED_TEXT =
  "Your password or session changed while this was saved. Nothing was changed.";

/** The own password change: the current password and the new one twice. */
export function passwordChangePage(
  view: SessionForm & { error?: string | undefined; notice?: string | undefined },
): string {
  return layout(
    "Change password",
    `${alert(view.error)}${paragraph(view.notice, ' role="status" class="notice"')}<p>Other sessions are signed out when the password changes.</p>
<form method="post" action="/account/password">
${csrfField(view.csrf)}
${formTokenField(view.formToken)}
${field({ label: "Current password", name: "password", type: "password", autocomplete: "current-password" })}
${field({ label: "New password", name: "new_password", type: "password", autocomplete: "new-password" })}
${field({ label: "New password again", name: "new_password_confirm", type: "password", autocomplete: "new-password" })}
<div class="actions"><button type="submit">Change password</button></div>
</form>`,
  );
}
