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

`GET /team` (Admin and Owner) lists every person with name, email, role and `2FA: on` or `2FA: off`, and every invite that is neither used nor revoked, with email, role, creator name (or `removed`), expiry (`YYYY-MM-DD HH:MM UTC`) and `pending` or `expired`. The Owner also sees the state of the organisation 2FA switch. The actions (invites, reset links, role changes, removal, 2FA reset, transfer) arrive in later steps of #564.

## People log

Every team change appends one row to `people_events` in the same transaction as the change. If the row cannot be written, the change rolls back. Rows are append-only: an update or delete fails with `people_events is append-only`. A row keeps the actor's and target's email and name as they were then. It never holds a token, a link, a password, a TOTP seed or code, a recovery code, a cookie, a form token, a header value or a request body. Failed or denied attempts write no row.

## API tokens and console roles

- Roles are console rules. The console calls pulse-api with its one token from `PULSE_CONSOLE_ADMIN_TOKEN_FILE` or `PULSE_CONSOLE_ADMIN_TOKEN`; pulse-api cannot tell console users apart.
- An Admin may create, rotate and revoke api tokens (row 11). pulse-api lets the console's token create any token whose scopes it holds, including `admin`. A person who copies such a token can use those scopes directly against the api, outside console roles.
- A removed Admin's api tokens stay valid, because they belong to no person.
