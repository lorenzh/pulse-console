import {
  type AdminCheckView,
  type AdminConfigExport,
  type AdminExportRedaction,
  validateAdminConfigExport,
} from "@lorenzh/pulse-contract";

/** The file name and the text above the download link (R7). */
export const EXPORT_NOTE =
  'The export leaves out header values, bodies and heartbeat secrets and lists them in "redacted". Fill them in and remove "redacted" before you use the file as checks.json.';

/** The answer bytes in the api's own format: two spaces and a final newline. */
export function exportBody(document: AdminConfigExport): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * The export of one effective check, cut from the whole export document: its entry, no
 * components, and its maintenance and redacted entries. `undefined` for an unknown id.
 */
export function singleCheckExport(
  document: AdminConfigExport,
  id: string,
): AdminConfigExport | undefined {
  const check = document.checks.find((entry) => entry.id === id);
  if (check === undefined) return undefined;
  const redacted = (document.redacted ?? []).filter((entry) => entry.checkId === id);
  return {
    checks: [check],
    components: [],
    maintenance: document.maintenance.filter((entry) => entry.checkId === id),
    ...(redacted.length > 0 ? { redacted } : {}),
  };
}

/** Keys of a stored view that a checks file never holds. */
const VIEW_ONLY_KEYS: ReadonlySet<string> = new Set(["source", "hasSecret", "headers", "body"]);

/**
 * A stored view as a checks file entry with the api's export rules: `source` and `hasSecret`
 * dropped, keep markers left out and listed in `redacted`, env names kept in header order.
 */
function exportedView(view: AdminCheckView, redacted: AdminExportRedaction[]): unknown {
  const checkId = view.id;
  const entries = Object.entries(view).filter(([key]) => !VIEW_ONLY_KEYS.has(key));
  if (view.type === "heartbeat") {
    redacted.push({ checkId, field: "secret" });
  } else if (view.type === undefined || view.type === "http") {
    const envEntries: [string, { env: string }][] = [];
    for (const [name, value] of Object.entries(view.headers ?? {})) {
      if ("env" in value) envEntries.push([name, { env: value.env }]);
      else redacted.push({ checkId, field: `headers.${name}` });
    }
    if (view.body !== undefined) redacted.push({ checkId, field: "body" });
    // fromEntries defines own keys; plain assignment would run the `__proto__` setter.
    if (envEntries.length > 0) entries.push(["headers", Object.fromEntries(envEntries)]);
  }
  return Object.fromEntries(entries);
}

export type ShadowedExport =
  | { kind: "ok"; document: AdminConfigExport }
  | { kind: "invalid"; error: string };

/**
 * The export of a shadowed database definition. Its maintenance windows belong to the
 * effective check, so the document holds none. Validated before it is returned.
 */
export function shadowedCheckExport(view: AdminCheckView): ShadowedExport {
  const redacted: AdminExportRedaction[] = [];
  const check = exportedView(view, redacted);
  const result = validateAdminConfigExport({
    checks: [check],
    components: [],
    maintenance: [],
    ...(redacted.length > 0 ? { redacted } : {}),
  });
  return result.ok
    ? { kind: "ok", document: result.value }
    : { kind: "invalid", error: result.error };
}
