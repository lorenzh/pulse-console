import { escapeHtml, type Logger } from "@lorenzh/pulse-kit";
import { linkDigest, linkUrl, newLinkToken } from "./account-links.ts";
import type { AccountStore } from "./account-store.ts";
import { typedNameError } from "./confirm.ts";
import { checkEmail } from "./forms.ts";
import { routeRole, type TeamActionKind, targetDecision } from "./permissions.ts";
import type { PageRequest, PageResult, ProtectedRoute } from "./protected-route.ts";
import { callout, forbiddenState, formExpiredNotice, notFoundState, staleState } from "./states.ts";
import {
  type InviteFormState,
  inviteLinkBody,
  type MemberConfirmView,
  notSavedBody,
  removeBody,
  resetLinkBody,
  resetLinkConfirmBody,
  resetTwoFactorBody,
  revokeInviteBody,
  roleFormBody,
  teamPageBody,
  transferBody,
} from "./team-pages.ts";
import type {
  InviteRole,
  TargetChangeResult,
  TargetDenial,
  TargetInput,
  TeamMember,
  TeamStore,
} from "./team-store.ts";

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
    body: callout({ kind: "error", body: `<p>${SAVE_FAILED}</p>\n`, role: "alert" }),
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
  switchNotice?: string,
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
      switchFormToken:
        request.role === "owner" ? request.issueFormToken("/team/require-2fa") : undefined,
      switchNotice,
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
  if (!deps.teamStore.isGuardHeld(guardOf(request))) return notSaved("/team");
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

/** The kept input and error of a refused member form. */
type MemberFormExtras = {
  notice?: string | undefined;
  typed?: string | undefined;
  selected?: string | undefined;
  error?: string | undefined;
};

/** A committed change may answer with its own page (the reset link, shown once). */
type OperationResult = TargetChangeResult & { page?: PageResult };

/** One guarded change of one person: role change, removal, 2FA reset or transfer. */
type MemberOperation = {
  path: string;
  title: string;
  kind: TeamActionKind;
  /** The route's coarse action; its lowest role is the route's `requiredRole`. */
  routeAction:
    | "remove.member"
    | "role.member-viewer"
    | "2fa-reset.member"
    | "reset-link.member"
    | "owner.transfer";
  knownFields: readonly string[];
  logAction: string;
  render: (view: MemberConfirmView & MemberFormExtras) => string;
  /** The role a role change names, for the target rule; undefined for other kinds. */
  toRoleOf?: (request: PageRequest) => InviteRole | undefined;
  /** A refused field before the target rule (`422`). */
  fieldError?: (request: PageRequest) => string | undefined;
  /** A refusal after the revision check: the typed name, the same role or a missing factor. */
  lateRefusal?: (request: PageRequest, member: TeamMember) => PageResult | undefined;
  commit: (
    store: TeamStore,
    guard: ReturnType<typeof guardOf>,
    input: TargetInput,
    request: PageRequest,
    deps: TeamRouteDeps,
  ) => OperationResult;
  success: PageResult;
};

function memberForm(
  op: MemberOperation,
  request: PageRequest,
  member: TeamMember,
  status: number,
  extras: MemberFormExtras = {},
): PageResult {
  const formToken = request.issueFormToken(op.path);
  const body = op.render({ member, csrf: request.csrf, formToken, ...extras });
  return { kind: "page", status, title: op.title, body };
}

function staleForm(op: MemberOperation, request: PageRequest, member: TeamMember): PageResult {
  const reloadHref = `${op.path}?user=${member.id}`;
  const page = memberForm(op, request, member, 409, keptExtras(request));
  if (page.kind !== "page") return page;
  return { ...page, body: staleState({ status: 409, reloadHref }) + page.body };
}

function keptExtras(request: PageRequest): MemberFormExtras {
  return { typed: request.fields.confirm_name, selected: request.fields.role };
}

/** The checks before the commit, in the order of section 3; undefined admits the commit. */
function precheck(
  op: MemberOperation,
  request: PageRequest,
  member: TeamMember,
): PageResult | undefined {
  const isPost = request.method === "POST";
  const fieldError = isPost ? op.fieldError?.(request) : undefined;
  if (fieldError !== undefined) {
    return memberForm(op, request, member, 422, { ...keptExtras(request), error: fieldError });
  }
  const toRole = isPost ? op.toRoleOf?.(request) : undefined;
  const decision = targetDecision(request.role, op.kind, member.role, toRole);
  if (!decision.isAllowed) return forbidden(request, decision);
  if (!isPost) return memberForm(op, request, member, 200);
  if (request.fields.revision !== member.revision) return staleForm(op, request, member);
  return op.lateRefusal?.(request, member);
}

/** An error callout with the escaped sentence and the way back to the team. */
function refusedBody(sentence: string): string {
  const error = callout({ kind: "error", body: `<p>${sentence}</p>\n`, role: "alert" });
  return `${error}<p><a href="/team">Back to the team</a></p>\n`;
}

function fieldRefused(op: MemberOperation, error: string): PageResult {
  return {
    kind: "page",
    status: 422,
    title: op.title,
    body: refusedBody(escapeHtml(error)),
  };
}

function refusal(
  op: MemberOperation,
  request: PageRequest,
  member: TeamMember,
  result: Exclude<OperationResult, { ok: true }>,
): PageResult {
  switch (result.reason) {
    case "session-gone":
      return notSaved(`${op.path}?user=${member.id}`);
    case "not-found":
      return notFound();
    case "stale":
      return staleForm(op, request, member);
    case "no-authenticator":
      return noAuthenticator(member);
    case "forbidden":
      return forbidden(request, result.denial);
    default: {
      const unknown: never = result;
      return unknown;
    }
  }
}

function runMemberOperation(
  deps: TeamRouteDeps,
  op: MemberOperation,
  request: PageRequest,
): PageResult {
  const id = idOf(request, "user");
  if (id === undefined) return notFound();
  const isPost = request.method === "POST";
  const fieldError = isPost ? op.fieldError?.(request) : undefined;
  const member = deps.teamStore.member(id);
  if (fieldError !== undefined && member === undefined) return fieldRefused(op, fieldError);
  if (member === undefined) return notFound();
  // A session ended while the request waited answers Not saved before any target-rule 403.
  if (isPost && !deps.teamStore.isGuardHeld(guardOf(request))) {
    return notSaved(`${op.path}?user=${member.id}`);
  }
  const refused = precheck(op, request, member);
  if (refused !== undefined) return refused;
  const input = { userId: member.id, revision: member.revision, now: deps.now() };
  const saved = commit(deps, () =>
    op.commit(deps.teamStore, guardOf(request), input, request, deps),
  );
  if (!saved.ok) return saveFailed();
  const result = saved.value;
  if (!result.ok) return refusal(op, request, member, result);
  logChange(deps, op.logAction, request.user.id, result.target.id);
  return result.page ?? op.success;
}

function memberRoute(deps: TeamRouteDeps, op: MemberOperation): ProtectedRoute {
  return {
    path: op.path,
    methods: ["GET", "POST"],
    requiredRole: routeRole(op.routeAction),
    navId: "team",
    knownFields: op.knownFields,
    handle: (request) => Promise.resolve(runMemberOperation(deps, op, request)),
    renderForm: (request, notice) => {
      const id = idOf(request, "user");
      const member = id === undefined ? undefined : deps.teamStore.member(id);
      if (member === undefined) return notFound();
      return memberForm(op, request, member, 409, { ...keptExtras(request), notice });
    },
  };
}

function noAuthenticator(member: TeamMember): PageResult {
  return {
    kind: "page",
    status: 409,
    title: "Make owner",
    body: refusedBody(`${escapeHtml(member.name)} has not set up two-factor sign-in yet.`),
  };
}

function typedNameRefusal(op: MemberOperation) {
  return (request: PageRequest, member: TeamMember): PageResult | undefined => {
    const error = typedNameError(request.fields.confirm_name ?? "", member.name);
    if (error === undefined) return undefined;
    return memberForm(op, request, member, 422, { ...keptExtras(request), error });
  };
}

const ROLE_OPERATION: MemberOperation = {
  path: "/team/role",
  title: "Change role",
  kind: "role-change",
  routeAction: "role.member-viewer",
  knownFields: ["role", "revision"],
  logAction: "user.role-change",
  render: roleFormBody,
  toRoleOf: (request) => inviteRoleOf(request.fields.role),
  fieldError: (request) =>
    inviteRoleOf(request.fields.role) === undefined ? INVITE_ROLE_ERROR : undefined,
  lateRefusal: (request, member) =>
    request.fields.role === member.role
      ? memberForm(ROLE_OPERATION, request, member, 422, {
          selected: request.fields.role,
          error: "Choose a different role.",
        })
      : undefined,
  commit: (store, guard, input, request) =>
    store.changeRole(guard, { ...input, toRole: inviteRoleOf(request.fields.role) ?? "viewer" }),
  success: { kind: "redirect", location: "/team" },
};

const REMOVE_OPERATION: MemberOperation = {
  path: "/team/remove",
  title: "Remove person",
  kind: "remove",
  routeAction: "remove.member",
  knownFields: ["revision", "confirm_name"],
  logAction: "user.remove",
  render: removeBody,
  lateRefusal: (request, member) => typedNameRefusal(REMOVE_OPERATION)(request, member),
  commit: (store, guard, input) => store.removeUser(guard, input),
  success: { kind: "redirect", location: "/team" },
};

const RESET_2FA_OPERATION: MemberOperation = {
  path: "/team/reset-2fa",
  title: "Reset 2FA",
  kind: "2fa-reset",
  routeAction: "2fa-reset.member",
  knownFields: ["revision"],
  logAction: "user.2fa-reset",
  render: resetTwoFactorBody,
  commit: (store, guard, input) => store.resetTwoFactor(guard, input),
  success: { kind: "redirect", location: "/team" },
};

const RESET_LINK_OPERATION: MemberOperation = {
  path: "/team/reset-link",
  title: "Password reset link",
  kind: "reset-link",
  routeAction: "reset-link.member",
  knownFields: ["revision"],
  logAction: "user.reset-link",
  render: resetLinkConfirmBody,
  commit: (store, guard, input, request, deps) => {
    const token = newLinkToken(deps.randomBytes);
    const result = store.issueResetLink(guard, { ...input, tokenDigest: linkDigest(token) });
    if (!result.ok) return result;
    const body = resetLinkBody({
      link: linkUrl(request.linkOrigin, "reset", token),
      name: result.target.name,
      expiresAt: result.expiresAt,
    });
    return { ...result, page: { kind: "page", status: 200, title: "Password reset link", body } };
  },
  success: { kind: "redirect", location: "/team" },
};

const TRANSFER_OPERATION: MemberOperation = {
  path: "/team/transfer",
  title: "Make owner",
  kind: "transfer",
  routeAction: "owner.transfer",
  knownFields: ["revision", "confirm_name"],
  logAction: "owner.transfer",
  render: transferBody,
  lateRefusal: (request, member) =>
    member.hasAuthenticator
      ? typedNameRefusal(TRANSFER_OPERATION)(request, member)
      : noAuthenticator(member),
  commit: (store, guard, input) => store.transferOwnership(guard, input),
  // Both people's sessions ended in the commit; the cookie goes with them.
  success: { kind: "redirect", location: "/sign-in?transfer=done", isSessionCleared: true },
};

function setSwitch(deps: TeamRouteDeps, request: PageRequest): PageResult {
  const value = request.fields.value;
  if (value !== "on" && value !== "off") {
    return teamPage(deps, request, 422, undefined, "Choose on or off.");
  }
  const saved = commit(deps, () =>
    deps.teamStore.setTwoFactorRequiredForAll(guardOf(request), {
      isOn: value === "on",
      now: deps.now(),
    }),
  );
  if (!saved.ok) return saveFailed();
  const result = saved.value;
  if (result.ok) {
    deps.log.info("team change", {
      action: "team.require-2fa",
      actorId: request.user.id,
      targetId: null,
    });
    return { kind: "redirect", location: "/team" };
  }
  switch (result.reason) {
    case "session-gone":
      return notSaved("/team");
    case "forbidden":
      return forbidden(request, result.denial);
    case "not-found":
    case "stale":
    case "no-authenticator":
      return notFound();
    default: {
      const unknown: never = result;
      return unknown;
    }
  }
}

/** `POST /team/require-2fa`: the Owner's organisation-wide 2FA switch (`team.require-2fa`). */
export function requireTwoFactorRoute(deps: TeamRouteDeps): ProtectedRoute {
  return {
    path: "/team/require-2fa",
    methods: ["POST"],
    requiredRole: routeRole("team.require-2fa"),
    navId: "team",
    knownFields: ["value"],
    handle: (request) => Promise.resolve(setSwitch(deps, request)),
    renderForm: (request, notice) => teamPage(deps, request, 409, undefined, notice),
  };
}

/** The production protected team routes, keyed by raw path. */
export function teamRoutes(deps: TeamRouteDeps): ProtectedRoute[] {
  return [
    teamRoute(deps),
    inviteRoute(deps),
    revokeInviteRoute(deps),
    memberRoute(deps, ROLE_OPERATION),
    memberRoute(deps, REMOVE_OPERATION),
    memberRoute(deps, RESET_2FA_OPERATION),
    memberRoute(deps, RESET_LINK_OPERATION),
    memberRoute(deps, TRANSFER_OPERATION),
    requireTwoFactorRoute(deps),
  ];
}
