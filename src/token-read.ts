import {
  type FetchJsonOptions,
  type Location,
  type TokenMetadata,
  validateLocationsResponse,
  validateTokenMetadata,
  validateTokensResponse,
} from "@lorenzh/pulse-contract";
import type { ApiCall, ApiFailure } from "./api-failure.ts";
import { apiIdSegment } from "./api-path.ts";
import { type ApiReadDeps, isReadWireAbsent, readApi, readFailureOf } from "./api-read.ts";

/** One read of the Tokens and Probes pages. Each read fails on its own. */
export type TokenRead<T> =
  | { kind: "ok"; value: T }
  | { kind: "no-token" }
  | { kind: "token-rejected" }
  | { kind: "failed"; failure: ApiFailure };

/** The read of one token by id: an unknown or unaddressable id is `not-found`. */
export type OneTokenRead = TokenRead<TokenMetadata> | { kind: "not-found" };

/** The reads of one Tokens or Probes page, made at the same time. */
export type TokenPageReads = {
  tokens: TokenRead<TokenMetadata[]>;
  self: TokenRead<TokenMetadata>;
  /** Only read for the Probes page. */
  locations?: TokenRead<Location[]> | undefined;
};

async function read<T>(
  call: ApiCall,
  url: string,
  validate: FetchJsonOptions<T>["validate"],
  deps: ApiReadDeps,
  authorization: string | undefined,
): Promise<TokenRead<T>> {
  const outcome = await readApi(url, validate, deps, authorization);
  const failure = readFailureOf(call, outcome, new URL(url).origin, deps);
  if (failure?.kind === "http" && failure.status === 401 && authorization !== undefined) {
    return { kind: "token-rejected" };
  }
  if (failure !== undefined) return { kind: "failed", failure };
  if (isReadWireAbsent(call, outcome, deps)) {
    return { kind: "failed", failure: { kind: "missing-header" } };
  }
  return outcome.result.ok
    ? { kind: "ok", value: outcome.result.value }
    : { kind: "failed", failure: { kind: "invalid" } };
}

/** `GET /admin/tokens` with the console token. */
export function readTokenList(
  apiUrl: string,
  deps: ApiReadDeps,
): Promise<TokenRead<TokenMetadata[]>> {
  if (deps.token === undefined) return Promise.resolve({ kind: "no-token" });
  return read(
    "tokens",
    `${apiUrl}/admin/tokens`,
    (raw) => {
      const checked = validateTokensResponse(raw);
      return checked.ok ? { ok: true, value: checked.value.tokens } : checked;
    },
    deps,
    `Bearer ${deps.token}`,
  );
}

/** `GET /admin/tokens/self`, read fresh on every call: there is no cache. */
export function readSelf(apiUrl: string, deps: ApiReadDeps): Promise<TokenRead<TokenMetadata>> {
  if (deps.token === undefined) return Promise.resolve({ kind: "no-token" });
  return read(
    "self",
    `${apiUrl}/admin/tokens/self`,
    (raw) => validateTokenMetadata(raw),
    deps,
    `Bearer ${deps.token}`,
  );
}

/** `GET /admin/tokens/<id>`, the id as one encoded segment; `404` is `not-found`. */
export async function readToken(
  apiUrl: string,
  id: string,
  deps: ApiReadDeps,
): Promise<OneTokenRead> {
  if (deps.token === undefined) return { kind: "no-token" };
  const segment = apiIdSegment(id);
  if (segment === undefined || id === "self") return { kind: "not-found" };
  const result = await read(
    "token",
    `${apiUrl}/admin/tokens/${segment}`,
    (raw) => validateTokenMetadata(raw),
    deps,
    `Bearer ${deps.token}`,
  );
  return result.kind === "failed" && result.failure.kind === "http" && result.failure.status === 404
    ? { kind: "not-found" }
    : result;
}

/** `GET /locations`, a public route: it never carries the console token. */
export function readLocations(apiUrl: string, deps: ApiReadDeps): Promise<TokenRead<Location[]>> {
  return read(
    "locations",
    `${apiUrl}/locations`,
    (raw) => validateLocationsResponse(raw),
    deps,
    undefined,
  );
}

/** The reads of a Tokens page, or of a Probes page with `withLocations`, at the same time. */
export async function readTokenPage(
  apiUrl: string,
  deps: ApiReadDeps,
  withLocations: boolean,
): Promise<TokenPageReads> {
  const [tokens, self, locations] = await Promise.all([
    readTokenList(apiUrl, deps),
    readSelf(apiUrl, deps),
    withLocations ? readLocations(apiUrl, deps) : Promise.resolve(undefined),
  ]);
  return { tokens, self, locations };
}
