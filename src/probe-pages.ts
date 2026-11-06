import type { TokenMetadata, TokenSecretResponse } from "@lorenzh/pulse-contract";
import { escapeHtml } from "@lorenzh/pulse-kit";
import { utcTime } from "./check-format.ts";
import { plainConfirmPage, typedConfirmPage } from "./confirm.ts";
import { csrfField, formErrorSummary, formTokenField, paragraph, submitButton } from "./html.ts";
import {
  composeFile,
  composeRestartCommand,
  composeUpCommand,
  dockerRemoveCommand,
  dockerRunCommand,
  envCommand,
  type ProbeSnippetInput,
  probeBase,
} from "./probe-snippet.ts";
import {
  countdownSeconds,
  countdownText,
  isOverlapOpen,
  isTokenActive,
  type LocationGroup,
  lastUsedText,
  sourceText,
  tokenStateText,
} from "./token-view.ts";

export const PROBE_LACKS_CHECKS_TEXT =
  "The console token lacks the checks scope, so it cannot create probe tokens.";
export const ENV_HELP_TEXT =
  "Run it on the probe host in the directory where the probe files live. It holds the token: it is shown only once.";
export const AWAITING_TEXT =
  "The location appears as Awaiting first result until the probe posts its first result.";
export const PRIVATE_RANGES_TEXT =
  "PULSE_PROBE_BLOCK_PRIVATE_RANGES=false is the probe's default: its checks may connect to private, loopback, link-local and cloud metadata addresses, so checks of internal services work. To block those addresses on this probe, change the value to true in the docker run line or the Compose file before you start it. The probe reads it once at start.";
export const NETWORK_HELP_TEXT =
  "For a probe on the same Docker host as pulse-api: the Compose network of the stack (for example pulse_default). Leave empty for a remote probe.";
export const KEEPS_RESULTS_TEXT =
  "Revoking keeps the results of this location in pulse-api. The probe that uses this token can no longer post results.";
export const PROBE_ROTATE_CONSEQUENCE =
  "pulse-api makes a new secret for this probe token. The old secret keeps working for the overlap that pulse-api sets, then stops.";
export const ENV_READ_ONCE_TEXT =
  "The probe reads the env file when its container is created, so a plain docker restart keeps the old token. Recreate the container:";

export function apiUrlHelpText(consoleApiUrl: string): string {
  return `The address the probe uses to reach pulse-api. The console reaches it at ${consoleApiUrl}; a probe on another host needs an address it can reach.`;
}

export function activeCountText(location: string, count: number): string {
  return `${location} now has ${count} active ${count === 1 ? "token" : "tokens"}.`;
}

function a(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function idQuery(id: string): string {
  return `?id=${encodeURIComponent(id)}`;
}

export type ProbeListModel = {
  groups: readonly LocationGroup[];
  canChange: boolean;
  selfId: string | undefined;
  now: number;
};

function credentialRow(model: ProbeListModel, token: TokenMetadata): string {
  const isActive = isTokenActive(token, model.now);
  const rotate = a("/probes/rotate" + idQuery(token.id), "Rotate this token");
  const revoke = a("/probes/revoke" + idQuery(token.id), "Revoke this token");
  const actions =
    model.canChange && isActive && token.id !== model.selfId ? rotate + " " + revoke : "";
  const cells = [
    escapeHtml(token.name),
    `<code>${escapeHtml(token.id)}</code>`,
    escapeHtml(sourceText(token.source)),
    escapeHtml(utcTime(token.createdAt)),
    escapeHtml(lastUsedText(token.lastUsedAt)),
    escapeHtml(tokenStateText(token, model.now)),
  ];
  const tds = cells.map((cell) => `<td>${cell}</td>`).join("");
  return `<tr>${tds}<td class="actions-cell">${actions}</td></tr>`;
}

function credentialTable(model: ProbeListModel, group: LocationGroup): string {
  if (group.credentials.length === 0) return paragraph("No tokens for this location.");
  return `<div class="table-wrap table-scroll" tabindex="0" role="region" aria-label="Tokens of ${escapeHtml(group.name)}"><table class="tokens">
<thead><tr><th scope="col">Name</th><th scope="col">Id</th><th scope="col">Source</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col">State</th><th scope="col">Actions</th></tr></thead>
<tbody>
${group.credentials.map((t) => credentialRow(model, t)).join("\n")}
</tbody>
</table></div>
`;
}

function groupHtml(model: ProbeListModel, group: LocationGroup, level: "h2" | "h3"): string {
  const warning = group.warning === undefined ? "" : paragraph(group.warning, ' role="alert"');
  return `<section class="location">
<${level}>${escapeHtml(group.name)}</${level}>
${paragraph(group.stateText)}${warning}${credentialTable(model, group)}</section>
`;
}

/** The Probes list: one group per location, revoked-only groups in a "Revoked" part. */
export function probeListHtml(model: ProbeListModel): string {
  const add = model.canChange ? `<p>${a("/probes/new", "Add a location")}</p>\n` : "";
  const active = model.groups.filter((g) => !g.isRevokedOnly);
  const revoked = model.groups.filter((g) => g.isRevokedOnly);
  const activeHtml =
    active.length === 0
      ? paragraph("No probe locations yet.")
      : active.map((g) => groupHtml(model, g, "h2")).join("");
  const revokedHtml =
    revoked.length === 0
      ? ""
      : `<h2>Revoked</h2>\n${revoked.map((g) => groupHtml(model, g, "h3")).join("")}`;
  return `${add}${activeHtml}${revokedHtml}`;
}

export type ProbeFormInput = {
  location: string;
  name: string;
  apiUrl: string;
  image: string;
  network: string;
};

export type ProbeFormModel = {
  csrf: string;
  formToken: string;
  input: ProbeFormInput;
  errors: ReadonlyArray<{ name: string; text: string }>;
  consoleApiUrl: string;
  notice?: string | undefined;
};

function inputHtml(view: {
  label: string;
  name: string;
  type: "text" | "url";
  value: string;
  isRequired: boolean;
  help?: string | undefined;
  error: string | undefined;
}): string {
  const id = `field-${view.name}`;
  const described = [
    ...(view.help === undefined ? [] : [`${id}-help`]),
    ...(view.error === undefined ? [] : [`${id}-error`]),
  ];
  const aria =
    (described.length === 0 ? "" : ` aria-describedby="${described.join(" ")}"`) +
    (view.error === undefined ? "" : ' aria-invalid="true"');
  const help =
    view.help === undefined ? "" : `\n<small id="${id}-help">${escapeHtml(view.help)}</small>`;
  const error =
    view.error === undefined
      ? ""
      : `\n<span class="error" id="${id}-error">${escapeHtml(view.error)}</span>`;
  const required = view.isRequired ? " required" : "";
  return `<label for="${id}">${escapeHtml(view.label)}
<input id="${id}" name="${view.name}" type="${view.type}" autocomplete="off"${required} value="${escapeHtml(view.value)}"${aria}>${help}${error}
</label>`;
}

/** The add-location form: exactly location, name, api_url, image and network. */
export function probeFormHtml(model: ProbeFormModel): string {
  const errorOf = (name: string): string | undefined =>
    model.errors.find((e) => e.name === name)?.text;
  const notice = model.notice === undefined ? "" : paragraph(model.notice, ' role="alert"');
  const { input } = model;
  return `${notice}${formErrorSummary(model.errors)}<form method="post" action="/probes/new">
${csrfField(model.csrf)}
${formTokenField(model.formToken)}
${inputHtml({ label: "Location", name: "location", type: "text", value: input.location, isRequired: true, error: errorOf("location") })}
${inputHtml({ label: "Name (optional)", name: "name", type: "text", value: input.name, isRequired: false, help: "Default: probe <location>.", error: errorOf("name") })}
${inputHtml({ label: "API URL for the probe", name: "api_url", type: "url", value: input.apiUrl, isRequired: true, help: apiUrlHelpText(model.consoleApiUrl), error: errorOf("api_url") })}
${inputHtml({ label: "Probe image", name: "image", type: "text", value: input.image, isRequired: true, error: errorOf("image") })}
${inputHtml({ label: "Docker network (optional)", name: "network", type: "text", value: input.network, isRequired: false, help: NETWORK_HELP_TEXT, error: errorOf("network") })}
<div class="actions">${submitButton({ label: "Add location", busyLabel: "Adding…" })}
<a class="cancel" href="/probes">Cancel</a></div>
</form>
`;
}

function preBlock(id: string, text: string, isSecret: boolean): string {
  const secret = isSecret ? " data-secret" : "";
  return `<pre id="${id}"${secret}>${escapeHtml(text)}</pre>
<button type="button" data-copy="${id}" hidden>Copy</button>
`;
}

function notLoggedHtml(notLogged: string | undefined): string {
  return notLogged === undefined ? "" : paragraph(notLogged, ' role="alert"');
}

export type ProbeAddedModel = {
  snippet: ProbeSnippetInput;
  answer: TokenSecretResponse;
  activeCount: number | undefined;
  notLogged: string | undefined;
};

/** The show-once answer of an added location: the four snippets. */
export function probeAddedHtml(model: ProbeAddedModel): string {
  const { snippet, answer } = model;
  const base = probeBase(snippet.location, snippet.tokenId);
  const count =
    model.activeCount === undefined
      ? ""
      : paragraph(activeCountText(snippet.location, model.activeCount));
  return `${notLoggedHtml(model.notLogged)}${count}<dl class="settings">
<dt>Location</dt><dd>${escapeHtml(snippet.location)}</dd>
<dt>Name</dt><dd>${escapeHtml(answer.token.name)}</dd>
<dt>Id</dt><dd><code>${escapeHtml(answer.token.id)}</code></dd>
</dl>
<h2>1. Save the token</h2>
${preBlock("probe-env-command", envCommand(base, answer.secret), true)}${paragraph(ENV_HELP_TEXT)}<h2>2a. Start with docker run</h2>
${preBlock("probe-docker-run", dockerRunCommand(snippet), false)}<h2>2b. Or start with Compose</h2>
${paragraph(`Save this file as ${base}.compose.yaml, then run the command.`)}${preBlock("probe-compose-file", composeFile(snippet), false)}${preBlock("probe-compose-command", composeUpCommand(base), false)}<h2>3. Wait for the first result</h2>
${paragraph(AWAITING_TEXT)}${paragraph(PRIVATE_RANGES_TEXT)}<p>${a("/probes", "Back to Probes")}</p>
`;
}

function overlapHtml(previousValidUntil: number | null, now: number): string {
  if (previousValidUntil === null || !isOverlapOpen(previousValidUntil, now)) {
    return paragraph("The old secret no longer works.");
  }
  const left = countdownText(countdownSeconds(previousValidUntil, now));
  const iso = new Date(previousValidUntil).toISOString();
  return `<p>The old secret keeps working until ${escapeHtml(utcTime(previousValidUntil))} (<time data-countdown datetime="${escapeHtml(iso)}">${left}</time> left). Restart the probe before then.</p>\n`;
}

export type ProbeRotatedModel = {
  answer: TokenSecretResponse;
  notLogged: string | undefined;
  now: number;
};

/** The show-once answer of a rotated probe token: the env command and the restart lines. */
export function probeRotatedHtml(model: ProbeRotatedModel): string {
  const { token, secret, previousValidUntil } = model.answer;
  const base = probeBase(token.location ?? "", token.id);
  return `${notLoggedHtml(model.notLogged)}<dl class="settings">
<dt>Location</dt><dd>${escapeHtml(token.location ?? "")}</dd>
<dt>Name</dt><dd>${escapeHtml(token.name)}</dd>
<dt>Id</dt><dd><code>${escapeHtml(token.id)}</code></dd>
</dl>
${overlapHtml(previousValidUntil, model.now)}<h2>1. Save the new token</h2>
${paragraph(`This replaces ${base}.env.`)}${preBlock("probe-env-command", envCommand(base, secret), true)}${paragraph(ENV_HELP_TEXT)}<h2>2. Recreate the probe</h2>
${paragraph(ENV_READ_ONCE_TEXT)}${paragraph("With Compose:")}${preBlock("probe-compose-restart", composeRestartCommand(base), false)}${paragraph("With docker run: remove the container, then run your docker run line again.")}${preBlock("probe-docker-remove", dockerRemoveCommand(base), false)}<p>${a("/probes", "Back to Probes")}</p>
`;
}

export type ProbeConfirmModel = {
  token: TokenMetadata;
  revision: string;
  csrf: string;
  formToken: string;
  now: number;
  notice?: string | undefined;
  typed?: string | undefined;
  error?: string | undefined;
};

function targetHtml(token: TokenMetadata, now: number): string {
  return `<dl class="settings">
<dt>Location</dt><dd>${escapeHtml(token.location ?? "")}</dd>
<dt>Name</dt><dd>${escapeHtml(token.name)}</dd>
<dt>Id</dt><dd><code>${escapeHtml(token.id)}</code></dd>
<dt>State</dt><dd>${escapeHtml(tokenStateText(token, now))}</dd>
</dl>
`;
}

/** The plain rotate confirmation of one probe credential. */
export function probeRotateConfirmHtml(model: ProbeConfirmModel): string {
  return (
    targetHtml(model.token, model.now) +
    plainConfirmPage({
      consequence: PROBE_ROTATE_CONSEQUENCE,
      action: `/probes/rotate${idQuery(model.token.id)}`,
      csrf: model.csrf,
      formToken: model.formToken,
      revision: model.revision,
      submitLabel: "Rotate token",
      busyLabel: "Rotating…",
      tone: "safe",
      cancelHref: "/probes",
      notice: model.notice,
    })
  );
}

/** The revoke confirmation: the person types the location. */
export function probeRevokeConfirmHtml(model: ProbeConfirmModel): string {
  return (
    targetHtml(model.token, model.now) +
    typedConfirmPage({
      consequence: KEEPS_RESULTS_TEXT,
      action: `/probes/revoke${idQuery(model.token.id)}`,
      csrf: model.csrf,
      formToken: model.formToken,
      revision: model.revision,
      submitLabel: "Revoke token",
      busyLabel: "Revoking…",
      cancelHref: "/probes",
      notice: model.notice,
      targetName: (model.token.location ?? "").trim(),
      typed: model.typed,
      error: model.error,
    })
  );
}
