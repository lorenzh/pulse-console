# Tokens

The Tokens screen lists the admin-side tokens of pulse-api, creates one from a preset, rotates
one with an overlap and revokes one. Only an Admin or the Owner opens it (`token.write`); the
navigation shows Tokens to them only. Probe tokens and locations get their own Probes screen in a
later change; the Tokens list only counts them and links to `/probes`.

## Routes

| Route                    | Methods   | What it does                                                                  |
| ------------------------ | --------- | ----------------------------------------------------------------------------- |
| `/tokens`                | GET       | The list                                                                      |
| `/tokens/new`            | GET, POST | The create form; POST creates the token and shows its secret once             |
| `/tokens/rotate?id=<id>` | GET, POST | A plain confirmation; POST rotates and shows the new secret once              |
| `/tokens/revoke?id=<id>` | GET, POST | A typed-name confirmation; POST revokes, then `303` to `/tokens?revoked=<id>` |

Member and Viewer get `403` on every route, also on a forged POST; no api call is made. Every
page reads pulse-api at the stored instance URL with the console token, 5000 ms per read, no
redirect followed.

## Which token is the console's own

Every page and every POST reads `GET /admin/tokens/self` fresh. The row with the same `id` is
the console's own token. It is marked `This console` and has no action: rotate or revoke it in
pulse-api with its token file or the API, then restart the console. A forged POST for it answers
`409` `This is the console's own token. Nothing was changed.` and sends nothing. The match is by
id only; another token with the same name is not protected.

When `/self` answers `404`, times out, cannot be reached, has an invalid body or a wrong wire
header, the list still shows what could be read, with the banner `The console cannot tell which
token it uses (pulse-api answered <reason>). Changes are off until it can. pulse-api needs GET
/admin/tokens/self.` Every create, rotate and revoke link is gone and every POST answers `503`
with that text, without a write. A `401` shows the token-rejected banner instead.

## List

The list reads `GET /admin/tokens` and `/self` at the same time. It shows the tokens whose scopes
are not exactly `["probe"]`, in two tables in the api's order: `Active` (not revoked, no expiry
or one later than now) and `Revoked or expired`. Columns: name, id, access, source, created
(UTC), last used (`Never` when unused), state and actions. The state is `Active`, `Active,
expires <UTC>`, `Rotated: old secret valid until <UTC>`, `Revoked <UTC>` or `Expired <UTC>`.
Under the tables: `Probe tokens are on the Probes page (<n>).`

When exactly one active token holds `admin`, its Revoke is replaced by `Last active admin token:
it cannot be revoked.`, and a POST for it answers `409`. When that token expires, a banner says
when: after that nobody can manage pulse-api tokens.

## Presets

Create takes a name (trimmed, 1 to 100 characters, no control characters) and one preset, with no
default:

| Preset         | Scopes sent                                |
| -------------- | ------------------------------------------ |
| Read           | `["read"]`                                 |
| Manage checks  | `["read", "checks", "admin"]`              |
| Post incidents | `["read", "incidents", "admin"]`           |
| Full access    | `["read", "checks", "incidents", "admin"]` |

The three admin presets also allow creating, rotating and revoking tokens with the same or fewer
scopes, and reading the audit log. A preset with a scope the console token lacks is disabled with
`The console token lacks <scope>.`, and a forged POST gets that field error. The api body is
`{"name": <trimmed name>, "scopes": <preset scopes>}`; there is no expiry on create.

## Show once

A created or rotated token's secret is shown in the POST answer only (`200`, `no-store`), in
`<pre id="token-secret" data-secret>` with a copy button. pulse-api keeps only a hash, so it is
never shown again. The secret is never stored by the console, logged, put in a metric, a URL, a
cookie or browser storage. A reload or a resent request carries a used form token and answers
`409` `Already submitted` without an api call. `/console.js` replaces every `[data-secret]` text
with `Hidden: the secret was shown once.` on `pagehide` and on a back/forward cache restore.
Without JavaScript the answer is `no-store`, so Back cannot show it again.

## Rotate

Rotation keeps the old secret working until the `previousValidUntil` that pulse-api returns (10
minutes today; the console never assumes it). The answer shows `The old secret keeps working
until <UTC> (<mm:ss> left).`, or `The old secret no longer works.` when there is no overlap.
`/console.js` counts every `time[data-countdown]` down once a second with one interval, which it
starts only when a countdown is above zero and clears at zero and on `pagehide`.

## Order of a rotate or revoke POST

After the dispatcher's checks: read `/self` (`503` on failure); read `GET /admin/tokens/<id>`
(`404` for an unknown id or a probe token); the own token (`409`); the `revision` of the form
against the current row (`409` `Changed since you opened it`); a revoked or expired row (`409`
`This token is already revoked or expired.`); for revoke the typed name (`422`) and the last
active admin token (`409`); the grant rule (`403` `The console token lacks <scope>.`); the session
and the stored role again; one POST to pulse-api, never retried.

The revision is the SHA-256 of `[id, name, scopes, location, expiresAt, revokedAt, rotatedAt]`.
A token revoked by someone else after the page opened changed its revision, so it shows the stale
page. Last use and the overlap end are not part of it.

## pulse-api answers

A `400` or `422` shows the form again with the api message, a `409` the confirmation again. `401`
shows the token-rejected banner, `403` `pulse-api refused: the console token lacks a scope this
token holds.`, `429` a throttle text, and other errors `pulse-api refused the request (<status>).
Nothing was changed.` A timeout, a redirect or a wrong wire header answers `504` or `502` `The
result is unknown. Open the list to see whether the token was created, rotated or revoked.` A
saved change whose answer cannot be read answers `502`: the secret cannot be shown, so revoke the
new token or rotate it again.

Each sent change adds one People log row (`token.create`, `token.rotate` or `token.revoke`,
target the token id, value `scopes=<list>`, ` (unknown)` when the outcome is not known). A row
that cannot be written logs `token change not logged` and, after a confirmed change, adds `Saved
in pulse-api. The People log row could not be written.` to the page.
