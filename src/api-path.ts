/**
 * The one way a check id enters a pulse-api path: one encoded segment. The ids `.` and `..`
 * cannot be addressed, because every URL parser turns them into a dot segment, so this returns
 * `undefined` for exactly those two and the caller must not call pulse-api.
 */
export function apiIdSegment(id: string): string | undefined {
  if (id === "." || id === "..") return undefined;
  return encodeURIComponent(id);
}
