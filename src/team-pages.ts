import { escapeHtml } from "@lorenzh/pulse-kit";
import { utcMinute } from "./account-pages.ts";
import { plainConfirmPage, typedConfirmPage } from "./confirm.ts";
import {
  csrfField,
  field,
  formErrorSummary,
  formTokenField,
  paragraph,
  plainDocument,
  submitButton,
} from "./html.ts";
import { targetDecision } from "./permissions.ts";
import { type ConsoleRole, roleLabel } from "./roles.ts";
import { callout } from "./states.ts";
import type { PendingInvite, TeamMember } from "./team-store.ts";

/** The kept values and errors of a refused invite form. */
export type InviteFormState = {
  email?: string | undefined;
  role?: string | undefined;
  errors?: Partial<Record<"email" | "role", string | undefined>> | undefined;
  notice?: string | undefined;
};

export type TeamView = {
  role: ConsoleRole;
  members: readonly TeamMember[];
  invites: readonly PendingInvite[];
  isTwoFactorRequiredForAll: boolean;
  now: number;
  csrf: string;
  /** The form token of the invite form, bound to `/team/invites`. */
  inviteFormToken: string;
  /** The form token of the Owner's 2FA switch, bound to `/team/require-2fa`. */
  switchFormToken?: string | undefined;
  /** An error or expired notice above the 2FA switch. */
  switchNotice?: string | undefined;
  inviteForm?: InviteFormState | undefined;
};

export const NOT_SAVED_TEXT =
  "Your password or session changed while this was saved. Nothing was changed.";
export const LINK_NOT_VALID_TEXT =
  "This link is not valid. It may have expired or been used. Ask an admin for a new one.";

const MEMBER_ACTIONS = [
  { kind: "role-change", path: "/team/role", label: "Change role" },
  { kind: "reset-link", path: "/team/reset-link", label: "Reset link" },
  { kind: "2fa-reset", path: "/team/reset-2fa", label: "Reset 2FA" },
  { kind: "remove", path: "/team/remove", label: "Remove" },
  { kind: "transfer", path: "/team/transfer", label: "Make owner" },
] as const;

/** Decision 9: each action is a link to its own page, never a form in the row. */
function memberActions(m: TeamMember, actor: ConsoleRole): string {
  const links = MEMBER_ACTIONS.filter((a) => targetDecision(actor, a.kind, m.role).isAllowed).map(
    (a) =>
      `<a href="${a.path}?user=${m.id}">${a.label}<span class="visually-hidden"> for ${escapeHtml(m.name)}</span></a>`,
  );
  return links.length === 0 ? "" : `<span class="row-actions">${links.join(" ")}</span>`;
}

function memberRow(m: TeamMember, actor: ConsoleRole): string {
  return `<tr>
<td>${escapeHtml(m.name)}</td>
<td>${escapeHtml(m.email)}</td>
<td>${roleTag(m.role)}</td>
<td>${m.hasAuthenticator ? "2FA: on" : "2FA: off"}</td>
<td>${memberActions(m, actor)}</td>
</tr>`;
}

function inviteRow(invite: PendingInvite, view: TeamView): string {
  const state = view.now < invite.expiresAt ? "pending" : "expired";
  const canRevoke = targetDecision(view.role, "invite", invite.role).isAllowed;
  const action = canRevoke
    ? `<a href="/team/invites/revoke?invite=${invite.id}">Revoke<span class="visually-hidden"> the invite for ${escapeHtml(invite.email)}</span></a>`
    : "";
  return `<tr>
<td>${escapeHtml(invite.email)}</td>
<td>${roleTag(invite.role)}</td>
<td>${escapeHtml(invite.createdByName ?? "removed")}</td>
<td>${escapeHtml(utcMinute(invite.expiresAt))}</td>
<td>${state}</td>
<td>${action}</td>
</tr>`;
}

function warningNotice(text: string | undefined): string {
  return text === undefined
    ? ""
    : callout({ kind: "warning", body: paragraph(text), role: "alert" });
}

function roleTag(role: ConsoleRole): string {
  return `<span class="tag tag-neutral">${escapeHtml(roleLabel(role))}</span>`;
}

function tableBox(name: string, table: string): string {
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="${name}">
${table}
</div>`;
}

function roleOption(value: string, label: string, selected: string | undefined): string {
  const isSelected = value === selected ? " selected" : "";
  return `<option value="${value}"${isSelected}>${label}</option>`;
}

function inviteFormHtml(view: TeamView): string {
  const form = view.inviteForm ?? {};
  const errors = form.errors ?? {};
  const summary = formErrorSummary(
    (["email", "role"] as const).flatMap((name) => {
      const text = errors[name];
      return text === undefined ? [] : [{ name, text }];
    }),
  );
  const roleError =
    errors.role === undefined
      ? ""
      : `\n<span class="error" id="field-role-error">${escapeHtml(errors.role)}</span>`;
  const roleDescribed =
    errors.role === undefined ? "" : ' aria-describedby="field-role-error" aria-invalid="true"';
  const adminOption = view.role === "owner" ? `\n${roleOption("admin", "Admin", form.role)}` : "";
  return `<section aria-labelledby="invite-heading">
<h2 id="invite-heading">Invite a person</h2>
${warningNotice(form.notice)}${summary}<form method="post" action="/team/invites" class="invite-form">
${csrfField(view.csrf)}
${formTokenField(view.inviteFormToken)}
${field({ label: "Email", name: "email", type: "email", autocomplete: "off", value: form.email, error: errors.email })}
<label for="field-role">Role
<select id="field-role" name="role"${roleDescribed}>
${roleOption("member", "Member", form.role)}
${roleOption("viewer", "Viewer", form.role)}${adminOption}
</select>${roleError}
</label>
<div class="actions">${submitButton({ label: "Create invite link", busyLabel: "Creating…" })}</div>
</form>
</section>`;
}

function invitesSection(view: TeamView): string {
  if (view.invites.length === 0) {
    return `<section aria-labelledby="invites-heading">
<h2 id="invites-heading">Pending invites</h2>
<p>No pending invites.</p>
</section>`;
  }
  return `<section aria-labelledby="invites-heading">
<h2 id="invites-heading">Pending invites</h2>
${tableBox(
  "Pending invites table",
  `<table>
<thead><tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Created by</th><th scope="col">Expires</th><th scope="col">State</th><th scope="col">Actions</th></tr></thead>
<tbody>
${view.invites.map((i) => inviteRow(i, view)).join("\n")}
</tbody>
</table>`,
)}
</section>`;
}

function organisationSection(view: TeamView): string {
  if (view.role !== "owner") return "";
  const isOn = view.isTwoFactorRequiredForAll;
  const next = isOn ? "off" : "on";
  const label = isOn ? "Turn off" : "Turn on";
  const form =
    view.switchFormToken === undefined
      ? ""
      : `
<form method="post" action="/team/require-2fa">
${csrfField(view.csrf)}
${formTokenField(view.switchFormToken)}
<input type="hidden" name="value" value="${next}">
<div class="actions">${submitButton({ label, busyLabel: "Saving…" })}</div>
</form>`;
  return `
<section aria-labelledby="org-2fa-heading">
<h2 id="org-2fa-heading">Organisation 2FA</h2>
<p>Two-factor sign-in for everyone: ${isOn ? "on" : "off"}.</p>
<p>When it is on, every person must set up an authenticator before they can use the console.</p>
${warningNotice(view.switchNotice)}${form}
</section>`;
}

/** The body of the Team page: People, pending invites and, for the Owner, the 2FA state. */
export function teamPageBody(view: TeamView): string {
  return `<section aria-labelledby="people-heading">
<h2 id="people-heading">People</h2>
${tableBox(
  "Team table",
  `<table>
<thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">2FA</th><th scope="col">Actions</th></tr></thead>
<tbody>
${view.members.map((m) => memberRow(m, view.role)).join("\n")}
</tbody>
</table>`,
)}
</section>
${invitesSection(view)}
${inviteFormHtml(view)}${organisationSection(view)}
`;
}

/** The `200` answer of a created invite: the link, shown only now. */
export function inviteLinkBody(view: {
  link: string;
  email: string;
  role: ConsoleRole;
  expiresAt: number;
}): string {
  return `<section aria-labelledby="link-heading">
<h2 id="link-heading">Invite link</h2>
<p>Email: ${escapeHtml(view.email)}</p>
<p>Role: ${escapeHtml(roleLabel(view.role))}</p>
<label for="invite-link">Link to send to the person
<input id="invite-link" class="link-output" type="text" readonly value="${escapeHtml(view.link)}">
</label>
<p><code>${escapeHtml(view.link)}</code></p>
${paragraph(`It works once and expires on ${utcMinute(view.expiresAt)}. It is shown only now.`)}<p class="plain-foot"><a href="/team">Back to the team</a></p>
</section>`;
}

/** The `409` body when the actor's session row went while the request was saved. */
export function notSavedBody(reloadHref: string): string {
  return callout({
    kind: "error",
    title: "Not saved",
    body: `${paragraph(NOT_SAVED_TEXT)}<p><a href="${escapeHtml(reloadHref)}">Reload</a></p>\n`,
    role: "alert",
  });
}

/** The plain confirmation of revoking one invite. */
export function revokeInviteBody(view: {
  invite: PendingInvite;
  csrf: string;
  formToken: string;
  notice?: string | undefined;
}): string {
  const invite = view.invite;
  return plainConfirmPage({
    consequence: `The invite for ${invite.email} (${roleLabel(invite.role)}) stops working. You can make a new one later.`,
    action: `/team/invites/revoke?invite=${invite.id}`,
    csrf: view.csrf,
    formToken: view.formToken,
    revision: String(invite.id),
    submitLabel: "Revoke invite",
    busyLabel: "Revoking…",
    cancelHref: "/team",
    notice: view.notice,
    tone: "danger",
  });
}

/** The plain `404` page of an unknown, expired, revoked or used link; it names no case. */
export function linkNotValidPage(): string {
  return plainDocument(
    "Link not valid",
    `<p class="plain-foot">${escapeHtml(LINK_NOT_VALID_TEXT)}</p>\n`,
  );
}

/** The accept form of an invite: the bound email as text, never as a field. */
export function acceptInvitePage(view: {
  action: string;
  csrf: string;
  formToken: string;
  email: string;
  role: ConsoleRole;
  name?: string | undefined;
  errors?: Partial<Record<"name" | "password", string | undefined>> | undefined;
  notice?: string | undefined;
}): string {
  const errors = view.errors ?? {};
  const summary = formErrorSummary(
    (["name", "password"] as const).flatMap((name) => {
      const text = errors[name];
      return text === undefined ? [] : [{ name, text }];
    }),
  );
  return plainDocument(
    "Join the team",
    `${warningNotice(view.notice)}${summary}<p>Email: ${escapeHtml(view.email)}</p>
<p>Role: ${escapeHtml(roleLabel(view.role))}</p>
<form method="post" action="${escapeHtml(view.action)}">
${csrfField(view.csrf)}
${formTokenField(view.formToken)}
${field({ label: "Name", name: "name", type: "text", autocomplete: "name", value: view.name, error: errors.name })}
${field({ label: "Password", name: "password", type: "password", autocomplete: "new-password", error: errors.password })}
${field({ label: "Confirm password", name: "password_confirm", type: "password", autocomplete: "new-password" })}
<div class="actions"><button type="submit">Create account</button></div>
</form>`,
  );
}

/** The common parts of a confirmation of one person. */
export type MemberConfirmView = {
  member: TeamMember;
  csrf: string;
  formToken: string;
  notice?: string | undefined;
};

/** The role change form: the other roles among admin, member and viewer. */
export function roleFormBody(
  view: MemberConfirmView & { selected?: string | undefined; error?: string | undefined },
): string {
  const m = view.member;
  const options = (["admin", "member", "viewer"] as const)
    .filter((r) => r !== m.role)
    .map((r) => roleOption(r, roleLabel(r), view.selected))
    .join("\n");
  const described =
    view.error === undefined ? "" : ' aria-describedby="field-role-error" aria-invalid="true"';
  const error =
    view.error === undefined
      ? ""
      : `\n<span class="error" id="field-role-error">${escapeHtml(view.error)}</span>`;
  const summary = formErrorSummary(
    view.error === undefined ? [] : [{ name: "role", text: view.error }],
  );
  return `${warningNotice(view.notice)}${summary}<form method="post" action="/team/role?user=${m.id}" class="panel">
${csrfField(view.csrf)}
${formTokenField(view.formToken)}
<input type="hidden" name="revision" value="${escapeHtml(m.revision)}">
<div class="panel-body"><p>${escapeHtml(m.name)} (${escapeHtml(m.email)}) is ${escapeHtml(roleLabel(m.role))} now. A new role signs them out.</p>
<label for="field-role">New role
<select id="field-role" name="role"${described}>
${options}
</select>${error}
</label></div>
<div class="panel-foot"><a class="button ghost cancel" href="/team">Cancel</a> ${submitButton({ label: "Change role", busyLabel: "Saving…" })}</div>
</form>
`;
}

/** The typed confirmation of removing one person. */
export function removeBody(
  view: MemberConfirmView & { typed?: string | undefined; error?: string | undefined },
): string {
  const name = view.member.name;
  return typedConfirmPage({
    consequence: `${name} loses access to the console now. Their invites stop working. API tokens are not tied to people: tokens that ${name} created or copied stay valid until someone revokes them in pulse-api.`,
    action: `/team/remove?user=${view.member.id}`,
    csrf: view.csrf,
    formToken: view.formToken,
    revision: view.member.revision,
    submitLabel: "Remove",
    busyLabel: "Removing…",
    cancelHref: "/team",
    notice: view.notice,
    targetName: name,
    typed: view.typed,
    error: view.error,
  });
}

/** The typed confirmation of the ownership transfer. */
export function transferBody(
  view: MemberConfirmView & { typed?: string | undefined; error?: string | undefined },
): string {
  const name = view.member.name;
  return typedConfirmPage({
    consequence: `Make ${name} the owner? You become an admin. Both of you are signed out and sign in again.`,
    action: `/team/transfer?user=${view.member.id}`,
    csrf: view.csrf,
    formToken: view.formToken,
    revision: view.member.revision,
    submitLabel: "Make owner",
    busyLabel: "Transferring…",
    cancelHref: "/team",
    notice: view.notice,
    targetName: name,
    typed: view.typed,
    error: view.error,
  });
}

/** The plain confirmation of resetting another person's two-factor sign-in. */
export function resetTwoFactorBody(view: MemberConfirmView): string {
  return plainConfirmPage({
    consequence: `Reset two-factor sign-in for ${view.member.name}? Their authenticator and recovery codes stop working and they are signed out. They set up two-factor sign-in again if their role needs it.`,
    action: `/team/reset-2fa?user=${view.member.id}`,
    csrf: view.csrf,
    formToken: view.formToken,
    revision: view.member.revision,
    submitLabel: "Reset 2FA",
    busyLabel: "Resetting…",
    cancelHref: "/team",
    notice: view.notice,
    tone: "danger",
  });
}

/** The plain confirmation of making a password reset link for another person. */
export function resetLinkConfirmBody(view: MemberConfirmView): string {
  const name = view.member.name;
  return plainConfirmPage({
    consequence: `Make a password reset link for ${name}? Using it signs ${name} out everywhere.`,
    action: `/team/reset-link?user=${view.member.id}`,
    csrf: view.csrf,
    formToken: view.formToken,
    revision: view.member.revision,
    submitLabel: "Make reset link",
    busyLabel: "Making…",
    cancelHref: "/team",
    notice: view.notice,
    tone: "safe",
  });
}

/** The `200` answer of a made reset link: the link, shown only now. */
export function resetLinkBody(view: { link: string; name: string; expiresAt: number }): string {
  return `<section aria-labelledby="link-heading">
<h2 id="link-heading">Password reset link</h2>
<label for="reset-link">Link to send to ${escapeHtml(view.name)}
<input id="reset-link" class="link-output" type="text" readonly value="${escapeHtml(view.link)}">
</label>
<p><code>${escapeHtml(view.link)}</code></p>
${paragraph(`It works once and expires on ${utcMinute(view.expiresAt)}. Using it signs ${view.name} out everywhere.`)}<p class="plain-foot"><a href="/team">Back to the team</a></p>
</section>`;
}

/** The form of a valid reset link: the account's email as text, never as a field. */
export function resetPasswordPage(view: {
  action: string;
  csrf: string;
  formToken: string;
  email: string;
  error?: string | undefined;
  notice?: string | undefined;
}): string {
  const summary = formErrorSummary(
    view.error === undefined ? [] : [{ name: "password", text: view.error }],
  );
  return plainDocument(
    "Set a new password",
    `${warningNotice(view.notice)}${summary}<p>Email: ${escapeHtml(view.email)}</p>
<form method="post" action="${escapeHtml(view.action)}">
${csrfField(view.csrf)}
${formTokenField(view.formToken)}
${field({ label: "New password", name: "password", type: "password", autocomplete: "new-password", error: view.error })}
${field({ label: "Confirm password", name: "password_confirm", type: "password", autocomplete: "new-password" })}
<div class="actions"><button type="submit">Set password</button></div>
</form>`,
  );
}
