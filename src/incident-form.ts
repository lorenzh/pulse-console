import {
  MANUAL_INCIDENT_IMPACTS,
  type ManualIncidentInput,
  type ManualIncidentUpdateInput,
  validateManualIncidentInput,
  validateManualIncidentUpdateInput,
} from "@lorenzh/pulse-contract";

type Impact = (typeof MANUAL_INCIDENT_IMPACTS)[number];
export type OpenStatus = "investigating" | "identified" | "monitoring";
const OPEN_STATUSES: readonly string[] = ["investigating", "identified", "monitoring"];

export const UNTITLED_ERROR =
  "The title needs at least one letter, digit, punctuation mark or symbol.";
export const FORGED_RESOLVE_ERROR = "Use Resolve to resolve an incident.";

/** True when the title has no letter, number, punctuation or symbol. */
export function isUntitledIncident(title: string): boolean {
  return !/[\p{L}\p{N}\p{P}\p{S}]/u.test(title);
}

/** The heading and link text of a manual incident. */
export function incidentTitleText(id: number, title: string): string {
  return isUntitledIncident(title) ? `Untitled incident #${id}` : title;
}

/** The name a person types to delete an incident. */
export function incidentConfirmName(id: number, title: string): string {
  return isUntitledIncident(title) ? `Incident ${id}` : title;
}

/** Turns CRLF and lone CR into LF; nothing else changes. */
export function normalizeMessage(message: string): string {
  return message.replace(/\r\n?/g, "\n");
}

/** Field errors by field name. */
export type FieldErrors = Partial<
  Record<"title" | "impact" | "status" | "component" | "message", string>
>;

/** The posted composer input, kept as typed. */
export type ComposerInput = {
  title: string;
  impact: string;
  status: string;
  components: readonly string[];
  message: string;
};

export type FormResult<T> = { ok: true; body: T } | { ok: false; errors: FieldErrors };

function contractErrors(error: string): FieldErrors {
  const colon = error.indexOf(": ");
  const path = colon < 0 ? "" : error.slice(0, colon);
  const text = colon < 0 ? error : error.slice(colon + 2);
  const field = path.split(".")[1] ?? "";
  if (field === "title" || field === "impact" || field === "status" || field === "message") {
    return { [field]: text };
  }
  if (field === "componentIds") return { component: text };
  return { message: error };
}

function unknownComponent(
  components: readonly string[],
  known: ReadonlySet<string>,
): FieldErrors | undefined {
  const missing = components.find((c) => !known.has(c));
  return missing === undefined
    ? undefined
    : { component: `Component ${missing} is not configured any more.` };
}

/** Builds and validates the body of `POST /manual-incidents`. */
export function composerBody(
  input: ComposerInput,
  known: ReadonlySet<string>,
): FormResult<ManualIncidentInput> {
  if (isUntitledIncident(input.title)) return { ok: false, errors: { title: UNTITLED_ERROR } };
  const missing = unknownComponent(input.components, known);
  if (missing !== undefined) return { ok: false, errors: missing };
  const status = OPEN_STATUSES.includes(input.status) ? input.status : undefined;
  if (status === undefined) return { ok: false, errors: { status: "Choose a status." } };
  const impacts: readonly string[] = MANUAL_INCIDENT_IMPACTS;
  if (!impacts.includes(input.impact))
    return { ok: false, errors: { impact: "Choose an impact." } };
  const body = {
    title: input.title,
    impact: input.impact as Impact,
    componentIds: [...input.components],
    status: status as OpenStatus,
    message: normalizeMessage(input.message),
  };
  const checked = validateManualIncidentInput(body);
  return checked.ok
    ? { ok: true, body: checked.value }
    : { ok: false, errors: contractErrors(checked.error) };
}

/** Builds and validates the body of `POST /manual-incidents/<id>/updates`. */
export function updateBody(status: string, message: string): FormResult<ManualIncidentUpdateInput> {
  if (status === "resolved") return { ok: false, errors: { status: FORGED_RESOLVE_ERROR } };
  if (!OPEN_STATUSES.includes(status)) return { ok: false, errors: { status: "Choose a status." } };
  const checked = validateManualIncidentUpdateInput({
    status: status as OpenStatus,
    message: normalizeMessage(message),
  });
  return checked.ok
    ? { ok: true, body: checked.value }
    : { ok: false, errors: contractErrors(checked.error) };
}

/** Builds and validates the body of `POST /manual-incidents/<id>/resolve`. */
export function resolveBody(message: string): FormResult<{ message: string }> {
  const normalized = normalizeMessage(message);
  const checked = validateManualIncidentUpdateInput({ status: "resolved", message: normalized });
  return checked.ok
    ? { ok: true, body: { message: normalized } }
    : { ok: false, errors: contractErrors(checked.error) };
}
