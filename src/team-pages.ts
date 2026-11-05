import { escapeHtml } from "@lorenzh/pulse-kit";
import { utcMinute } from "./account-pages.ts";
import { type ConsoleRole, roleLabel } from "./roles.ts";
import type { PendingInvite, TeamMember } from "./team-store.ts";

export type TeamView = {
  role: ConsoleRole;
  members: readonly TeamMember[];
  invites: readonly PendingInvite[];
  isTwoFactorRequiredForAll: boolean;
  now: number;
};

function memberRow(m: TeamMember): string {
  return `<tr>
<td>${escapeHtml(m.name)}</td>
<td>${escapeHtml(m.email)}</td>
<td>${escapeHtml(roleLabel(m.role))}</td>
<td>${m.hasAuthenticator ? "2FA: on" : "2FA: off"}</td>
</tr>`;
}

function inviteRow(invite: PendingInvite, now: number): string {
  const state = now < invite.expiresAt ? "pending" : "expired";
  return `<tr>
<td>${escapeHtml(invite.email)}</td>
<td>${escapeHtml(roleLabel(invite.role))}</td>
<td>${escapeHtml(invite.createdByName ?? "removed")}</td>
<td>${escapeHtml(utcMinute(invite.expiresAt))}</td>
<td>${state}</td>
</tr>`;
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
<thead><tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Created by</th><th scope="col">Expires</th><th scope="col">State</th></tr></thead>
<tbody>
${view.invites.map((i) => inviteRow(i, view.now)).join("\n")}
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
${invitesSection(view)}${organisationSection(view)}
`;
}
