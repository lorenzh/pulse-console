import {
  type ManualIncidentInput,
  type ManualIncidentUpdateInput,
  validateManualIncident,
} from "@lorenzh/pulse-contract";
import type { User } from "./account-store.ts";
import {
  type CheckWriteDeps,
  sendApiWrite,
  type WriteAnswer,
  type WriteTexts,
} from "./check-write.ts";

export const INCIDENT_SCOPE_TEXT =
  "The console token lacks the admin or incidents scope. Incident changes need both.";
export const INCIDENT_GONE_TEXT = "This incident does not exist or is not public.";
export const INCIDENT_UNKNOWN_TEXT =
  "The result is unknown. Open the incident list to see whether the change was published before you send it again.";
export const PUBLISHED_UNREADABLE_TEXT = "Incident published. Open the list to find it.";

const INCIDENT_TEXTS: WriteTexts = {
  scope: INCIDENT_SCOPE_TEXT,
  gone: INCIDENT_GONE_TEXT,
  unknown: INCIDENT_UNKNOWN_TEXT,
  unknownHint: "open the incident list to see whether the change was published.",
  unknownAnswered: INCIDENT_UNKNOWN_TEXT,
  isBadRequestForm: true,
};

/** One outbound incident write. */
export type IncidentWrite =
  | { action: "manual-incident.create"; body: ManualIncidentInput }
  | { action: "manual-incident.update"; id: number; body: ManualIncidentUpdateInput }
  | { action: "manual-incident.resolve"; id: number; message: string }
  | { action: "manual-incident.delete"; id: number };

/**
 * What the route shows. `redirect` is the `303` of a saved write; `logged-failed` is the `200`
 * page of a saved write whose People row failed, linking `href`. `form` re-renders the form,
 * `text` shows the message with the input as text.
 */
export type IncidentWriteAnswer =
  | { kind: "redirect"; location: string }
  | { kind: "not-logged"; href: string }
  | { kind: "form"; status: number; message: string }
  | {
      kind: "text";
      status: number;
      message: string;
      reason: "token-rejected" | "stale" | "gone" | "other";
    };

type Request = { method: "POST" | "DELETE"; path: string; body?: string };

function requestOf(write: IncidentWrite): Request {
  switch (write.action) {
    case "manual-incident.create":
      return { method: "POST", path: "/manual-incidents", body: JSON.stringify(write.body) };
    case "manual-incident.update":
      return {
        method: "POST",
        path: `/manual-incidents/${write.id}/updates`,
        body: JSON.stringify(write.body),
      };
    case "manual-incident.resolve":
      return {
        method: "POST",
        path: `/manual-incidents/${write.id}/resolve`,
        body: JSON.stringify({ message: write.message }),
      };
    case "manual-incident.delete":
      return { method: "DELETE", path: `/manual-incidents/${write.id}` };
    default: {
      const never: never = write;
      return never;
    }
  }
}

function createdId(answer: unknown): number | undefined {
  const checked = validateManualIncident(answer);
  return checked.ok ? checked.value.id : undefined;
}

function idOf(write: IncidentWrite, answer: unknown): number | undefined {
  return write.action === "manual-incident.create" ? createdId(answer) : write.id;
}

function savedLocation(write: IncidentWrite, id: number | undefined): string {
  const detail = (flag: string): string => `/incidents/manual?id=${id}&${flag}=1`;
  switch (write.action) {
    case "manual-incident.create":
      return id === undefined ? "/incidents?published=1" : detail("published");
    case "manual-incident.update":
      return detail("posted");
    case "manual-incident.resolve":
      return detail("resolved");
    case "manual-incident.delete":
      return "/incidents?deleted=1";
    default: {
      const never: never = write;
      return never;
    }
  }
}

function mapped(answer: WriteAnswer, write: IncidentWrite): IncidentWriteAnswer {
  switch (answer.kind) {
    case "saved": {
      const id = idOf(write, answer.answer);
      if (answer.isLogged) return { kind: "redirect", location: savedLocation(write, id) };
      const isListed = id === undefined || write.action === "manual-incident.delete";
      return { kind: "not-logged", href: isListed ? "/incidents" : `/incidents/manual?id=${id}` };
    }
    case "form":
    case "text":
      return answer;
    default: {
      const never: never = answer;
      return never;
    }
  }
}

/** Sends one incident write (no `If-Match`, never retried) and maps its outcome (section 10). */
export async function sendIncidentWrite(
  deps: CheckWriteDeps,
  apiUrl: string,
  write: IncidentWrite,
  user: User,
): Promise<IncidentWriteAnswer> {
  const request = requestOf(write);
  const answer = await sendApiWrite(
    deps,
    {
      action: write.action,
      targetOf: (body) => ({ kind: "incident", id: idOf(write, body) }),
      logMessage: "incident change",
      logIds: write.action === "manual-incident.create" ? {} : { incidentId: write.id },
      method: request.method,
      url: `${apiUrl}${request.path}`,
      body: request.body,
      savedValue: "none",
      texts: INCIDENT_TEXTS,
    },
    user,
  );
  return mapped(answer, write);
}
