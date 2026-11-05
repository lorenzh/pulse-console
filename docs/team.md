# Team roles

Each person in the console has one role: `owner`, `admin`, `member` or `viewer`. There is exactly one Owner. The role is stored in `users.role` and read from the database on every request; it is never cached in a session or a cookie. A change takes effect on the next request.

The policy is `src/permissions.ts`. Every production page takes its required role from it.

## Permission matrix

Y allowed, N denied. Every row with a Y is monotonic in viewer < member < admin < owner.

| #   | Action id            | Role x action                                             | Viewer | Member | Admin | Owner |
| --- | -------------------- | --------------------------------------------------------- | ------ | ------ | ----- | ----- |
| 1   | `overview.view`      | View status, checks, incidents, maintenance               | Y      | Y      | Y     | Y     |
| 2   | `check.write`        | Create and edit console checks, export                    | N      | Y      | Y     | Y     |
| 3   | `check.delete`       | Delete console checks                                     | N      | N      | Y     | Y     |
| 4   | `incident.write`     | Declare incidents, post updates, resolve manual incidents | N      | Y      | Y     | Y     |
| 5   | `incident.delete`    | Delete manual incidents                                   | N      | N      | Y     | Y     |
| 6   | `incident.edit-text` | Edit existing incident text                               | N      | N      | N     | N     |
| 7   | `maintenance.create` | Plan maintenance                                          | N      | Y      | Y     | Y     |
| 8   | `maintenance.edit`   | Edit a maintenance window                                 | N      | Y      | Y     | Y     |
| 9   | `maintenance.delete` | Delete a maintenance window                               | N      | N      | Y     | Y     |
| 10  | `settings.edit`      | Edit status and notify settings (not built)               | N      | N      | N     | Y     |
| 11  | `token.write`        | Create, rotate, revoke tokens                             | N      | N      | Y     | Y     |
| 12  | `probe.write`        | Add and rotate probe locations                            | N      | N      | Y     | Y     |
| 13  | `activity.view`      | Activity log, System page                                 | N      | N      | Y     | Y     |
| 14  | `invite.member`      | Invite members and viewers                                | N      | N      | Y     | Y     |
| 15  | `invite.admin`       | Invite admins                                             | N      | N      | N     | Y     |
| 16  | `remove.member`      | Remove a member or viewer                                 | N      | N      | Y     | Y     |
| 17  | `remove.admin`       | Remove an admin                                           | N      | N      | N     | Y     |
| 18  | `role.member-viewer` | Change role member <-> viewer                             | N      | N      | N     | Y     |
| 19  | `role.admin`         | Change role to or from admin                              | N      | N      | N     | Y     |
| 20  | `reset-link.member`  | Password reset link, member or viewer                     | N      | N      | Y     | Y     |
| 21  | `reset-link.admin`   | Password reset link, admin                                | N      | N      | N     | Y     |
| 22  | `reset-link.owner`   | Password reset, owner (container command only)            | N      | N      | N     | N     |
| 23  | `2fa-reset.member`   | Reset 2FA of a member or viewer                           | N      | N      | Y     | Y     |
| 24  | `2fa-reset.admin`    | Reset 2FA of an admin                                     | N      | N      | N     | Y     |
| 25  | `owner.transfer`     | Transfer ownership                                        | N      | N      | N     | Y     |
| 26  | `org.delete`         | Delete the organisation                                   | N      | N      | N     | N     |
| 27  | `account.self`       | Own 2FA, password, sessions                               | Y      | Y      | Y     | Y     |

Two console actions name where a row's rule applies: `team.view` (the Team page, Admin and Owner) and `team.require-2fa` (the organisation-wide 2FA switch, Owner only).

A denied role sees the `403` page `Access denied`: "This page needs the <Role> role or higher. Your role is <Role>."

## Target rules

- The Owner is never a target. A request that names the Owner answers `403` with `No one can change the owner account in the console.`
- Admin targets need the Owner: invite, removal, a role change to or from `admin`, reset link and 2FA reset.
- For Member and Viewer targets, removal, reset link and 2FA reset are Admin or higher; a change between `member` and `viewer` is Owner only.
- Nobody is the target of their own team action.
- Invites never carry the role `owner`. Ownership moves only by transfer to an Admin with an authenticator; another target answers `Only an admin can become the owner.`

## Two-factor requirement

The Owner and every Admin must have a TOTP authenticator. The Owner can require it for everyone (`instance.require_2fa_all`, off by default). A user who must have one and has none reaches only `/account/authenticator`, sign-out and the assets; a live full session of such a user counts as `enrol` on its next request. Turning the switch on or off ends no session.

## Team page

`GET /team` (Admin and Owner) lists every person with name, email, role and `2FA: on` or `2FA: off`, and every invite that is neither used nor revoked, with email, role, creator name (or `removed`), expiry (`YYYY-MM-DD HH:MM UTC`) and `pending` or `expired`. Each person row has the action links the actor may use on that person: `Change role`, `Reset 2FA`, `Remove` and `Make owner`. The Owner's row has none, and an Admin sees none on Admin rows. A link only opens a page; it never acts. Each pending invite has a `Revoke` link when the actor may revoke it. The page holds only two forms besides sign-out: the invite form and, for the Owner, the organisation 2FA switch. One form per person and action would evict its own form tokens (100 per session) on a team of about 25. Reset links arrive in a later step of #564.

## Invites

- `POST /team/invites` takes `email` (trimmed and lowercased) and `role`: `admin`, `member` or `viewer`. Any other role, also `owner`, answers `422` `Choose admin, member or viewer.` An Admin may invite Members and Viewers; an Admin invite needs the Owner (`403`).
- The commit runs in one `BEGIN IMMEDIATE` transaction. It first checks that the request's session row still exists (else `409` `Not saved`: `Your password or session changed while this was saved. Nothing was changed.`), then re-reads the actor's role (`403`). An account with the email answers `409` `An account with this email exists.`; a live invite for it answers `409` `An invite for this email is pending. Revoke it to make a new one.`
- The answer shows the link once, in a read-only input and as text, with `It works once and expires on <YYYY-MM-DD HH:MM UTC>. It is shown only now.` No email is sent. A reload re-sends the used form token and answers `409` `Already submitted`.
- The link is `<origin>/invite/<token>`: 32 random bytes as base64url (43 characters). The origin is `PULSE_CONSOLE_PUBLIC_URL`, else `http://<Host>` of the request. The database keeps only the SHA-256 hex digest of the token.
- An invite is live while it is neither used nor revoked and `now < created_at + 604800000` (7 days).
- Whoever may make an invite of that role may revoke it (`/team/invites/revoke?invite=<id>`, a plain confirmation). A used or revoked invite answers `404`; an expired one can be revoked.
- `GET /invite/<token>` shows the email and role as text and a form with `name`, `password` and `password_confirm`. It works only while the invite is live and its creator still exists and still may make it. Every other case answers the same `404` page `Link not valid`, which names no case and no email.
- `POST /invite/<token>` creates the account with the bound email and role (no field can change them), marks the invite used and starts a session: `enrol` (`303` to `/account/authenticator`) for an Admin or while the switch is on, else `full` (`303` to `/`). A session cookie the browser already sent is ended, as at sign-in.
- Creation, revocation and acceptance each append one People-log row: `invite.create`, `invite.revoke`, `invite.accept`.

## Changes of one person

Every route takes `user=<id>` (`^[1-9][0-9]{0,15}$`, else `404`) and a hidden `revision`, `<created_at>-<role>` of the person as shown. Another revision answers `409` `Changed since you opened it`, so a removed and re-used id or a changed role is a stale form. Each commit runs in one `BEGIN IMMEDIATE` transaction: the request's session row (`409` `Not saved`), the actor's stored role (`403`), the target (`404`), its revision (`409`), the target rule (`403`), then the change and one People-log row.

- **Role change** (`/team/role`, Owner only): a choice of the other roles among `admin`, `member` and `viewer`. `owner` or another value answers `422` `Choose admin, member or viewer.`; the current role answers `422` `Choose a different role.` Every session of the person ends. A promoted Admin without an authenticator reaches only enrolment after the next sign-in. Row `user.role-change` with `from_role` and `to_role`.
- **2FA reset** (`/team/reset-2fa`, plain confirmation): deletes the person's authenticators, recovery codes and pending setup keys and every session. The password stays. Row `user.2fa-reset`.
- **Removal** (`/team/remove`, typed confirmation): the page says `<name> loses access to the console now. Their invites stop working. API tokens are not tied to people: tokens that <name> created or copied stay valid until someone revokes them in pulse-api.` The `user.remove` row keeps email, name and role; then the user row goes, and with it sessions, authenticators, pending setup keys, recovery codes and reset links. Invites the person made stay with no creator and stop working. The email can be invited again.
- **Ownership transfer** (`/team/transfer`, typed confirmation, Owner only): the target must be an Admin (`403` `Only an admin can become the owner.`) with an authenticator (`409` `<name> has not set up two-factor sign-in yet.`). The Owner becomes an Admin first, then the target becomes the Owner, so there is always one Owner. Every session of both people ends, the requesting one included; the answer is `303` to `/sign-in?transfer=done` with the session cookie deleted, and the sign-in page says `Ownership is transferred. Sign in again.` Of two concurrent transfers the second commit finds its session gone and answers `409` `Not saved`. Row `owner.transfer`.
- **Organisation 2FA** (`POST /team/require-2fa`, Owner only): `value` `on` or `off` (else `422` `Choose on or off.`). No session ends. Row `team.require-2fa` with `value`.

- **Reset link** (`/team/reset-link`, plain confirmation): makes a single-use link `/reset/<token>`, shown once and stored only as its SHA-256 digest. It works for 86400000 ms (24 hours) while the person keeps the role it was made for and its maker still exists and may still make it. A new link replaces the person's unused one. Making it ends no session. Row `user.reset-link`. Using it sets the new password, ends every session of the person and their other unused links, keeps the authenticator and recovery codes, starts no session and answers `303` to `/sign-in?reset=done` (`Your password is set. Sign in.`). Row `user.password-reset` with value `team`.
- **Own password** (`/account/password`, every role): the current password (`401` `Wrong password.`, five failures then `429`) and the new one twice (12 to 128 characters, `422`). It commits only while the session and the checked hash are unchanged (else `409`), ends the person's other sessions, leaves a pending reset link valid and answers `303` to `/account/password?changed=1`. Row `user.password-change`.

Each committed change logs `info` `team change` with `action`, `actorId` and `targetId` (`null` for the switch).

## People log

Every team change appends one row to `people_events` in the same transaction as the change. If the row cannot be written, the change rolls back. Rows are append-only: an update or delete fails with `people_events is append-only`. A row keeps the actor's and target's email and name as they were then. It never holds a token, a link, a password, a TOTP seed or code, a recovery code, a cookie, a form token, a header value or a request body. Failed or denied attempts write no row.

## API tokens and console roles

- Roles are console rules. The console calls pulse-api with its one token from `PULSE_CONSOLE_ADMIN_TOKEN_FILE` or `PULSE_CONSOLE_ADMIN_TOKEN`; pulse-api cannot tell console users apart.
- An Admin may create, rotate and revoke api tokens (row 11). pulse-api lets the console's token create any token whose scopes it holds, including `admin`. A person who copies such a token can use those scopes directly against the api, outside console roles.
- A removed Admin's api tokens stay valid, because they belong to no person.
