import { escapeHtml } from "@lorenzh/pulse-kit";

// Every value goes through escapeHtml. The CSP allows only the /console.css stylesheet.
export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} · pulse Console</title>
    <link rel="stylesheet" href="/console.css">
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
${body}
    </main>
  </body>
</html>
`;
}

export function csrfField(token: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(token)}">`;
}

export type Field = {
  label: string;
  name: string;
  type: "text" | "email" | "password" | "url";
  autocomplete: string;
  value?: string | undefined;
  error?: string | undefined;
};

export function field(f: Field): string {
  const id = `field-${f.name}`;
  const errorId = `${id}-error`;
  const described =
    f.error === undefined ? "" : ` aria-describedby="${errorId}" aria-invalid="true"`;
  const value = f.value === undefined ? "" : ` value="${escapeHtml(f.value)}"`;
  const error =
    f.error === undefined
      ? ""
      : `\n<span class="error" id="${errorId}">${escapeHtml(f.error)}</span>`;
  return `<label for="${id}">${escapeHtml(f.label)}
<input id="${id}" name="${f.name}" type="${f.type}" autocomplete="${f.autocomplete}" required${value}${described}>${error}
</label>`;
}

export function paragraph(text: string | undefined, extra = ""): string {
  return text === undefined ? "" : `<p${extra}>${escapeHtml(text)}</p>\n`;
}

/** The setup code form. */
export function setupCodePage(view: { csrf: string; error?: string | undefined }): string {
  return layout(
    "Set up pulse Console",
    `<p>Enter the setup code from the console log. It is the line that starts with "pulse-console setup code:".</p>
<form method="post" action="/setup">
${csrfField(view.csrf)}
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
  if (!view.isOk) return paragraph(view.text, ' id="connection-result" role="alert"');
  const scope = view.isScopeChecked
    ? ""
    : "<p>This pulse-api has no token routes, so the admin scope was not checked.</p>\n";
  return `<p id="connection-result">Connected. Wire version: 1. Checks: ${view.checkCount}.</p>\n${scope}`;
}

/** The owner and API form of setup. Password fields are never filled in. */
export function setupOwnerPage(view: {
  csrf: string;
  values: OwnerValues;
  errors?: OwnerErrors | undefined;
  connection?: ConnectionView | undefined;
  message?: string | undefined;
}): string {
  const errors = view.errors ?? {};
  return layout(
    "Create the owner account",
    `${paragraph(view.message, ' role="alert"')}${connectionHtml(view.connection)}<p>The console needs a pulse-api token with the read or checks scope and the admin scope. If pulse-api answers that it is throttling, wait a minute before the next test.</p>
<form method="post" action="/setup/owner">
${csrfField(view.csrf)}
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
  next: string;
  notice?: string | undefined;
  error?: string | undefined;
}): string {
  return layout(
    "Sign in",
    `${paragraph(view.notice, ' class="notice"')}${paragraph(view.error, ' role="alert" class="error"')}<form method="post" action="/sign-in">
${csrfField(view.csrf)}
<input type="hidden" name="next" value="${escapeHtml(view.next)}">
${field({ label: "Email", name: "email", type: "email", autocomplete: "username" })}
${field({ label: "Password", name: "password", type: "password", autocomplete: "current-password" })}
<div class="actions"><button type="submit">Sign in</button></div>
</form>`,
  );
}

/** The signed-in landing page with the sign-out form. */
export function landingPage(view: {
  csrf: string;
  name: string;
  email: string;
  apiOrigin: string;
}): string {
  return layout(
    "pulse Console",
    `<p>Signed in as ${escapeHtml(view.name)} (${escapeHtml(view.email)}).</p>
<p>pulse-api: ${escapeHtml(view.apiOrigin)}</p>
<p><a href="/account/security">Account security</a></p>
<form method="post" action="/sign-out">
${csrfField(view.csrf)}
<div class="actions"><button type="submit">Sign out</button></div>
</form>`,
  );
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
      : `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>\n`;
  return layout(title, `${paragraph(text)}${a}`);
}
