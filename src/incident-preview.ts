import type { ManualIncident } from "@lorenzh/pulse-contract";
import { escapeHtml } from "@lorenzh/pulse-kit";
import { utcTime } from "./check-format.ts";

/** One configured component as the preview names it. */
export type PreviewComponent = { id: string; name: string };

/** One shown update: `time` is `when published` for the new one. */
type PreviewUpdate = { status: string; time: string; message: string };

/** The parts of the status-page card, as status `src/render.ts` shows a manual incident. */
export type PreviewParts = {
  state: "open" | "resolved";
  impact: string;
  status: string;
  title: string;
  /** Names, or the id when the component is not configured. */
  affects: readonly string[];
  updates: readonly PreviewUpdate[];
};

const NEW_UPDATE_TIME = "when published";

function namesOf(ids: readonly string[], components: readonly PreviewComponent[]): string[] {
  return ids.map((id) => components.find((c) => c.id === id)?.name ?? id);
}

/** The open card: the new status and only the new update, as the status page's open list. */
export function openPreview(
  input: {
    title: string;
    impact: string;
    status: string;
    components: readonly string[];
    message: string;
  },
  components: readonly PreviewComponent[],
): PreviewParts {
  return {
    state: "open",
    impact: input.impact,
    status: input.status,
    title: input.title,
    affects: namesOf(input.components, components),
    updates: [{ status: input.status, time: NEW_UPDATE_TIME, message: input.message }],
  };
}

/** The resolved card: every stored update oldest first, then the new `resolved` one. */
export function resolvedPreview(
  incident: ManualIncident,
  message: string,
  components: readonly PreviewComponent[],
): PreviewParts {
  return {
    state: "resolved",
    impact: incident.impact,
    status: "resolved",
    title: incident.title,
    affects: namesOf(incident.componentIds, components),
    updates: [
      ...incident.updates.map((u) => ({
        status: u.status,
        time: utcTime(u.at),
        message: u.message,
      })),
      { status: "resolved", time: NEW_UPDATE_TIME, message },
    ],
  };
}

function updateHtml(update: PreviewUpdate): string {
  return `<div data-part="update"><span data-part="update-status">${escapeHtml(update.status)}</span> <span data-part="time">${escapeHtml(update.time)}</span><p class="preview-message" data-part="message">${escapeHtml(update.message)}</p></div>`;
}

/** The preview section; every value is escaped text. Not a live region. */
export function previewSection(parts: PreviewParts): string {
  const affects = `Affects: ${parts.affects.join(", ")}`;
  const hidden = parts.affects.length === 0 ? " hidden" : "";
  return `<section aria-labelledby="preview-heading">
<h2 id="preview-heading">Status page preview</h2>
<div class="incident-preview" data-preview="${parts.state}">
<p><span data-part="impact">Impact: ${escapeHtml(parts.impact)}</span> <span data-part="status">Status: ${escapeHtml(parts.status)}</span></p>
<h3 data-part="title">${escapeHtml(parts.title)}</h3>
<p data-part="affects"${hidden}>${escapeHtml(affects)}</p>
<div class="preview-updates">${parts.updates.map(updateHtml).join("")}</div>
</div>
</section>`;
}
