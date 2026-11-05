import {
  type AdminCheckInput,
  type AdminCheckView,
  HEADER_ENV_PREFIX,
  MAX_TIMER_MS,
  MIN_DOMAIN_INTERVAL_MS,
  validateAdminCheckInput,
} from "@lorenzh/pulse-contract";
import type { FormFields } from "./forms.ts";

/** The six check types, in the order of the type choice page. */
export const CHECK_TYPES = ["http", "tls", "tcp", "dns", "domain", "heartbeat"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export const HEADER_ROWS = 20;
export const ASSERT_ROWS = 10;
export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS"] as const;

export const PROTO_HEADER_TEXT = "__proto__ is not an allowed header name.";
export const DUPLICATE_HEADER_TEXT =
  "This header is already set in another row (names are compared without case).";
export const CHOOSE_REPLACE_TEXT = "Choose Replace to use the new value.";
export const ENTER_NEW_VALUE_TEXT = "Enter the new value, or choose Remove.";
export const BODY_METHOD_TEXT = "A body needs POST, PUT, PATCH, DELETE or OPTIONS.";
export const JSON_VALUE_TEXT = 'Enter a JSON value, for example "ok", 200 or true.';

const rowFields = (count: number, parts: readonly string[], prefix: string): string[] =>
  Array.from({ length: count }, (_, i) => parts.map((part) => `${prefix}_${i}_${part}`)).flat();

/** Every field name of the editor form, for all types; a handler reads only those of its type. */
export const CHECK_FORM_FIELDS: readonly string[] = [
  "type",
  "revision",
  "id",
  "name",
  "availability_target",
  "url",
  "method",
  "interval_ms",
  "timeout_ms",
  "retries",
  "retry_delay_ms",
  "latency_objective_ms",
  "expected_status",
  "keyword",
  "body",
  "body_intent",
  "host",
  "port",
  "warn_days",
  "dns_name",
  "record_type",
  "expected",
  "resolver",
  "domain",
  "period_ms",
  "grace_ms",
  "secret",
  "secret_intent",
  ...rowFields(HEADER_ROWS, ["name", "kind", "value", "intent"], "header"),
  ...rowFields(ASSERT_ROWS, ["pointer", "mode", "equals"], "assert"),
];

export type FieldError = { field: string; message: string };

export type CheckFormResult =
  | { isOk: true; input: AdminCheckInput }
  | { isOk: false; errors: readonly FieldError[] };

/** What an edit takes from the trusted stored view, never from the form (Decision 8). */
type Stored = {
  type: CheckType;
  id: string;
  literalHeaders: readonly string[];
  hasBody: boolean;
};

type Reader = {
  fields: FormFields<string>;
  errors: FieldError[];
};

type Built = Record<string, unknown>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CONTROL = /\p{Cc}/u;
const AVAILABILITY = /^\d{1,2}(\.\d{1,3})?$/;
const DIGITS = /^\d{1,10}$/;
const STATUS_CODE = /^\d{3}$/;
const STATUS_RANGE = /^(\d{3})-(\d{3})$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;
const HEADER_VALUE = /^[\x20-\x7e\x80-\xff]{0,4096}$/;
const ENV_NAME = new RegExp(`^${HEADER_ENV_PREFIX}\\w{1,115}$`);
const PROBE_HEADERS: readonly string[] = [
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "user-agent",
];
const SECRET = /^[A-Za-z0-9._~-]{16,128}$/;

/** The raw value of a field, or "" when absent. Own keys only. */
function raw(r: Reader, field: string): string {
  return Object.hasOwn(r.fields, field) ? (r.fields[field] ?? "") : "";
}

function fail(r: Reader, field: string, message: string): undefined {
  if (!r.errors.some((error) => error.field === field)) r.errors.push({ field, message });
  return undefined;
}

const optional = (key: string, value: unknown): Built =>
  value === undefined ? {} : { [key]: value };

type IntRule = { min: number; max: number; fallback?: number; isRequired?: boolean; unit?: "ms" };

/** A whole number field: empty is the fallback, absent, or an error when required. */
function intField(r: Reader, field: string, rule: IntRule): number | undefined {
  const text = raw(r, field).trim();
  const range = `from ${rule.min} to ${rule.max}${rule.unit === "ms" ? " ms" : ""}`;
  if (text === "") {
    if (rule.fallback !== undefined) return rule.fallback;
    return rule.isRequired === true ? fail(r, field, `Enter a whole number ${range}.`) : undefined;
  }
  const value = DIGITS.test(text) ? Number(text) : Number.NaN;
  if (!(value >= rule.min && value <= rule.max)) {
    return fail(r, field, `Enter a whole number ${range}.`);
  }
  return value;
}

const intervalRule: IntRule = { min: 1, max: MAX_TIMER_MS, isRequired: true, unit: "ms" };
const timeoutRule: IntRule = { min: 1, max: MAX_TIMER_MS, unit: "ms" };
const retriesRule: IntRule = { min: 0, max: 10 };
const retryDelayRule: IntRule = { min: 0, max: 60_000, unit: "ms" };
const portRule: IntRule = { min: 1, max: 65_535, isRequired: true };

function requiredText(r: Reader, field: string, message: string): string | undefined {
  const text = raw(r, field).trim();
  return text === "" ? fail(r, field, message) : text;
}

function oneOf<T extends string>(
  r: Reader,
  field: string,
  allowed: readonly T[],
  fallback: T | undefined,
  message: string,
): T | undefined {
  const text = raw(r, field);
  if (text === "" && fallback !== undefined) return fallback;
  const found = allowed.find((value) => value === text);
  return found ?? fail(r, field, message);
}

function idField(r: Reader): string | undefined {
  const id = raw(r, "id");
  return ID.test(id)
    ? id
    : fail(
        r,
        "id",
        "Use 1 to 100 letters, digits, dots, underscores or hyphens, starting with a letter or digit.",
      );
}

function nameField(r: Reader): string | undefined {
  const name = raw(r, "name").trim();
  return name.length >= 1 && name.length <= 200 && !CONTROL.test(name)
    ? name
    : fail(r, "name", "Enter a name of 1 to 200 characters without control characters.");
}

function availabilityField(r: Reader): number | undefined {
  const text = raw(r, "availability_target").trim();
  if (text === "") return undefined;
  const value = AVAILABILITY.test(text) ? Number(text) : Number.NaN;
  return value >= 90 && value < 100
    ? value
    : fail(
        r,
        "availability_target",
        "Enter a percentage from 90 up to but not including 100, with at most three decimals.",
      );
}

/** One item as a one-element list, or an empty list when it is no code or range. */
function statusItem(item: string): (number | string)[] {
  if (STATUS_CODE.test(item)) {
    const code = Number(item);
    return code >= 100 && code <= 599 ? [code] : [];
  }
  const match = STATUS_RANGE.exec(item);
  if (match === null) return [];
  const [lo, hi] = [Number(match[1]), Number(match[2])];
  return lo >= 100 && lo <= hi && hi <= 599 ? [item] : [];
}

function expectedStatusField(r: Reader): (number | string)[] | undefined {
  const text = raw(r, "expected_status").trim();
  if (text === "") return undefined;
  const items = text.split(",");
  const parsed = items.flatMap((item) => statusItem(item.trim()));
  return parsed.length === items.length && parsed.length <= 20
    ? parsed
    : fail(
        r,
        "expected_status",
        "Enter up to 20 status codes or ranges, separated by commas, such as 200, 204 or 200-299.",
      );
}

function urlField(r: Reader): string | undefined {
  const text = raw(r, "url").trim();
  const message = "Enter an http:// or https:// URL without a user name or password.";
  if (!URL.canParse(text)) return fail(r, "url", message);
  const url = new URL(text);
  const isHttp = url.protocol === "http:" || url.protocol === "https:";
  return isHttp && url.username === "" && url.password === "" ? text : fail(r, "url", message);
}

/** The intent of a stored write-only value; `keep` when the field is absent. */
function intentOf(r: Reader, field: string): "keep" | "replace" | "remove" | undefined {
  return oneOf(r, field, ["keep", "replace", "remove"], "keep", "Choose Keep, Replace or Remove.");
}

type StoredWrite =
  | { kind: "keep" }
  | { kind: "replace"; value: string }
  | { kind: "remove" }
  | { kind: "invalid" };

const INVALID: StoredWrite = { kind: "invalid" };

/** What the intent of a stored write-only value asks for; `invalid` after a field error. */
function storedValue(r: Reader, intentField: string, valueField: string): StoredWrite {
  const value = raw(r, valueField);
  const intent = intentOf(r, intentField);
  switch (intent) {
    case "keep":
      return value === ""
        ? { kind: "keep" }
        : (fail(r, valueField, CHOOSE_REPLACE_TEXT) ?? INVALID);
    case "replace":
      return value === ""
        ? (fail(r, valueField, ENTER_NEW_VALUE_TEXT) ?? INVALID)
        : { kind: "replace", value };
    case "remove":
      return { kind: "remove" };
    case undefined:
      return INVALID;
    default: {
      const never: never = intent;
      return never;
    }
  }
}

function literalValue(r: Reader, field: string, value: string): string | undefined {
  return HEADER_VALUE.test(value)
    ? value
    : fail(r, field, "Enter at most 4096 visible ASCII characters or spaces.");
}

type HeaderEntry = [string, unknown];

/** One stored literal row: its name comes from the view; only intent and value are read. */
function storedHeader(r: Reader, i: number, name: string, seen: Set<string>): HeaderEntry[] {
  const valueField = `header_${i}_value`;
  const write = storedValue(r, `header_${i}_intent`, valueField);
  if (write.kind === "remove") return [];
  seen.add(name.toLowerCase());
  if (write.kind === "invalid") return [];
  if (write.kind === "keep") return [[name, { keep: true }]];
  const literal = literalValue(r, valueField, write.value);
  return literal === undefined ? [] : [[name, literal]];
}

function headerNameProblem(name: string, seen: Set<string>): string | undefined {
  if (name === "__proto__") return PROTO_HEADER_TEXT;
  const lower = name.toLowerCase();
  if (seen.has(lower)) return DUPLICATE_HEADER_TEXT;
  seen.add(lower);
  if (!HEADER_NAME.test(name)) {
    return "Enter a header name of 1 to 256 letters, digits or the characters !#$%&'*+.^_`|~-.";
  }
  return PROBE_HEADERS.includes(lower) ? "The probe sets this header itself." : undefined;
}

function freeHeaderValue(r: Reader, i: number): unknown {
  const valueField = `header_${i}_value`;
  const value = raw(r, valueField);
  const kind = oneOf(
    r,
    `header_${i}_kind`,
    ["plain", "env"],
    "plain",
    "Choose Plain value or Secret from the probe environment.",
  );
  if (kind === "plain") return literalValue(r, valueField, value);
  if (kind === undefined) return undefined;
  return ENV_NAME.test(value.trim())
    ? { env: value.trim() }
    : fail(
        r,
        valueField,
        `Enter a variable name that starts with ${HEADER_ENV_PREFIX}, then letters, digits or _.`,
      );
}

/** One free row: ignored when name and value are empty. The name checks run before any value. */
function freeHeader(r: Reader, i: number, seen: Set<string>): HeaderEntry[] {
  const name = raw(r, `header_${i}_name`).trim();
  if (name === "" && raw(r, `header_${i}_value`) === "") return [];
  const nameField = `header_${i}_name`;
  if (name === "") return fail(r, nameField, "Enter a header name.") ?? [];
  const problem = headerNameProblem(name, seen);
  if (problem !== undefined) return fail(r, nameField, problem) ?? [];
  const value = freeHeaderValue(r, i);
  return value === undefined ? [] : [[name, value]];
}

/**
 * Header rows in index order: stored literal rows first (names from the view), then free rows.
 * Duplicates are found on the names before any object is built, so `Object.fromEntries` never
 * collapses two rows into one.
 */
function headersField(r: Reader, stored: Stored | undefined): Built | undefined {
  const seen = new Set<string>();
  const literalNames = stored?.literalHeaders ?? [];
  const entries: HeaderEntry[] = [];
  literalNames.forEach((name, i) => {
    entries.push(...storedHeader(r, i, name, seen));
  });
  for (let i = literalNames.length; i < HEADER_ROWS; i++) {
    entries.push(...freeHeader(r, i, seen));
  }
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function bodyField(r: Reader, stored: Stored | undefined): unknown {
  if (stored?.hasBody !== true) {
    const body = raw(r, "body");
    return body === "" ? undefined : body;
  }
  const write = storedValue(r, "body_intent", "body");
  if (write.kind === "keep") return { keep: true };
  return write.kind === "replace" ? write.value : undefined;
}

function assertRow(r: Reader, i: number): Built | undefined {
  const mode = oneOf(
    r,
    `assert_${i}_mode`,
    ["none", "exists", "equals"],
    "none",
    "Choose No check, Exists or Equals.",
  );
  if (mode === "none" || mode === undefined) return undefined;
  const pointer = raw(r, `assert_${i}_pointer`).trim();
  if (pointer !== "" && !pointer.startsWith("/")) {
    return fail(
      r,
      `assert_${i}_pointer`,
      "Enter a JSON pointer such as /status, or leave it empty for the whole body.",
    );
  }
  if (mode === "exists") return { pointer, exists: true };
  try {
    return { pointer, equals: JSON.parse(raw(r, `assert_${i}_equals`)) };
  } catch {
    // The parse error text is not shown: the field message says what to enter.
    return fail(r, `assert_${i}_equals`, JSON_VALUE_TEXT);
  }
}

function assertionsField(r: Reader): Built[] | undefined {
  const rows: Built[] = [];
  for (let i = 0; i < ASSERT_ROWS; i++) {
    const row = assertRow(r, i);
    if (row !== undefined) rows.push(row);
  }
  return rows.length === 0 ? undefined : rows;
}

function httpFields(r: Reader, stored: Stored | undefined): Built {
  const method = oneOf(r, "method", HTTP_METHODS, "GET", "Choose a method.");
  const keyword = raw(r, "keyword");
  const body = bodyField(r, stored);
  const jsonAssert = assertionsField(r);
  if (body !== undefined && (method === "GET" || method === "HEAD")) {
    fail(r, "body", BODY_METHOD_TEXT);
  }
  if (method === "HEAD" && (keyword !== "" || jsonAssert !== undefined)) {
    fail(r, "method", "HEAD reads no body, so it allows no keyword and no JSON assertion.");
  }
  return {
    url: urlField(r),
    method,
    intervalMs: intField(r, "interval_ms", intervalRule),
    ...optional("timeoutMs", intField(r, "timeout_ms", timeoutRule)),
    ...optional("retries", intField(r, "retries", retriesRule)),
    ...optional("retryDelayMs", intField(r, "retry_delay_ms", retryDelayRule)),
    ...optional("latencyObjectiveMs", intField(r, "latency_objective_ms", timeoutRule)),
    ...optional("expectedStatus", expectedStatusField(r)),
    ...optional("keyword", keyword === "" ? undefined : keyword),
    ...optional("headers", headersField(r, stored)),
    ...optional("body", body),
    ...optional("jsonAssert", jsonAssert),
  };
}

function retryFields(r: Reader): Built {
  return {
    ...optional("timeoutMs", intField(r, "timeout_ms", timeoutRule)),
    ...optional("retries", intField(r, "retries", retriesRule)),
    ...optional("retryDelayMs", intField(r, "retry_delay_ms", retryDelayRule)),
  };
}

function tlsFields(r: Reader): Built {
  return {
    type: "tls",
    host: requiredText(r, "host", "Enter a host name."),
    port: intField(r, "port", { ...portRule, fallback: 443 }),
    warnDays: intField(r, "warn_days", { min: 0, max: 3650, fallback: 14 }),
    intervalMs: intField(r, "interval_ms", intervalRule),
    ...optional("timeoutMs", intField(r, "timeout_ms", timeoutRule)),
  };
}

function tcpFields(r: Reader): Built {
  return {
    type: "tcp",
    host: requiredText(r, "host", "Enter a host name."),
    port: intField(r, "port", portRule),
    intervalMs: intField(r, "interval_ms", intervalRule),
    ...retryFields(r),
  };
}

function dnsExpectedField(r: Reader): string[] | undefined {
  const values = raw(r, "expected")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (values.length === 0) return undefined;
  return values.length <= 20 ? values : fail(r, "expected", "Enter at most 20 values.");
}

function dnsFields(r: Reader): Built {
  const resolver = raw(r, "resolver").trim();
  return {
    type: "dns",
    dnsName: requiredText(r, "dns_name", "Enter a DNS name."),
    recordType: oneOf(r, "record_type", DNS_RECORD_TYPES, undefined, "Choose a record type."),
    ...optional("expected", dnsExpectedField(r)),
    ...optional("resolver", resolver === "" ? undefined : resolver),
    intervalMs: intField(r, "interval_ms", intervalRule),
    ...retryFields(r),
  };
}

function domainFields(r: Reader): Built {
  return {
    type: "domain",
    domain: requiredText(r, "domain", "Enter a domain name."),
    warnDays: intField(r, "warn_days", { min: 0, max: 3650, fallback: 30 }),
    intervalMs: intField(r, "interval_ms", {
      ...intervalRule,
      min: MIN_DOMAIN_INTERVAL_MS,
      fallback: 86_400_000,
    }),
    ...retryFields(r),
  };
}

function newSecret(r: Reader): string | undefined {
  const secret = raw(r, "secret");
  if (secret === "") return fail(r, "secret", "Enter a secret.");
  return SECRET.test(secret) && !secret.startsWith("replace-with-")
    ? secret
    : fail(
        r,
        "secret",
        "Enter 16 to 128 letters, digits or the characters . _ ~ -, not starting with replace-with-.",
      );
}

function secretField(r: Reader, stored: Stored | undefined): string | undefined {
  if (stored === undefined) return newSecret(r);
  const intent = oneOf(r, "secret_intent", ["keep", "replace"], "keep", "Choose Keep or Replace.");
  if (intent === "replace") return newSecret(r);
  if (intent === "keep" && raw(r, "secret") !== "") fail(r, "secret", CHOOSE_REPLACE_TEXT);
  return undefined;
}

function heartbeatFields(r: Reader, stored: Stored | undefined): Built {
  return {
    type: "heartbeat",
    period: intField(r, "period_ms", {
      min: 1000,
      max: 86_400_000,
      isRequired: true,
      unit: "ms",
    }),
    grace: intField(r, "grace_ms", { min: 0, max: 86_400_000, fallback: 0, unit: "ms" }),
    ...optional("secret", secretField(r, stored)),
  };
}

function typeFields(r: Reader, type: CheckType, stored: Stored | undefined): Built {
  switch (type) {
    case "http":
      return httpFields(r, stored);
    case "tls":
      return tlsFields(r);
    case "tcp":
      return tcpFields(r);
    case "dns":
      return dnsFields(r);
    case "domain":
      return domainFields(r);
    case "heartbeat":
      return heartbeatFields(r, stored);
    default: {
      const never: never = type;
      return never;
    }
  }
}

/** Form field of a contract input key, for an error the contract finds after the local rules. */
const FIELD_OF_KEY: Readonly<Record<string, string>> = {
  id: "id",
  name: "name",
  availabilityTarget: "availability_target",
  url: "url",
  method: "method",
  intervalMs: "interval_ms",
  timeoutMs: "timeout_ms",
  retries: "retries",
  retryDelayMs: "retry_delay_ms",
  latencyObjectiveMs: "latency_objective_ms",
  expectedStatus: "expected_status",
  keyword: "keyword",
  body: "body",
  host: "host",
  port: "port",
  warnDays: "warn_days",
  dnsName: "dns_name",
  recordType: "record_type",
  expected: "expected",
  resolver: "resolver",
  domain: "domain",
  period: "period_ms",
  grace: "grace_ms",
  secret: "secret",
};

const CONTRACT_KEY = /^check\.([A-Za-z]+)/;

/** Maps `check.<key>...: <text>` to the form field of `<key>`; anything else is form-wide. */
function contractError(error: string): FieldError {
  const key = CONTRACT_KEY.exec(error)?.[1] ?? "";
  const field = Object.hasOwn(FIELD_OF_KEY, key) ? FIELD_OF_KEY[key] : undefined;
  const separator = error.indexOf(": ");
  if (field === undefined || separator < 0) {
    return { field: "check", message: `pulse-api does not accept this check: ${error}.` };
  }
  return {
    field,
    message: `pulse-api does not accept this value: it ${error.slice(separator + 2)}.`,
  };
}

function parse(
  r: Reader,
  type: CheckType,
  id: string | undefined,
  stored: Stored | undefined,
): CheckFormResult {
  const built: Built = {
    id,
    name: nameField(r),
    ...typeFields(r, type, stored),
    ...optional("availabilityTarget", availabilityField(r)),
  };
  if (r.errors.length > 0) return { isOk: false, errors: r.errors };
  const checked = validateAdminCheckInput(built);
  return checked.ok
    ? { isOk: true, input: checked.value }
    : { isOk: false, errors: [contractError(checked.error)] };
}

/** True when `value` is one of the six check types. */
export function isCheckType(value: string): value is CheckType {
  return CHECK_TYPES.some((type) => type === value);
}

/** Reads a create form: the posted `type` picks the fields; only that type's fields are read. */
export function parseCreateForm(fields: FormFields<string>): CheckFormResult {
  const r: Reader = { fields, errors: [] };
  const type = raw(r, "type");
  const id = idField(r);
  if (!isCheckType(type)) {
    return { isOk: false, errors: [...r.errors, { field: "type", message: "Choose a type." }] };
  }
  return parse(r, type, id, undefined);
}

/** The parts of a stored view that an edit takes from it. */
function storedOf(view: AdminCheckView): Stored {
  if (view.type === undefined || view.type === "http") {
    const headers = Object.entries(view.headers ?? {});
    return {
      type: "http",
      id: view.id,
      literalHeaders: headers.filter(([, value]) => "keep" in value).map(([name]) => name),
      hasBody: view.body !== undefined,
    };
  }
  return { type: view.type, id: view.id, literalHeaders: [], hasBody: false };
}

/**
 * Reads an edit form against the trusted stored view of a POST-time read. The id, the type,
 * the names and order of stored literal headers, a kept body and the secret come from `view`;
 * posted `id`, `type` and `header_<i>_name`/`_kind` of a stored row are ignored.
 */
export function parseEditForm(fields: FormFields<string>, view: AdminCheckView): CheckFormResult {
  const stored = storedOf(view);
  return parse({ fields, errors: [] }, stored.type, stored.id, stored);
}
