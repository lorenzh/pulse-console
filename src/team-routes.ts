import type { Logger } from "@lorenzh/pulse-kit";
import { linkDigest, linkUrl, newLinkToken } from "./account-links.ts";
import type { AccountStore } from "./account-store.ts";
import { checkEmail } from "./forms.ts";
import { routeRole, targetDecision } from "./permissions.ts";
import type { PageRequest, PageResult, ProtectedRoute } from "./protected-route.ts";
import { forbiddenState, formExpiredNotice, notFoundState } from "./states.ts";
import {
  type InviteFormState,
  inviteLinkBody,
  notSavedBody,
  revokeInviteBody,
  teamPageBody,
} from "./team-pages.ts";
import type { InviteRole, TargetDenial, TeamStore } from "./team-store.ts";

export type TeamRouteDeps = {
  store: AccountStore;
  teamStore: TeamStore;
  now: () => number;
  randomBytes: (size: number) => Uint8Array;
  log: Logger;
};

const ID_PATTERN = /^[1-9]\d{0,15}$/;
const INVITE_ROLE_ERROR = "Choose admin, member or viewer.";
const SAVE_FAILED = "The change could not be saved.";

/** A decimal id of the query, or undefined: the route then answers the shell 404. */
function idOf(request: PageRequest, name: string): number | undefined {
  const raw = request.query.get(name);
  return raw !== null && ID_PATTERN.test(raw) ? Number(raw) : undefined;
}

function inviteRoleOf(value: string | undefined): InviteRole | undefined {
  return value === "admin" || value === "member" || value === "viewer" ? value : undefined;
}

function guardOf(request: PageRequest): { sessionId: string; userId: number } {
  return { sessionId: request.sessionId, userId: request.user.id };
}

function notFound(): PageResult {
  return { kind: "page", status: 404, title: "Page not found", body: notFoundState() };
}

function notSaved(reloadHref: string): PageResult {
  return { kind: "page", status: 409, title: "Not saved", body: notSavedBody(reloadHref) };
}

function forbidden(request: PageRequest, denial: TargetDenial): PageResult {
  const body =
    denial.reason === "role"
      ? forbiddenState({ requiredRole: denial.requiredRole, role: request.role })
      : forbiddenState({ target: denial.reason });
  return { kind: "page", status: 403, title: "Access denied", body };
}

function saveFailed(): PageResult {
  return {
    kind: "page",
    status: 500,
    title: "Not saved",
    body: `<p role="alert">${SAVE_FAILED}</p>\n`,
  };
}

/**
 * Runs one team commit. A failed write (also a failed People-log insert) rolled back; it is
 * logged by error name only and answered with 500.
 */
function commit<T>(deps: TeamRouteDeps, work: () => T): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: work() };
  } catch (err) {
    deps.log.error("team change could not be saved", {
      error: err instanceof Error ? err.name : "unknown",
    });
    return { ok: false };
  }
}

function logChange(deps: TeamRouteDeps, action: string, actorId: number, targetId: number): void {
  deps.log.info("team change", { action, actorId, targetId });
}

function teamPage(
  deps: TeamRouteDeps,
  request: PageRequest,
  status: number,
  inviteForm?: InviteFormState,
): PageResult {
  return {
    kind: "page",
    status,
    title: "Team",
    body: teamPageBody({
      role: request.role,
      members: deps.teamStore.members(),
      invites: deps.teamStore.pendingInvites(),
      isTwoFactorRequiredForAll: deps.store.instance()?.isTwoFactorRequiredForAll === true,
      now: deps.now(),
      csrf: request.csrf,
      inviteFormToken: request.issueFormToken("/team/invites"),
      inviteForm,
    }),
  };
}

/** `GET /team`: the People list, pending invites and the invite form (`team.view`). */
export function teamRoute(deps: TeamRouteDeps): ProtectedRoute {
  return {
    path: "/team",
    methods: ["GET"],
    requiredRole: routeRole("team.view"),
    navId: "team",
    handle: (request) => Promise.resolve(teamPage(deps, request, 200)),
  };
}

function keptInvite(request: PageRequest): InviteFormState {
  return { email: request.fields.email, role: request.fields.role };
}

function createInvite(deps: TeamRouteDeps, request: PageRequest): PageResult {
  const email = checkEmail(request.fields.email);
  const role = inviteRoleOf(request.fields.role);
  if (!email.isOk || role === undefined) {
    const errors = {
      email: email.isOk ? undefined : email.text,
      role: role === undefined ? INVITE_ROLE_ERROR : undefined,
    };
    return teamPage(deps, request, 422, { ...keptInvite(request), errors });
  }
  const decision = targetDecision(request.role, "invite", role);
  if (!decision.isAllowed) return forbidden(request, decision);
  const token = newLinkToken(deps.randomBytes);
  const now = deps.now();
  const saved = commit(deps, () =>
    deps.teamStore.createInvite(guardOf(request), {
      email: email.email,
      role,
      tokenDigest: linkDigest(token),
      now,
    }),
  );
  if (!saved.ok) return saveFailed();
  const result = saved.value;
  if (result.ok) {
    logChange(deps, "invite.create", request.user.id, result.id);
    const link = linkUrl(request.linkOrigin, "invite", token);
    const body = inviteLinkBody({ link, email: email.email, role, expiresAt: result.expiresAt });
    return { kind: "page", status: 200, title: "Invite link", body };
  }
  switch (result.reason) {
    case "session-gone":
      return notSaved("/team");
    case "forbidden":
      return forbidden(request, result.denial);
    case "account-exists":
      return teamPage(deps, request, 409, {
        ...keptInvite(request),
        errors: { email: "An account with this email exists." },
      });
    case "invite-pending":
      return teamPage(deps, request, 409, {
        ...keptInvite(request),
        errors: { email: "An invite for this email is pending. Revoke it to make a new one." },
      });
    default: {
      const unknown: never = result;
      return unknown;
    }
  }
}

/** `POST /team/invites`: a new single-use invite link, Admin and Owner (rows 14, 15). */
export function inviteRoute(deps: TeamRouteDeps): ProtectedRoute {
  return {
    path: "/team/invites",
    methods: ["POST"],
    requiredRole: routeRole("invite.member"),
    navId: "team",
    knownFields: ["email", "role"],
    handle: (request) => Promise.resolve(createInvite(deps, request)),
    renderForm: (request, notice) =>
      teamPage(deps, request, 409, { ...keptInvite(request), notice }),
  };
}

function revokeForm(
  deps: TeamRouteDeps,
  request: PageRequest,
  notice: string | undefined,
): PageResult {
  const id = idOf(request, "invite");
  const invite = id === undefined ? undefined : deps.teamStore.pendingInvite(id);
  if (invite === undefined) return notFound();
  const decision = targetDecision(request.role, "invite", invite.role);
  if (!decision.isAllowed) return forbidden(request, decision);
  const formToken = request.issueFormToken("/team/invites/revoke");
  const body = revokeInviteBody({ invite, csrf: request.csrf, formToken, notice });
  return { kind: "page", status: 200, title: "Revoke invite", body };
}

function revokeInvite(deps: TeamRouteDeps, request: PageRequest): PageResult {
  if (request.method !== "POST") return revokeForm(deps, request, undefined);
  const id = idOf(request, "invite");
  if (id === undefined) return notFound();
  const saved = commit(deps, () => deps.teamStore.revokeInvite(guardOf(request), id, deps.now()));
  if (!saved.ok) return saveFailed();
  const result = saved.value;
  if (result.ok) {
    logChange(deps, "invite.revoke", request.user.id, result.id);
    return { kind: "redirect", location: "/team" };
  }
  switch (result.reason) {
    case "session-gone":
      return notSaved(`/team/invites/revoke?invite=${id}`);
    case "not-found":
      return notFound();
    case "forbidden":
      return forbidden(request, result.denial);
    default: {
      const unknown: never = result;
      return unknown;
    }
  }
}

/** `GET`/`POST /team/invites/revoke?invite=<id>`: a plain confirmation (rows 14, 15). */
export function revokeInviteRoute(deps: TeamRouteDeps): ProtectedRoute {
  return {
    path: "/team/invites/revoke",
    methods: ["GET", "POST"],
    requiredRole: routeRole("invite.member"),
    navId: "team",
    knownFields: ["revision"],
    handle: (request) => Promise.resolve(revokeInvite(deps, request)),
    renderForm: (request) => revokeForm(deps, request, formExpiredNotice),
  };
}

/** The production protected team routes, keyed by raw path. */
export function teamRoutes(deps: TeamRouteDeps): ProtectedRoute[] {
  return [teamRoute(deps), inviteRoute(deps), revokeInviteRoute(deps)];
}
