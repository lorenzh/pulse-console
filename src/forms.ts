import { readUrl } from "@lorenzh/pulse-kit";
import { type PasswordProblem, passwordProblem } from "./passwords.ts";

export const MAX_FORM_BYTES = 8192;
/** Decision 9: the form limit of `POST /checks/new` and `POST /checks/edit` only. */
export const MAX_CHECK_FORM_BYTES = 524288;
/** The form limit of the incident composer, update and resolve forms. */
export const MAX_INCIDENT_FORM_BYTES = 32768;
/** The form limit of the maintenance create and edit forms. */
export const MAX_MAINTENANCE_FORM_BYTES = 131072;
const MAX_API_URL_LENGTH = 2048;
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}]/u;
const CONTROL = /\p{Cc}/u;

/** True for `application/x-www-form-urlencoded`, with or without parameters. */
export function isFormContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const type = header.split(";")[0]?.trim().toLowerCase();
  return type === "application/x-www-form-urlencoded";
}

export type FormFields<K extends string> = Partial<Record<K, string>>;

/** List fields of a form: the values of each named field in body order. */
export type FormLists = Readonly<Partial<Record<string, readonly string[]>>>;

export type ParsedForm<K extends string> =
  | { isOk: true; fields: FormFields<K>; lists: FormLists }
  | { isOk: false; repeated: string };

/** Field name to the most values that the field may carry. */
export type ListLimits = Readonly<Record<string, number>>;

/** The values of one list field, or undefined when over its limit or a value repeats. */
function listOf(params: URLSearchParams, name: string, limit: number): string[] | undefined {
  const values = params.getAll(name);
  if (values.length > limit || new Set(values).size !== values.length) return undefined;
  return values;
}

/**
 * Reads the known fields and the list fields of a form body. A repeated known field fails; a
 * list field fails over its limit or with one value twice; unknown fields are ignored. A known
 * name is never a list, so `csrf` and `form_token` stay single fields.
 */
export function parseForm<K extends string>(
  body: string,
  known: readonly K[],
  listLimits: ListLimits = {},
): ParsedForm<K> {
  const params = new URLSearchParams(body);
  const fields: FormFields<K> = {};
  for (const name of known) {
    const values = params.getAll(name);
    if (values.length > 1) return { isOk: false, repeated: name };
    if (values.length === 1) fields[name] = values[0];
  }
  const knownNames: ReadonlySet<string> = new Set(known);
  const lists: Partial<Record<string, readonly string[]>> = {};
  for (const [name, limit] of Object.entries(listLimits)) {
    if (knownNames.has(name)) continue;
    const values = listOf(params, name, limit);
    if (values === undefined) return { isOk: false, repeated: name };
    lists[name] = values;
  }
  return { isOk: true, fields, lists };
}

export type ApiUrlCheck = { isOk: true; url: string } | { isOk: false; text: string };

/** The PULSE_API_URL rules plus a length cap. One trailing `/` is dropped; a path prefix stays. */
export function checkApiUrl(input: string | undefined): ApiUrlCheck {
  // Surrounding whitespace is trimmed first, as the PULSE_API_URL rules do.
  const raw = input?.trim();
  const fail: ApiUrlCheck = {
    isOk: false,
    text: "Enter an http(s) URL without credentials, query or fragment.",
  };
  if (raw === undefined || raw === "") return { isOk: false, text: "Enter the pulse-api URL." };
  if (raw.length > MAX_API_URL_LENGTH) {
    return { isOk: false, text: "The URL must have at most 2048 characters." };
  }
  // The URL parser drops tabs and newlines, so they are refused before it runs.
  if (WHITESPACE_OR_CONTROL.test(raw) || raw.includes("?") || raw.includes("#")) return fail;
  try {
    const url = readUrl({ url: raw }, "url");
    return url === undefined ? fail : { isOk: true, url };
  } catch {
    // kit's error text names the setting; the field gets its own text.
    return fail;
  }
}

export type EmailCheck = { isOk: true; email: string } | { isOk: false; text: string };

/** Trimmed and lowercased; 3 to 254 characters, no whitespace or control, exactly one `@`. */
export function checkEmail(raw: string | undefined): EmailCheck {
  const email = (raw ?? "").trim().toLowerCase();
  const parts = email.split("@");
  const isValid =
    email.length >= 3 &&
    email.length <= 254 &&
    !WHITESPACE_OR_CONTROL.test(email) &&
    parts.length === 2 &&
    parts[0] !== "" &&
    parts[1] !== "";
  return isValid ? { isOk: true, email } : { isOk: false, text: "Enter a valid email address." };
}

export type NameCheck = { isOk: true; name: string } | { isOk: false; text: string };

/** Trimmed, 1 to 100 characters, no control character. */
export function checkName(raw: string | undefined): NameCheck {
  const name = (raw ?? "").trim();
  const length = [...name].length;
  if (length < 1 || length > 100 || CONTROL.test(name)) {
    return { isOk: false, text: "Enter a name of 1 to 100 characters." };
  }
  return { isOk: true, name };
}

/** The page text of a password problem, or undefined when the password is acceptable. */
export function passwordText(password: string, confirmation: string): string | undefined {
  const problem: PasswordProblem | undefined = passwordProblem(password, confirmation);
  switch (problem) {
    case undefined:
      return undefined;
    case "too-short":
      return "The password must have at least 12 characters.";
    case "too-long":
      return "The password must have at most 128 characters.";
    case "mismatch":
      return "The passwords do not match.";
    default: {
      const never: never = problem;
      return never;
    }
  }
}
