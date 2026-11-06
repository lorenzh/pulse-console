import type { AdminCheckView } from "@lorenzh/pulse-contract";
import { escapeHtml } from "@lorenzh/pulse-kit";
import {
  ASSERT_ROWS,
  CHECK_FORM_FIELDS,
  CHECK_TYPES,
  type CheckType,
  DNS_RECORD_TYPES,
  type FieldError,
  HEADER_ROWS,
  HTTP_METHODS,
} from "./check-form.ts";
import { idQuery, TYPE_LABELS } from "./check-pages.ts";
import type { FormFields } from "./forms.ts";
import {
  csrfField,
  type FieldWidth,
  formErrorSummary,
  formTokenField,
  paragraph,
  submitButton,
  widthClass,
} from "./html.ts";
import { type HostBinding, hostBindingLine } from "./shell-line.ts";

export const PROBE_QUORUM_TEXT =
  "Every probe runs this check. It is down when at least two locations report down; with one reporting location, that location decides. Choosing locations or a quorum per check is not available yet.";
export const HEARTBEAT_QUORUM_TEXT =
  "Heartbeat checks are not run by probes and have no quorum; your job pings pulse-api. With no ping for longer than the period plus the grace time, the check is down at once.";
export const NOT_KEPT_TEXT = "Not kept for safety: enter it again.";
export const TLS_NOTE_TEXT =
  "This check judges the certificate's expiry date only. It does not verify the certificate chain or the host name.";

/** The parts of a trusted stored view that the edit form shows as fixed (Decision 6 to 8). */
export type StoredRows = {
  id: string;
  type: CheckType;
  /** Stored literal header names, in view order; rows `0` to `k - 1`. */
  literalHeaders: readonly string[];
  hasBody: boolean;
  hasSecret: boolean;
};

/** Non-secret input to show again; literal values, a body and a secret are never in it. */
export type RetainedInput = {
  values: Readonly<Record<string, string>>;
  /** Fields whose typed write-only value was dropped; they show `NOT_KEPT_TEXT`. */
  dropped: ReadonlySet<string>;
};

export type EditorModel = {
  type: CheckType;
  /** Undefined on create; on edit the trusted stored view. */
  stored: StoredRows | undefined;
  input: RetainedInput;
  errors: readonly FieldError[];
  revision: string;
  csrf: string;
  formToken: string;
};

/** The fixed parts of a trusted stored view. */
export function storedRowsOf(view: AdminCheckView): StoredRows {
  const type: CheckType = view.type ?? "http";
  const headers = "headers" in view && view.headers !== undefined ? view.headers : {};
  return {
    id: view.id,
    type,
    literalHeaders: Object.entries(headers)
      .filter(([, value]) => typeof value === "object" && "keep" in value)
      .map(([name]) => name),
    hasBody: "body" in view && view.body !== undefined,
    hasSecret: "hasSecret" in view && view.hasSecret === true,
  };
}

/** Whether a posted field holds a write-only value that must never be shown again. */
function isWriteOnly(fields: FormFields<string>, name: string, literalCount: number): boolean {
  if (name === "secret" || name === "body") return true;
  const row = /^header_(\d+)_value$/.exec(name);
  if (row === null) return false;
  const kind = Object.hasOwn(fields, `header_${row[1]}_kind`)
    ? fields[`header_${row[1]}_kind`]
    : "";
  return Number(row[1]) < literalCount || kind !== "env";
}

/** The input of a failed POST that may be shown again. Own keys of known fields only. */
export function retainedInputOf(
  fields: FormFields<string>,
  stored: StoredRows | undefined,
): RetainedInput {
  const literalCount = stored?.literalHeaders.length ?? 0;
  const values: Record<string, string> = {};
  const dropped = new Set<string>();
  for (const name of CHECK_FORM_FIELDS) {
    const value = Object.hasOwn(fields, name) ? (fields[name] ?? "") : "";
    if (value === "") continue;
    if (isWriteOnly(fields, name, literalCount)) dropped.add(name);
    else values[name] = value;
  }
  return { values, dropped };
}

/** The defaults of a new check of `type`. */
export function createInputOf(type: CheckType): RetainedInput {
  const defaults: Record<CheckType, Record<string, string>> = {
    http: { method: "GET", retries: "0" },
    tls: { port: "443", warn_days: "14" },
    tcp: { retries: "0" },
    dns: { record_type: "A", retries: "0" },
    domain: { warn_days: "30", interval_ms: "86400000", retries: "0" },
    heartbeat: { grace_ms: "0" },
  };
  return { values: defaults[type], dropped: new Set() };
}

const SCALAR_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["name", "name"],
  ["availabilityTarget", "availability_target"],
  ["url", "url"],
  ["method", "method"],
  ["intervalMs", "interval_ms"],
  ["timeoutMs", "timeout_ms"],
  ["retries", "retries"],
  ["retryDelayMs", "retry_delay_ms"],
  ["latencyObjectiveMs", "latency_objective_ms"],
  ["keyword", "keyword"],
  ["host", "host"],
  ["port", "port"],
  ["warnDays", "warn_days"],
  ["dnsName", "dns_name"],
  ["recordType", "record_type"],
  ["resolver", "resolver"],
  ["domain", "domain"],
  ["period", "period_ms"],
  ["grace", "grace_ms"],
];

function scalarValues(view: Readonly<Record<string, unknown>>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, field] of SCALAR_FIELDS) {
    const value = Object.hasOwn(view, key) ? view[key] : undefined;
    if (typeof value === "string" || typeof value === "number") values[field] = String(value);
  }
  const status = view.expectedStatus;
  if (Array.isArray(status)) values.expected_status = status.join(", ");
  if (Array.isArray(view.expected)) values.expected = view.expected.join("\n");
  return values;
}

function envRowValues(view: AdminCheckView, firstFree: number): Record<string, string> {
  const values: Record<string, string> = {};
  if (!("headers" in view) || view.headers === undefined) return values;
  let i = firstFree;
  for (const [name, value] of Object.entries(view.headers)) {
    if (typeof value !== "object" || !("env" in value) || i >= HEADER_ROWS) continue;
    values[`header_${i}_name`] = name;
    values[`header_${i}_kind`] = "env";
    values[`header_${i}_value`] = value.env;
    i++;
  }
  return values;
}

function assertValues(view: AdminCheckView): Record<string, string> {
  const values: Record<string, string> = {};
  if (!("jsonAssert" in view) || view.jsonAssert === undefined) return values;
  view.jsonAssert.slice(0, ASSERT_ROWS).forEach((assertion, i) => {
    values[`assert_${i}_pointer`] = assertion.pointer;
    const hasEquals = Object.hasOwn(assertion, "equals");
    values[`assert_${i}_mode`] = hasEquals ? "equals" : "exists";
    if (hasEquals) values[`assert_${i}_equals`] = JSON.stringify(assertion.equals);
  });
  return values;
}

/** The edit form input of a trusted stored view. Write-only values are never in it. */
export function editInputOf(view: AdminCheckView): RetainedInput {
  const stored = storedRowsOf(view);
  return {
    values: {
      ...scalarValues(view),
      ...envRowValues(view, stored.literalHeaders.length),
      ...assertValues(view),
    },
    dropped: new Set(),
  };
}

type Ctx = {
  model: EditorModel;
  errorOf: (field: string) => string | undefined;
  value: (field: string) => string;
};

function errorParts(ctx: Ctx, name: string): { attrs: string; text: string } {
  const error = ctx.errorOf(name);
  if (error === undefined) return { attrs: "", text: "" };
  return {
    attrs: ` aria-describedby="field-${name}-error" aria-invalid="true"`,
    text: `\n<span class="error" id="field-${name}-error">${escapeHtml(error)}</span>`,
  };
}

function notKept(ctx: Ctx, name: string): string {
  return ctx.model.input.dropped.has(name)
    ? `\n<span class="hint">${escapeHtml(NOT_KEPT_TEXT)}</span>`
    : "";
}

type InputSpec = {
  label: string;
  name: string;
  isRequired?: boolean;
  isNumeric?: boolean;
  type?: "text" | "url" | "password";
  autocomplete?: string;
  hint?: string;
  /** Defaults to `narrow` for a numeric input. */
  width?: FieldWidth;
};

function input(ctx: Ctx, spec: InputSpec): string {
  const err = errorParts(ctx, spec.name);
  const type = spec.type ?? "text";
  const value = type === "password" ? "" : ctx.value(spec.name);
  const attrs = [
    spec.isNumeric === true ? ` inputmode="numeric" pattern="[0-9]*"` : "",
    spec.isRequired === true ? " required" : "",
    ` autocomplete="${spec.autocomplete ?? "off"}"`,
    value === "" ? "" : ` value="${escapeHtml(value)}"`,
  ].join("");
  const hint =
    spec.hint === undefined ? "" : `\n<span class="hint">${escapeHtml(spec.hint)}</span>`;
  return `<label for="field-${spec.name}">${escapeHtml(spec.label)}
<input id="field-${spec.name}"${widthClass(spec.width ?? (spec.isNumeric === true ? "narrow" : undefined))} name="${spec.name}" type="${type}"${attrs}${err.attrs}>${hint}${notKept(ctx, spec.name)}${err.text}
</label>
`;
}

function msInput(ctx: Ctx, label: string, name: string, isRequired = false): string {
  return input(ctx, { label: `${label} (ms)`, name, isNumeric: true, isRequired });
}

function select(
  ctx: Ctx,
  label: string,
  name: string,
  options: readonly string[],
  width?: FieldWidth,
): string {
  const err = errorParts(ctx, name);
  const current = ctx.value(name);
  const items = options
    .map((o) => `<option${o === current ? " selected" : ""}>${escapeHtml(o)}</option>`)
    .join("");
  return `<label for="field-${name}">${escapeHtml(label)}
<select id="field-${name}"${widthClass(width)} name="${name}"${err.attrs}>${items}</select>${err.text}
</label>
`;
}

function textarea(ctx: Ctx, label: string, name: string, isWriteOnly = false): string {
  const err = errorParts(ctx, name);
  const value = isWriteOnly ? "" : ctx.value(name);
  return `<label for="field-${name}">${escapeHtml(label)}
<textarea id="field-${name}" name="${name}" rows="4"${err.attrs}>${escapeHtml(value)}</textarea>${notKept(ctx, name)}${err.text}
</label>
`;
}

type Choice = { value: string; label: string };

/** A radio group; the first choice is the default when nothing was posted. */
function radios(ctx: Ctx, legend: string, name: string, choices: readonly Choice[]): string {
  const err = errorParts(ctx, name);
  const posted = ctx.value(name);
  const current = choices.some((c) => c.value === posted) ? posted : choices[0]?.value;
  const items = choices
    .map(
      (c) =>
        `<label class="choice"><input type="radio" name="${name}" value="${c.value}"${c.value === current ? " checked" : ""}><span>${escapeHtml(c.label)}</span></label>`,
    )
    .join("\n");
  return `<fieldset id="field-${name}"${err.attrs}>
<legend>${escapeHtml(legend)}</legend>
${items}${err.text}
</fieldset>
`;
}

const KEEP: Choice = { value: "keep", label: "Keep" };
const REPLACE: Choice = { value: "replace", label: "Replace" };
const REMOVE: Choice = { value: "remove", label: "Remove" };

function commonFields(ctx: Ctx): string {
  const stored = ctx.model.stored;
  const id =
    stored === undefined
      ? input(ctx, {
          label: "Id",
          name: "id",
          isRequired: true,
          width: "medium",
          hint: "Letters, digits, dot, underscore and hyphen. It cannot change later.",
        })
      : `<p>Id: <code>${escapeHtml(stored.id)}</code></p>\n`;
  return `${id}${input(ctx, { label: "Name", name: "name", isRequired: true, width: "medium" })}${input(
    ctx,
    {
      label: "Availability target (%)",
      name: "availability_target",
      width: "narrow",
      hint: "From 90 to below 100, for example 99.9. Empty means no target.",
    },
  )}`;
}

function storedHeaderRow(ctx: Ctx, i: number, name: string): string {
  return `<fieldset class="editor-row">
<legend>Header ${escapeHtml(name)}</legend>
<p>Value: set</p>
${radios(ctx, `What to do with ${name}`, `header_${i}_intent`, [KEEP, REPLACE, REMOVE])}${input(
  ctx,
  { label: "New value (Plain value (not secret))", name: `header_${i}_value` },
)}</fieldset>
`;
}

function freeHeaderRow(ctx: Ctx, i: number): string {
  return `<fieldset class="editor-row">
<legend>Header row ${i + 1}</legend>
${input(ctx, { label: "Name", name: `header_${i}_name`, width: "medium" })}${radios(
  ctx,
  "Kind",
  `header_${i}_kind`,
  [
    { value: "plain", label: "Plain value (not secret)" },
    { value: "env", label: "Secret from the probe environment" },
  ],
)}${input(ctx, {
  label: "Value, or the variable name (PULSE_HEADER_…) for a secret",
  name: `header_${i}_value`,
})}</fieldset>
`;
}

function usedFreeRows(ctx: Ctx, from: number): number {
  let used = 0;
  for (let i = from; i < HEADER_ROWS; i++) {
    const isUsed =
      ctx.value(`header_${i}_name`) !== "" || ctx.model.input.dropped.has(`header_${i}_value`);
    if (isUsed) used = i - from + 1;
  }
  return used;
}

function headerRows(ctx: Ctx): string {
  const literal = ctx.model.stored?.literalHeaders ?? [];
  const existing = literal.length + usedFreeRows(ctx, literal.length);
  const visible = Math.min(HEADER_ROWS, Math.max(existing + 3, 5));
  const rows = Array.from({ length: HEADER_ROWS }, (_, i) => {
    const name = literal[i];
    return name === undefined ? freeHeaderRow(ctx, i) : storedHeaderRow(ctx, i, name);
  });
  const more =
    visible < HEADER_ROWS
      ? `<details>\n<summary>More rows</summary>\n${rows.slice(visible).join("")}</details>\n`
      : "";
  return `<details open>
<summary>Headers</summary>
${rows.slice(0, visible).join("")}${more}</details>
`;
}

function bindingsOf(ctx: Ctx): HostBinding[] {
  let host: string;
  try {
    host = new URL(ctx.value("url")).hostname;
  } catch {
    // No valid URL yet, so there is no host to bind.
    return [];
  }
  const bindings: HostBinding[] = [];
  const first = ctx.model.stored?.literalHeaders.length ?? 0;
  for (let i = first; i < HEADER_ROWS; i++) {
    const variable = ctx.value(`header_${i}_value`);
    if (ctx.value(`header_${i}_kind`) === "env" && variable !== "") {
      bindings.push({ variable, host });
    }
  }
  return bindings;
}

function hostBindingBlock(ctx: Ctx): string {
  const bindings = bindingsOf(ctx);
  if (bindings.length === 0) return "";
  const names = bindings.map((b) => b.variable).join(", ");
  return `<section>
<h2>Probe host binding</h2>
${paragraph(`Merge this into the value that each probe already has, and set ${names} in the probe environment.`)}<pre id="editor-host-binding-line">${escapeHtml(hostBindingLine(bindings))}</pre>
<button type="button" class="secondary small" data-copy="editor-host-binding-line" hidden>Copy</button>
</section>
`;
}

function assertRow(ctx: Ctx, i: number): string {
  return `<fieldset class="editor-row">
<legend>JSON assertion ${i + 1}</legend>
${input(ctx, { label: "JSON pointer", name: `assert_${i}_pointer` })}${radios(
  ctx,
  "Rule",
  `assert_${i}_mode`,
  [
    { value: "none", label: "Not used" },
    { value: "exists", label: "Exists" },
    { value: "equals", label: "Equals" },
  ],
)}${input(ctx, { label: "Equals (JSON value)", name: `assert_${i}_equals` })}</fieldset>
`;
}

function bodyField(ctx: Ctx): string {
  if (ctx.model.stored?.hasBody !== true) return textarea(ctx, "Body", "body", true);
  return `<fieldset class="editor-row">
<legend>Body</legend>
<p>Body: set</p>
${radios(ctx, "What to do with the body", "body_intent", [KEEP, REPLACE, REMOVE])}${textarea(ctx, "New body", "body", true)}</fieldset>
`;
}

function retryFields(ctx: Ctx): string {
  return `${msInput(ctx, "Timeout", "timeout_ms")}${input(ctx, { label: "Retries (0 to 10)", name: "retries", isNumeric: true })}${msInput(ctx, "Retry delay", "retry_delay_ms")}`;
}

function httpFields(ctx: Ctx): string {
  const asserts = Array.from({ length: ASSERT_ROWS }, (_, i) => assertRow(ctx, i)).join("");
  return `${input(ctx, { label: "URL", name: "url", type: "url", isRequired: true })}${select(ctx, "Method", "method", HTTP_METHODS, "narrow")}${msInput(ctx, "Interval", "interval_ms", true)}${retryFields(ctx)}${msInput(ctx, "Latency objective", "latency_objective_ms")}${input(
    ctx,
    {
      label: "Expected status",
      name: "expected_status",
      hint: "Codes or ranges, for example 200, 204 or 200-299. Empty means 200-299.",
    },
  )}${input(ctx, { label: "Keyword", name: "keyword" })}${bodyField(ctx)}${headerRows(ctx)}${hostBindingBlock(ctx)}<details open>
<summary>JSON assertions</summary>
${asserts}</details>
`;
}

function secretField(ctx: Ctx): string {
  const password: InputSpec = {
    label: "Secret",
    name: "secret",
    type: "password",
    autocomplete: "new-password",
    hint: "16 to 128 characters: letters, digits, dot, underscore, tilde and hyphen.",
  };
  if (ctx.model.stored === undefined) {
    return input(ctx, { ...password, isRequired: true });
  }
  return `<fieldset class="editor-row">
<legend>Secret</legend>
<p>Secret: ${ctx.model.stored.hasSecret ? "set" : "not set"}</p>
${radios(ctx, "What to do with the secret", "secret_intent", [KEEP, REPLACE])}${input(ctx, { ...password, label: "New secret" })}</fieldset>
`;
}

function typeFields(ctx: Ctx): string {
  const type = ctx.model.type;
  switch (type) {
    case "http":
      return httpFields(ctx);
    case "tls":
      return `${paragraph(TLS_NOTE_TEXT)}${input(ctx, { label: "Host", name: "host", isRequired: true })}${input(ctx, { label: "Port", name: "port", isNumeric: true })}${input(ctx, { label: "Warn days before expiry (0 to 3650)", name: "warn_days", isNumeric: true })}${msInput(ctx, "Interval", "interval_ms", true)}${msInput(ctx, "Timeout", "timeout_ms")}`;
    case "tcp":
      return `${input(ctx, { label: "Host", name: "host", isRequired: true })}${input(ctx, { label: "Port", name: "port", isNumeric: true, isRequired: true })}${msInput(ctx, "Interval", "interval_ms", true)}${retryFields(ctx)}`;
    case "dns":
      return `${input(ctx, { label: "DNS name", name: "dns_name", isRequired: true })}${select(ctx, "Record type", "record_type", DNS_RECORD_TYPES, "narrow")}${textarea(ctx, "Expected values (one per line)", "expected")}${input(ctx, { label: "Resolver (IPv4 or IPv6)", name: "resolver" })}${msInput(ctx, "Interval", "interval_ms", true)}${retryFields(ctx)}`;
    case "domain":
      return `${input(ctx, { label: "Domain", name: "domain", isRequired: true })}${input(ctx, { label: "Warn days before expiry (0 to 3650)", name: "warn_days", isNumeric: true })}${input(ctx, { label: "Interval (ms)", name: "interval_ms", isNumeric: true, isRequired: true, hint: "At least 3600000 (one hour)." })}${retryFields(ctx)}`;
    case "heartbeat":
      return `${msInput(ctx, "Period", "period_ms", true)}${msInput(ctx, "Grace", "grace_ms")}${secretField(ctx)}`;
    default: {
      const never: never = type;
      return never;
    }
  }
}

/** An error that belongs to no single field, such as one the contract finds. */
function formWideError(ctx: Ctx): string {
  return ["check", "type"]
    .map((key) => {
      const message = ctx.errorOf(key);
      return message === undefined
        ? ""
        : `<p class="error" id="field-${key}">${escapeHtml(message)}</p>\n`;
    })
    .join("");
}

/** The form action of the editor. */
function actionOf(model: EditorModel): string {
  return model.stored === undefined
    ? `/checks/new?type=${model.type}`
    : `/checks/edit${idQuery(model.stored.id)}`;
}

/** The editor HTML of a create or edit form; every value goes through escapeHtml. */
export function checkEditorHtml(model: EditorModel): string {
  const errors = new Map<string, string>();
  for (const e of model.errors) if (!errors.has(e.field)) errors.set(e.field, e.message);
  const ctx: Ctx = {
    model,
    errorOf: (field) => errors.get(field),
    value: (field) => model.input.values[field] ?? "",
  };
  const isEdit = model.stored !== undefined;
  const typeField = isEdit ? "" : `<input type="hidden" name="type" value="${model.type}">\n`;
  const summary = formErrorSummary(model.errors.map((e) => ({ name: e.field, text: e.message })));
  const quorum = model.type === "heartbeat" ? HEARTBEAT_QUORUM_TEXT : PROBE_QUORUM_TEXT;
  return `${summary}<form method="post" action="${escapeHtml(actionOf(model))}" class="check-editor" novalidate>
${csrfField(model.csrf)}
${formTokenField(model.formToken)}
${typeField}<input type="hidden" name="revision" value="${escapeHtml(model.revision)}">
<p>Type: ${TYPE_LABELS[model.type]}</p>
${formWideError(ctx)}${commonFields(ctx)}${typeFields(ctx)}${paragraph(quorum, ' class="quorum-rule"')}<div class="actions">${submitButton({ label: isEdit ? "Save check" : "Create check", busyLabel: "Saving…" })}</div>
</form>
`;
}

const TYPE_EXPLANATIONS: Record<CheckType, string> = {
  http: "Requests a URL and checks the status, a keyword or JSON values.",
  tls: "Warns before the certificate of a host expires.",
  tcp: "Opens a TCP connection to a host and port.",
  dns: "Resolves a name and compares the records.",
  domain: "Warns before a domain registration expires.",
  heartbeat: "Your job pings pulse-api; no ping in time means down.",
};

/** R4: the six type choices of `GET /checks/new`, each a link with a one-line explanation. */
export function checkTypeChoiceHtml(): string {
  const items = CHECK_TYPES.map(
    (type) =>
      `<li class="panel"><a href="/checks/new?type=${type}">${TYPE_LABELS[type]}</a>: ${escapeHtml(TYPE_EXPLANATIONS[type])}</li>`,
  ).join("\n");
  return `<p>Choose the type of the new check.</p>
<ul class="type-choice">
${items}
</ul>
`;
}
