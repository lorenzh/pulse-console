import {
  NOTIFY_SECRET_ENV_PREFIX,
  type NotifyChannelDefinition,
  type NotifyDatabaseChannelView,
  validateNotifyChannelDefinition,
} from "@lorenzh/pulse-contract";

/** The channel types that the console can store; a file channel is never stored in pulse-api. */
export const CHANNEL_TYPES = ["webhook", "slack", "teams", "email"] as const;

/** The three alert events of a channel, with their checkbox field names. */
export const ALERT_FIELDS = [
  { name: "alert_budget_low", event: "budget-low", label: "Error budget low" },
  { name: "alert_tls_expiry", event: "tls-expiry", label: "TLS certificate expiry" },
  { name: "alert_domain_expiry", event: "domain-expiry", label: "Domain expiry" },
] as const;

/** Line lists: one entry per line. */
export const LIST_FIELDS = [
  { name: "checks", key: "checks", label: "Only these checks" },
  { name: "exclude_checks", key: "excludeChecks", label: "Not these checks" },
  { name: "components", key: "components", label: "Only these components" },
  { name: "exclude_components", key: "excludeComponents", label: "Not these components" },
] as const;

/**
 * Every field of the channel form. None of them holds a secret value: secrets are reference
 * names only (Decision 12). A posted `url`, `secret` or `password` is not a known field and is
 * never read.
 */
export const CHANNEL_FORM_FIELDS = [
  "revision",
  "id",
  "type",
  ...LIST_FIELDS.map((f) => f.name),
  "remind_every_seconds",
  ...ALERT_FIELDS.map((f) => f.name),
  "send_incidents",
  "url_env",
  "url_file",
  "secret_env",
  "secret_file",
  "status_url",
  "hide_reason",
  "smtp_host",
  "smtp_port",
  "smtp_tls",
  "smtp_username",
  "smtp_password_env",
  "smtp_password_file",
  "smtp_client_name",
  "from",
  "to",
  "subject_prefix",
] as const;

export type ChannelFormField = (typeof CHANNEL_FORM_FIELDS)[number];

/** The form as shown or posted: every value is text, "" means not set. */
export type ChannelFormInput = Readonly<Partial<Record<ChannelFormField, string>>>;

export type ChannelFormError = { name: string; text: string };

export const NUMBER_INVALID_TEXT = "Enter a whole number.";
export const SWITCH_INVALID_TEXT = "Choose Not set, On or Off.";
export const TYPE_INVALID_TEXT = "Choose webhook, slack, teams or email.";

/** The env name without the fixed prefix, as the form shows it after the prefix. */
function envSuffix(name: string | undefined): string {
  if (name === undefined) return "";
  return name.startsWith(NOTIFY_SECRET_ENV_PREFIX)
    ? name.slice(NOTIFY_SECRET_ENV_PREFIX.length)
    : name;
}

function flagText(value: boolean | undefined): string {
  if (value === undefined) return "";
  return value ? "on" : "off";
}

function lines(values: readonly string[] | undefined): string {
  return values === undefined ? "" : values.join("\n");
}

function optionalText(value: string | number | undefined): string {
  return value === undefined ? "" : String(value);
}

type MessageFields = { statusUrl?: string | undefined; hideReason?: boolean | undefined };
type UrlRefs = { urlEnv?: string | undefined; urlFile?: string | undefined };

function typeInputOf(channel: NotifyDatabaseChannelView): ChannelFormInput {
  switch (channel.type) {
    case "webhook":
      return {
        ...urlRefInput(channel),
        secret_env: envSuffix(channel.secretEnv),
        secret_file: optionalText(channel.secretFile),
      };
    case "slack":
    case "teams":
      return { ...urlRefInput(channel), ...messageInput(channel) };
    case "email":
      return {
        smtp_host: channel.smtp.host,
        smtp_port: String(channel.smtp.port),
        smtp_tls: optionalText(channel.smtp.tls),
        smtp_username: optionalText(channel.smtp.username),
        smtp_password_env: envSuffix(channel.smtp.passwordEnv),
        smtp_password_file: optionalText(channel.smtp.passwordFile),
        smtp_client_name: optionalText(channel.smtp.clientName),
        from: channel.from,
        to: lines(channel.to),
        subject_prefix: optionalText(channel.subjectPrefix),
        ...messageInput(channel),
      };
    default: {
      const never: never = channel;
      return never;
    }
  }
}

function urlRefInput(channel: UrlRefs): ChannelFormInput {
  return { url_env: envSuffix(channel.urlEnv), url_file: optionalText(channel.urlFile) };
}

function messageInput(channel: MessageFields): ChannelFormInput {
  return { status_url: optionalText(channel.statusUrl), hide_reason: flagText(channel.hideReason) };
}

/** The form input of a stored database channel. */
export function channelInputOf(channel: NotifyDatabaseChannelView): ChannelFormInput {
  const input: Partial<Record<ChannelFormField, string>> = {
    id: channel.id,
    type: channel.type,
    remind_every_seconds: optionalText(channel.remindEverySeconds),
    send_incidents: flagText(channel.sendIncidents),
  };
  for (const f of LIST_FIELDS) input[f.name] = lines(channel[f.key]);
  for (const f of ALERT_FIELDS) input[f.name] = channel.alerts?.includes(f.event) ? "on" : "";
  return { ...input, ...typeInputOf(channel) };
}

type Builder = {
  document: Record<string, unknown>;
  errors: ChannelFormError[];
  input: ChannelFormInput;
};

function text(b: Builder, name: ChannelFormField): string | undefined {
  const value = b.input[name] ?? "";
  return value === "" ? undefined : value;
}

function envRef(b: Builder, name: ChannelFormField): string | undefined {
  const value = text(b, name);
  if (value === undefined) return undefined;
  return value.startsWith(NOTIFY_SECRET_ENV_PREFIX) ? value : NOTIFY_SECRET_ENV_PREFIX + value;
}

function whole(b: Builder, name: ChannelFormField): number | undefined {
  const value = text(b, name);
  if (value === undefined) return undefined;
  if (!/^\d{1,16}$/.test(value)) {
    b.errors.push({ name, text: NUMBER_INVALID_TEXT });
    return undefined;
  }
  return Number(value);
}

function flag(b: Builder, name: ChannelFormField): boolean | undefined {
  const value = text(b, name);
  if (value === undefined) return undefined;
  if (value !== "on" && value !== "off") {
    b.errors.push({ name, text: SWITCH_INVALID_TEXT });
    return undefined;
  }
  return value === "on";
}

/** A line list: a line ending is `\r\n` or `\n`, an empty line is dropped, nothing is trimmed. */
function list(b: Builder, name: ChannelFormField): string[] | undefined {
  const value = text(b, name);
  if (value === undefined) return undefined;
  const items = value.split(/\r?\n/).filter((item) => item !== "");
  return items.length === 0 ? undefined : items;
}

function setValue(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function addRouting(b: Builder): void {
  for (const f of LIST_FIELDS) setValue(b.document, f.key, list(b, f.name));
  setValue(b.document, "remindEverySeconds", whole(b, "remind_every_seconds"));
  const alerts = ALERT_FIELDS.filter((f) => text(b, f.name) !== undefined).map((f) => f.event);
  if (alerts.length > 0) b.document.alerts = alerts;
  setValue(b.document, "sendIncidents", flag(b, "send_incidents"));
}

function addUrlRefs(b: Builder): void {
  setValue(b.document, "urlEnv", envRef(b, "url_env"));
  setValue(b.document, "urlFile", text(b, "url_file"));
}

function addMessage(b: Builder): void {
  setValue(b.document, "statusUrl", text(b, "status_url"));
  setValue(b.document, "hideReason", flag(b, "hide_reason"));
}

function addEmail(b: Builder): void {
  const smtp: Record<string, unknown> = {};
  setValue(smtp, "host", text(b, "smtp_host") ?? "");
  setValue(smtp, "port", whole(b, "smtp_port") ?? 0);
  setValue(smtp, "tls", text(b, "smtp_tls"));
  setValue(smtp, "username", text(b, "smtp_username"));
  setValue(smtp, "passwordEnv", envRef(b, "smtp_password_env"));
  setValue(smtp, "passwordFile", text(b, "smtp_password_file"));
  setValue(smtp, "clientName", text(b, "smtp_client_name"));
  b.document.smtp = smtp;
  b.document.from = text(b, "from") ?? "";
  b.document.to = list(b, "to") ?? [];
  setValue(b.document, "subjectPrefix", text(b, "subject_prefix"));
  addMessage(b);
}

function addType(b: Builder, type: (typeof CHANNEL_TYPES)[number]): void {
  switch (type) {
    case "webhook":
      addUrlRefs(b);
      setValue(b.document, "secretEnv", envRef(b, "secret_env"));
      setValue(b.document, "secretFile", text(b, "secret_file"));
      return;
    case "slack":
    case "teams":
      addUrlRefs(b);
      addMessage(b);
      return;
    case "email":
      addEmail(b);
      return;
    default: {
      const never: never = type;
      throw new TypeError(`unknown channel type ${String(never)}`);
    }
  }
}

function typeOf(value: string | undefined): (typeof CHANNEL_TYPES)[number] | undefined {
  return CHANNEL_TYPES.find((t) => t === value);
}

export type ChannelParse =
  | { isOk: true; definition: NotifyChannelDefinition }
  | { isOk: false; errors: ChannelFormError[] };

/**
 * The definition of a posted channel form: only the fields of its type, checked by the contract
 * validator (with its 16 384-byte limit) before anything is sent.
 */
export function parseChannelForm(input: ChannelFormInput): ChannelParse {
  const type = typeOf(input.type);
  if (type === undefined)
    return { isOk: false, errors: [{ name: "type", text: TYPE_INVALID_TEXT }] };
  const b: Builder = { document: { id: input.id ?? "", type }, errors: [], input };
  addRouting(b);
  addType(b, type);
  if (b.errors.length > 0) return { isOk: false, errors: b.errors };
  const valid = validateNotifyChannelDefinition(b.document);
  if (!valid.ok) return { isOk: false, errors: [{ name: "id", text: valid.error }] };
  return { isOk: true, definition: valid.value };
}
