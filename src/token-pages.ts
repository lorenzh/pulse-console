import type { TokenMetadata, TokenScope, TokenSecretResponse } from "@lorenzh/pulse-contract";
import { escapeHtml } from "@lorenzh/pulse-kit";
import { utcTime } from "./check-format.ts";
import { plainConfirmPage, typedConfirmPage } from "./confirm.ts";
import {
  csrfField,
  field,
  formErrorSummary,
  formTokenField,
  paragraph,
  submitButton,
} from "./html.ts";
import { alertCallout, callout, emptyState } from "./states.ts";
import {
  ADMIN_PRESET_TEXT,
  accessText,
  countdownSeconds,
  countdownText,
  isOverlapOpen,
  isTokenActive,
  lastUsedText,
  missingScope,
  PRESET_DESCRIPTIONS,
  sourceText,
  TOKEN_PRESETS,
  tokenStateText,
} from "./token-view.ts";

export const OWN_TOKEN_TEXT =
  "The console's own token. Rotate or revoke it in pulse-api with its file or the API, then restart the console.";
export const LAST_ADMIN_TEXT = "Last active admin token: it cannot be revoked.";
export const SHOW_ONCE_TEXT =
  "Copy it now. pulse-api keeps only a hash: this is the only time it is shown.";
export const OVERLAP_ENDED_TEXT = "The old secret no longer works.";
export const ROTATE_CONSEQUENCE =
  "pulse-api makes a new secret for this token. The old secret keeps working for the overlap that pulse-api sets, then stops.";
export const REVOKE_CONSEQUENCE =
  "The token stops working at once. Anything that uses it can no longer reach pulse-api.";

/** The banner when exactly one active admin token has an expiry. */
export function lastAdminExpiryText(expiresAt: number): string {
  return `The last active admin token expires at ${utcTime(expiresAt)}. After that nobody can manage pulse-api tokens.`;
}

/** The refusal text of the grant rule. */
export function lacksScopeText(scope: TokenScope): string {
  return `The console token lacks ${scope}.`;
}

export function tokenQuery(id: string): string {
  return `?id=${encodeURIComponent(id)}`;
}

function a(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

export type TokenListModel = {
  /** Admin-side tokens in api order. */
  tokens: readonly TokenMetadata[];
  probeCount: number;
  /** The own id, when `/self` was read. */
  selfId: string | undefined;
  /** Whether create, rotate and revoke are offered. */
  canChange: boolean;
  lastAdminId: string | undefined;
  now: number;
};

function actionsCell(model: TokenListModel, token: TokenMetadata): string {
  if (token.id === model.selfId)
    return `<span class="cell-note"><strong>This console</strong> ${escapeHtml(OWN_TOKEN_TEXT)}</span>`;
  if (!model.canChange || !isTokenActive(token, model.now)) return "";
  const rotate = a(`/tokens/rotate${tokenQuery(token.id)}`, "Rotate");
  const revoke =
    token.id === model.lastAdminId
      ? `<span class="cell-note">${escapeHtml(LAST_ADMIN_TEXT)}</span>`
      : a(`/tokens/revoke${tokenQuery(token.id)}`, "Revoke");
  return `${rotate} ${revoke}`;
}

/** The leading state word stands in its own span, so the table check can find it. */
function stateHtml(text: string): string {
  const match = /^(Revoked|Expired) (.+)$/.exec(text);
  if (match === null) return escapeHtml(text);
  return `<span>${match[1]}</span> ${escapeHtml(match[2] ?? "")}`;
}

function rowHtml(model: TokenListModel, token: TokenMetadata): string {
  const cells = [
    escapeHtml(token.name),
    `<code>${escapeHtml(token.id)}</code>`,
    escapeHtml(accessText(token.scopes)),
    escapeHtml(sourceText(token.source)),
    escapeHtml(utcTime(token.createdAt)),
    escapeHtml(lastUsedText(token.lastUsedAt)),
    stateHtml(tokenStateText(token, model.now)),
  ];
  const nowrap = new Set([1, 4, 5]);
  const tds = cells
    .map((cell, i) => (nowrap.has(i) ? `<td class="cell-nowrap">${cell}</td>` : `<td>${cell}</td>`))
    .join("");
  return `<tr>${tds}<td class="actions-cell">${actionsCell(model, token)}</td></tr>`;
}

function tableHtml(model: TokenListModel, heading: string, rows: readonly TokenMetadata[]): string {
  if (rows.length === 0) return `<h2>${escapeHtml(heading)}</h2>\n<p>None.</p>\n`;
  return `<h2>${escapeHtml(heading)}</h2>
<div class="table-wrap table-scroll" tabindex="0" role="region" aria-label="${escapeHtml(heading)} tokens"><table class="tokens">
<thead><tr><th scope="col">Name</th><th scope="col">Id</th><th scope="col">Access</th><th scope="col">Source</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col">State</th><th scope="col">Actions</th></tr></thead>
<tbody>
${rows.map((token) => rowHtml(model, token)).join("\n")}
</tbody>
</table></div>
`;
}

/** The Tokens list: two tables in api order, the probe line and the create action. */
export function tokenListHtml(model: TokenListModel): string {
  const probeLine = `<p>Probe tokens are on the ${a("/probes", "Probes page")} (${model.probeCount}).</p>\n`;
  const create = model.canChange ? `<p>${a("/tokens/new", "Create a token")}</p>\n` : "";
  if (model.tokens.length === 0) {
    const action = model.canChange
      ? { href: "/tokens/new", label: "Create a token" }
      : { html: "" };
    return `${emptyState({ title: "No tokens", text: "pulse-api has no admin-side tokens.", action })}${probeLine}`;
  }
  const active = model.tokens.filter((t) => isTokenActive(t, model.now));
  const inactive = model.tokens.filter((t) => !isTokenActive(t, model.now));
  return `${create}${tableHtml(model, "Active", active)}${tableHtml(model, "Revoked or expired", inactive)}${probeLine}`;
}

export type CreateFormModel = {
  csrf: string;
  formToken: string;
  name: string;
  preset: string;
  errors: ReadonlyArray<{ name: string; text: string }>;
  /** The scopes of the console token; `undefined` when `/self` could not be read. */
  held: readonly TokenScope[] | undefined;
  notice?: string | undefined;
};

function presetHtml(model: CreateFormModel): string {
  return TOKEN_PRESETS.map((preset) => {
    const lacks = model.held === undefined ? undefined : missingScope(preset.scopes, model.held);
    const isChecked = model.preset === preset.id ? " checked" : "";
    const isDisabled = lacks === undefined ? "" : " disabled";
    const description = `<small class="hint">${escapeHtml(PRESET_DESCRIPTIONS[preset.id])}</small>`;
    const lackText =
      lacks === undefined ? "" : `<small class="hint">${escapeHtml(lacksScopeText(lacks))}</small>`;
    return `<label class="choice option-card"><input type="radio" name="preset" value="${preset.id}"${isChecked}${isDisabled}><span class="choice-text"><span class="choice-title">${escapeHtml(preset.label)}</span>${description}${lackText}</span></label>`;
  }).join("\n");
}

/** The create form: a name and one preset, no default. */
export function createFormHtml(model: CreateFormModel): string {
  const nameError = model.errors.find((e) => e.name === "name")?.text;
  const presetError = model.errors.find((e) => e.name === "preset")?.text;
  const notice = alertCallout(model.notice);
  const presetErrorHtml =
    presetError === undefined
      ? ""
      : `<span class="error" id="field-preset-error">${escapeHtml(presetError)}</span>\n`;
  const presetDescribed =
    presetError === undefined ? "preset-note" : "preset-note field-preset-error";
  return `${notice}${formErrorSummary(model.errors)}<form method="post" action="/tokens/new">
${csrfField(model.csrf)}
${formTokenField(model.formToken)}
${field({ label: "Name", name: "name", type: "text", autocomplete: "off", value: model.name, error: nameError, width: "medium" })}
<fieldset id="field-preset" aria-describedby="${presetDescribed}"><legend>Access</legend>
<p class="hint" id="preset-note">${escapeHtml(ADMIN_PRESET_TEXT)}</p>
${presetErrorHtml}${presetHtml(model)}
</fieldset>
<div class="actions">${submitButton({ label: "Create token", busyLabel: "Creating…" })}
<a class="cancel" href="/tokens">Cancel</a></div>
</form>
`;
}

export type SecretPageModel = {
  action: "create" | "rotate";
  answer: TokenSecretResponse;
  notLogged: string | undefined;
  now: number;
};

function overlapHtml(previousValidUntil: number | null, now: number): string {
  if (previousValidUntil === null || !isOverlapOpen(previousValidUntil, now)) {
    return paragraph(OVERLAP_ENDED_TEXT);
  }
  const left = countdownText(countdownSeconds(previousValidUntil, now));
  const iso = new Date(previousValidUntil).toISOString();
  return `<p>The old secret keeps working until ${escapeHtml(utcTime(previousValidUntil))} (<time data-countdown datetime="${escapeHtml(iso)}">${left}</time> left). Replace it everywhere before then.</p>\n`;
}

/** The show-once answer of a create or rotate. The secret is in this one answer only. */
export function secretHtml(model: SecretPageModel): string {
  const { token, secret } = model.answer;
  const notLogged =
    model.notLogged === undefined
      ? ""
      : callout({ kind: "warning", body: paragraph(model.notLogged), role: "alert" });
  const overlap =
    model.action === "rotate" ? overlapHtml(model.answer.previousValidUntil, model.now) : "";
  return `${notLogged}<dl class="settings">
<dt>Name</dt><dd>${escapeHtml(token.name)}</dd>
<dt>Id</dt><dd><code>${escapeHtml(token.id)}</code></dd>
<dt>Access</dt><dd>${escapeHtml(accessText(token.scopes))}</dd>
</dl>
<pre id="token-secret" data-secret>${escapeHtml(secret)}</pre>
<button type="button" class="secondary small" data-copy="token-secret" hidden>Copy</button>
${paragraph(SHOW_ONCE_TEXT)}${overlap}<p>${a("/tokens", "Back to Tokens")}</p>
`;
}

export type ConfirmModel = {
  token: TokenMetadata;
  revision: string;
  csrf: string;
  formToken: string;
  notice?: string | undefined;
  typed?: string | undefined;
  error?: string | undefined;
};

function targetHtml(token: TokenMetadata, now: number): string {
  return `<dl class="settings">
<dt>Name</dt><dd>${escapeHtml(token.name)}</dd>
<dt>Id</dt><dd><code>${escapeHtml(token.id)}</code></dd>
<dt>Access</dt><dd>${escapeHtml(accessText(token.scopes))}</dd>
<dt>State</dt><dd>${escapeHtml(tokenStateText(token, now))}</dd>
</dl>
`;
}

/** The plain rotate confirmation. */
export function rotateConfirmHtml(model: ConfirmModel, now: number): string {
  return (
    targetHtml(model.token, now) +
    plainConfirmPage({
      consequence: ROTATE_CONSEQUENCE,
      action: `/tokens/rotate${tokenQuery(model.token.id)}`,
      csrf: model.csrf,
      formToken: model.formToken,
      revision: model.revision,
      submitLabel: "Rotate token",
      busyLabel: "Rotating…",
      tone: "safe",
      cancelHref: "/tokens",
      notice: model.notice,
    })
  );
}

/** The typed-name revoke confirmation. */
export function revokeConfirmHtml(model: ConfirmModel, now: number): string {
  return (
    targetHtml(model.token, now) +
    typedConfirmPage({
      consequence: REVOKE_CONSEQUENCE,
      action: `/tokens/revoke${tokenQuery(model.token.id)}`,
      csrf: model.csrf,
      formToken: model.formToken,
      revision: model.revision,
      submitLabel: "Revoke token",
      busyLabel: "Revoking…",
      cancelHref: "/tokens",
      notice: model.notice,
      targetName: model.token.name.trim(),
      typed: model.typed,
      error: model.error,
    })
  );
}
