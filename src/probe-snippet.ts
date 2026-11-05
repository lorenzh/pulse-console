/**
 * The probe location field rules and the snippets that start a probe. Pure: no I/O. Every shell
 * word that holds data goes through `shellQuote`; YAML scalars are JSON strings with `$` doubled
 * for Compose interpolation. HTML escaping happens only at render.
 */
import { shellQuote } from "./shell-line.ts";

/** The checked value of one field, or the rule it breaks. */
export type FieldCheck = { isValid: true; value: string } | { isValid: false; rule: string };

// \p{Cc} covers \x00-\x1f, \x7f and the C1 controls \x80-\x9f.
const CONTROL = /\p{Cc}/u;
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}]/u;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export const LOCATION_RULE = "must hold 1 to 64 characters, no control character, not heartbeat";
export const NAME_RULE = "must hold 1 to 100 characters and no control character";
export const API_URL_RULE =
  "must be an http(s) URL of at most 2048 characters without whitespace, credentials, query or fragment";
export const IMAGE_RULE =
  "must hold 1 to 255 characters of A-Z a-z 0-9 . _ / : @ - and start with a letter or digit";
export const NETWORK_RULE =
  "must start with a letter or digit and hold at most 128 characters of A-Z a-z 0-9 _ . -";

function valid(value: string): FieldCheck {
  return { isValid: true, value };
}

function broken(rule: string): FieldCheck {
  return { isValid: false, rule };
}

/** The location: trimmed, 1 to 64 characters, no control character, not `heartbeat`. */
export function checkLocation(raw: string): FieldCheck {
  const value = raw.trim();
  const isValid =
    value.length >= 1 && value.length <= 64 && !CONTROL.test(value) && value !== "heartbeat";
  return isValid ? valid(value) : broken(LOCATION_RULE);
}

/** The credential name: trimmed 1 to 100 without controls; empty means `probe <location>`. */
export function checkProbeName(raw: string, location: string): FieldCheck {
  const value = raw.trim();
  if (value === "") return valid(`probe ${location}`);
  return value.length <= 100 && !CONTROL.test(value) ? valid(value) : broken(NAME_RULE);
}

/** The URL the probe reaches pulse-api at, with one trailing `/` dropped. */
export function checkProbeApiUrl(raw: string): FieldCheck {
  const value = raw.trim();
  if (value === "" || value.length > 2048 || WHITESPACE_OR_CONTROL.test(value)) {
    return broken(API_URL_RULE);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // An unparsable value is an expected field error, not a fault.
    return broken(API_URL_RULE);
  }
  const isValid =
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname !== "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    !value.includes("?") &&
    !value.includes("#");
  return isValid ? valid(url.href.replace(/\/$/, "")) : broken(API_URL_RULE);
}

/** The probe image reference. */
export function checkProbeImage(raw: string): FieldCheck {
  const value = raw.trim();
  return IMAGE.test(value) ? valid(value) : broken(IMAGE_RULE);
}

/** The Docker network; empty means none (a remote probe). */
export function checkProbeNetwork(raw: string): FieldCheck {
  const value = raw.trim();
  if (value === "") return valid("");
  return NETWORK.test(value) ? valid(value) : broken(NETWORK_RULE);
}

/** The checked fields and the created credential that the snippets are built from. */
export type ProbeSnippetInput = {
  location: string;
  apiUrl: string;
  image: string;
  /** Empty for no network. */
  network: string;
  tokenId: string;
};

/** The location lowercased, runs outside `[a-z0-9]` as `-`, at most 32 characters. */
export function locationSlug(location: string): string {
  const words = location
    .toLowerCase()
    .split(/[^a-z0-9]/)
    .filter((word) => word !== "");
  const slug = trimDashes(words.join("-").slice(0, 32));
  return slug === "" ? "location" : slug;
}

function trimDashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "-") end -= 1;
  return value.slice(0, end);
}

function envFileOf(base: string): string {
  return shellQuote(base + ".env");
}

function quotedSetting(name: string, value: string): string {
  return shellQuote(name + "=" + value);
}

/** `pulse-probe-<slug>-<last 6 of the token id>`: file, container and project name. */
export function probeBase(location: string, tokenId: string): string {
  return `pulse-probe-${locationSlug(location)}-${tokenId.slice(-6)}`;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value).replaceAll("$", "$$$$");
}

/** The one line that saves the secret to `<base>.env` with mode 600. Holds the secret. */
export function envCommand(base: string, secret: string): string {
  const line = quotedSetting("PULSE_PROBE_TOKEN", secret);
  return `(umask 077 && printf '%s\\n' ${line} > ${envFileOf(base)})`;
}

/** The `docker run` command; the secret comes only from the env file. */
export function dockerRunCommand(input: ProbeSnippetInput): string {
  const base = probeBase(input.location, input.tokenId);
  const lines = [
    `docker run -d --name ${shellQuote(base)} --restart unless-stopped \\`,
    "  --security-opt no-new-privileges:true --cap-drop ALL \\",
    ...(input.network === "" ? [] : [`  --network ${shellQuote(input.network)} \\`]),
    `  --env-file ${envFileOf(base)} \\`,
    `  -e ${quotedSetting("PULSE_API_URL", input.apiUrl)} \\`,
    `  -e ${quotedSetting("PULSE_LOCATION", input.location)} \\`,
    "  -e 'PULSE_PROBE_BLOCK_PRIVATE_RANGES=false' \\",
    `  ${shellQuote(input.image)}`,
  ];
  return lines.join("\n");
}

/** The Compose file `<base>.compose.yaml`. */
export function composeFile(input: ProbeSnippetInput): string {
  const base = probeBase(input.location, input.tokenId);
  const hasNetwork = input.network !== "";
  const lines = [
    `name: ${yamlScalar(base)}`,
    "services:",
    "  probe:",
    `    image: ${yamlScalar(input.image)}`,
    "    restart: unless-stopped",
    '    security_opt: ["no-new-privileges:true"]',
    "    cap_drop: [ALL]",
    `    env_file: [${yamlScalar(base + ".env")}]`,
    "    environment:",
    `      PULSE_API_URL: ${yamlScalar(input.apiUrl)}`,
    `      PULSE_LOCATION: ${yamlScalar(input.location)}`,
    '      PULSE_PROBE_BLOCK_PRIVATE_RANGES: "false"',
    ...(hasNetwork
      ? [
          "    networks: [pulse]",
          "networks:",
          "  pulse:",
          "    external: true",
          `    name: ${yamlScalar(input.network)}`,
        ]
      : []),
  ];
  return `${lines.join("\n")}\n`;
}

function composePrefix(base: string): string {
  const file = shellQuote(base + ".compose.yaml");
  return `docker compose -p ${shellQuote(base)} -f ${file}`;
}

/** Starts the Compose project. `-p` and `-f` beat an inherited COMPOSE_PROJECT_NAME/COMPOSE_FILE. */
export function composeUpCommand(base: string): string {
  return `${composePrefix(base)} up -d`;
}

/** Recreates the container after a rotation, so it reads the new env file. */
export function composeRestartCommand(base: string): string {
  return `${composePrefix(base)} up -d --force-recreate`;
}

/** Stops and removes the Compose project. */
export function composeStopCommand(base: string): string {
  return `${composePrefix(base)} down`;
}

/** Removes the `docker run` container before it is run again after a rotation. */
export function dockerRemoveCommand(base: string): string {
  return `docker rm -f ${shellQuote(base)}`;
}
