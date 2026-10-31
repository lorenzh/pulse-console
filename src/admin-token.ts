import { type Env, readString, StartupError } from "@lorenzh/pulse-kit";

const TOKEN_VAR = "PULSE_CONSOLE_ADMIN_TOKEN";
const FILE_VAR = "PULSE_CONSOLE_ADMIN_TOKEN_FILE";
const MIN_TOKEN_LENGTH = 16;
const PLACEHOLDER_PREFIX = "replace-with-";
// Copied from pulse-api src/tokens.ts:11-14 (EXAMPLE_TOKENS); the console cannot import the api.
const EXAMPLE_TOKENS: readonly string[] = [
  "example-token-change-me-0000",
  "example-token-0123456789abcdef",
];
const FS_CODE = /^E[A-Z0-9]+$/;
// A header value must be ASCII; space is already refused by the whitespace rule.
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/** The first broken rule as message text, or undefined. The text never holds the token. */
function tokenProblem(token: string): string | undefined {
  if (token.length < MIN_TOKEN_LENGTH) return `must hold at least ${MIN_TOKEN_LENGTH} characters`;
  if (/\s/.test(token)) return "must not contain whitespace";
  if (!PRINTABLE_ASCII.test(token)) return "must hold printable ASCII";
  if (token.startsWith(PLACEHOLDER_PREFIX)) return "still has the example placeholder";
  if (EXAMPLE_TOKENS.includes(token)) return "is a public example token: generate your own";
  return undefined;
}

function fsCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !Object.hasOwn(err, "code")) return undefined;
  const code: unknown = Object.getOwnPropertyDescriptor(err, "code")?.value;
  return typeof code === "string" && FS_CODE.test(code) ? code : undefined;
}

function readTokenFile(path: string, readFile: (path: string) => string): string {
  const fail = (rule: string, cause?: unknown): StartupError =>
    new StartupError(`${FILE_VAR}=${path}: ${rule}`, { setting: FILE_VAR, cause });
  let content: string;
  try {
    content = readFile(path);
  } catch (err) {
    // Only the code: the raw fs message may carry more than the path.
    const code = fsCode(err);
    throw fail(code === undefined ? "cannot read" : `cannot read (${code})`, err);
  }
  const token = content.trim();
  if (token === "") throw fail("file is empty");
  if (token.length < MIN_TOKEN_LENGTH)
    throw fail(`must hold at least ${MIN_TOKEN_LENGTH} characters`);
  if (/[\r\n]/.test(token)) throw fail("must hold one line");
  const problem = tokenProblem(token);
  if (problem !== undefined) throw fail(problem);
  return token;
}

/**
 * Reads the optional admin token from PULSE_CONSOLE_ADMIN_TOKEN or the file named by
 * PULSE_CONSOLE_ADMIN_TOKEN_FILE. At most one may be set; blank counts as unset. The rules
 * match the api's admin token rules, so an accepted value can be an api admin token.
 * Messages never hold the token or the file content.
 */
export function readAdminToken(env: Env, readFile: (path: string) => string): string | undefined {
  const token = readString(env, TOKEN_VAR);
  const path = readString(env, FILE_VAR);
  if (token !== undefined && path !== undefined) {
    throw new StartupError(`set only one of ${TOKEN_VAR} and ${FILE_VAR}`);
  }
  if (path !== undefined) return readTokenFile(path, readFile);
  if (token === undefined) return undefined;
  const problem = tokenProblem(token);
  if (problem !== undefined)
    throw new StartupError(`${TOKEN_VAR} ${problem}`, { setting: TOKEN_VAR });
  return token;
}
