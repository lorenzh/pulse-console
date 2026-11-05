import { escapeHtml } from "@lorenzh/pulse-kit";
import { utcMinute } from "./account-pages.ts";
import { plainConfirmPage } from "./confirm.ts";
import {
  csrfField,
  field,
  formErrorSummary,
  formTokenField,
  paragraph,
  plainDocument,
  submitButton,
} from "./html.ts";
import { messagePage } from "./pages.ts";
import { targetDecision } from "./permissions.ts";
import { type ConsoleRole, roleLabel } from "./roles.ts";
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
  inviteForm?: InviteFormState | undefined;
};

export const NOT_SAVED_TEXT =
  "Your password or session changed while this was saved. Nothing was changed.";
export const LINK_NOT_VALID_TEXT =
  "This link is not valid. It may have expired or been used. Ask an admin for a new one.";

function memberRow(m: TeamMember): string {
  return `<tr>
<td>${escapeHtml(m.name)}</td>
<td>${escapeHtml(m.email)}</td>
<td>${escapeHtml(roleLabel(m.role))}</td>
<td>${m.hasAuthenticator ? "2FA: on" : "2FA: off"}</td>
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
<td>${escapeHtml(roleLabel(invite.role))}</td>
<td>${escapeHtml(invite.createdByName ?? "removed")}</td>
<td>${escapeHtml(utcMinute(invite.expiresAt))}</td>
<td>${state}</td>
<td>${action}</td>
</tr>`;
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
${paragraph(form.notice, ' role="alert"')}${summary}<form method="post" action="/team/invites" class="invite-form">
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
<div class="table-wrap">
<table>
<thead><tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Created by</th><th scope="col">Expires</th><th scope="col">State</th><th scope="col">Actions</th></tr></thead>
<tbody>
${view.invites.map((i) => inviteRow(i, view)).join("\n")}
</tbody>
</table>
</div>
</section>`;
}

function organisationSection(view: TeamView): string {
  if (view.role !== "owner") return "";
  const state = view.isTwoFactorRequiredForAll ? "on" : "off";
  return `
<section aria-labelledby="org-2fa-heading">
<h2 id="org-2fa-heading">Organisation 2FA</h2>
<p>Two-factor sign-in for everyone: ${state}.</p>
</section>`;
}

/** The body of the Team page: People, pending invites and, for the Owner, the 2FA state. */
export function teamPageBody(view: TeamView): string {
  return `<section aria-labelledby="people-heading">
<h2 id="people-heading">People</h2>
<div class="table-wrap">
<table>
<thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">2FA</th></tr></thead>
<tbody>
${view.members.map(memberRow).join("\n")}
</tbody>
</table>
</div>
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
${paragraph(`It works once and expires on ${utcMinute(view.expiresAt)}. It is shown only now.`)}<p><a href="/team">Back to the team</a></p>
</section>`;
}

/** The `409` body when the actor's session row went while the request was saved. */
export function notSavedBody(reloadHref: string): string {
  return `<section class="state state-error" role="alert">
<h2>Not saved</h2>
${paragraph(NOT_SAVED_TEXT)}<p><a href="${escapeHtml(reloadHref)}">Reload</a></p>
</section>
`;
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
  });
}

/** The plain `404` page of an unknown, expired, revoked or used link; it names no case. */
export function linkNotValidPage(): string {
  return messagePage("Link not valid", LINK_NOT_VALID_TEXT);
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
    `${paragraph(view.notice, ' role="alert" class="error"')}${summary}<p>Email: ${escapeHtml(view.email)}</p>
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
