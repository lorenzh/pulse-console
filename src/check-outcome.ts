import { isAdminRevision, type RequestJsonResult } from "@lorenzh/pulse-contract";

/**
 * The class of one check write (Decision 10), decided only by the response metadata, never by
 * the body. `unreadable` names the error kind of a saved answer whose body could not be used.
 */
export type CheckOutcome =
  | { class: "saved"; revision: string | null; unreadable?: string | undefined }
  | { class: "refused"; status: number; message?: string | undefined }
  | { class: "unknown"; status: number | null; isRedirect: boolean };

const SAVED_STATUSES: ReadonlySet<number> = new Set([200, 201, 204]);

/** The unquoted revision of a strong `ETag` that passes `isAdminRevision`, else `null`. */
export function revisionOfEtag(etag: string | null): string | null {
  if (etag === null || etag.length < 2 || !etag.startsWith('"') || !etag.endsWith('"')) {
    return null;
  }
  const value = etag.slice(1, -1);
  return isAdminRevision(value) ? value : null;
}

/** The R8 rows, top to bottom; the first match wins. */
export function checkOutcome(result: RequestJsonResult<unknown>): CheckOutcome {
  if (result.ok) {
    return result.wire === "ok" && SAVED_STATUSES.has(result.status)
      ? { class: "saved", revision: revisionOfEtag(result.etag) }
      : { class: "unknown", status: result.status, isRedirect: false };
  }
  const { response, error } = result;
  if (response === null) return { class: "unknown", status: null, isRedirect: false };
  const { status } = response;
  const isWireOk = response.wire.status === "ok";
  if (isWireOk && SAVED_STATUSES.has(status)) {
    return { class: "saved", revision: revisionOfEtag(response.etag), unreadable: error.kind };
  }
  if (isWireOk && status >= 400 && status <= 599) {
    const message = error.kind === "http" ? error.message : undefined;
    return message === undefined
      ? { class: "refused", status }
      : { class: "refused", status, message };
  }
  return { class: "unknown", status, isRedirect: status >= 300 && status <= 399 };
}
