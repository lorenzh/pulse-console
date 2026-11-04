import { readUrl } from "@lorenzh/pulse-kit";
import { type PasswordProblem, passwordProblem } from "./passwords.ts";

export const MAX_FORM_BYTES = 8192;
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

export type ParsedForm<K extends string> =
  | { isOk: true; fields: FormFields<K> }
  | { isOk: false; repeated: K };

/** Reads the known fields of a form body. A repeated known field fails; unknown ones are ignored. */
export function parseForm<K extends string>(body: string, known: readonly K[]): ParsedForm<K> {
  const params = new URLSearchParams(body);
  const fields: FormFields<K> = {};
  for (const name of known) {
    const values = params.getAll(name);
    if (values.length > 1) return { isOk: false, repeated: name };
    if (values.length === 1) fields[name] = values[0];
  }
  return { isOk: true, fields };
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
