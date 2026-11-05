# Checks

The Checks screens list, show, create, edit, export and delete the checks of pulse-api. This
page grows with them; today it holds the list, the export and the rules of the helpers that the
screens share.

## List

`GET /checks` (every role) reads `GET /admin/config` with the console token and `GET /checks`
without it, at the same time, 5000 ms each, with no redirect followed. Each failed read logs one
`warn` `api read failed`. The page always answers `200`: a failed read shows the same states as
the Overview, and an api without check sources shows `This pulse-api is too old for the Checks
pages. It needs check sources (pulse-api with #565).`

Rows are the effective checks in api order, then the shadowed database definitions. Columns:
name, id, type, target, source (`checks.json (read-only)` or `Console`), state (the text of
`/checks`; `Unknown` when `/checks` does not list the check; `Shadowed by checks.json` for a
shadowed definition) and the last result time. The counts above the table count only effective
checks (`6 checks`), plus `<m> shadowed definitions` when there are any.

Row actions: View for everyone; Edit for a Member or higher on a Console check that is not
shadowed; Export for a Member or higher; Delete for an Admin or higher on a Console check or a
shadowed definition. Edit and Delete are never offered for the ids `.` and `..`. Hidden actions
are presentation only; the routes check the role themselves. Edit and Delete are not served
yet.

A `checks.json` file status other than `ok` shows a banner with the status, the api message,
`The last valid version from <time> stays in use.` and `Console checks can still be changed.`

## Detail

`GET /checks/check?id=<id>` (every role) shows one effective check. The `id` must occur once and
not be empty; there is no length cap of its own. A missing, repeated or empty id, or an id that
`/admin/config` does not list in `checks`, answers the shell `404`.

The page reads in two rounds. Round 1 reads `/admin/config` and `/checks` together, as the list
does; a failure there shows the shared states and answers `200`. Round 2 reads, together and
without the token: `GET /uptime`, `GET /checks/<id>/results?limit=20[&before=<ms>]`,
`GET /checks/<id>/location-uptime` and, for an HTTP check only, `GET /checks/<id>/latency`. A
failed round-2 read shows its state in its own panel; the other panels render. A `404` from the
location-uptime route shows only `Location uptime needs a newer pulse-api.`

The page shows:

- Settings: every stored field, env header names as stored, `set` for a kept header value or
  body, `Secret: set` for a heartbeat. No write-only value is ever shown.
- State: state, consecutive down, last result and reason, the maintenance window when present,
  certificate days left for TLS and domain, and the SLO text (`No availability objective`,
  `Objective <target> %: no results in the last 30 days`, or the availability with the error
  budget).
- Locations: one row per name from `/checks` and from the location uptime, joined by name in
  code-unit order. A name on only one side still gets a row. The 90-day uptime reads
  `<percent> with <good> of <results> results`, or `No results in 90 days`. The location
  `heartbeat` of a heartbeat check reads `Heartbeat pings`, its latency `Not applicable`. The fixed
  quorum rule stands above the table.
- Uptime: the aggregate over 90 days and every day in a `<details>` table.
- Latency (HTTP only): 90 days, newest first; 14 rows visible and the rest in `<details>`.
- Recent results: the rows of one page, newest first. pulse-api returns complete timestamp
  groups, so a page can hold more than 20 rows. `Older results` links to `before=<timestamp of
  the last row>`; a page with `before` also has `Newest results`. A `before` that is not 1 to 16
  digits is ignored.
- The host-binding line for an HTTP check with env headers, and the heartbeat example for a
  heartbeat check, each in a `<pre>` with a copy button (see below).

Actions follow the role as in the list. The page has no form.

## Shadowed definition

`GET /checks/shadowed?id=<id>` (every role) reads only `/admin/config` and shows the stored
definition from `shadowed`, with `Shadowed by checks.json: the check from checks.json runs
instead. This definition is kept in the database.` It shows no state, results, uptime, latency
or SLO. It links to the effective check, Export (Member or higher) and Delete (Admin or
higher). An id that `shadowed` does not list answers `404`.

## Copy buttons

`/console.js` shows every `button[data-copy]` and copies the `textContent` of the element it
names. Without JavaScript, or without a clipboard, the button stays hidden and the text stays
selectable in its `<pre>`. The `<pre>` holds the escaped line, so the copied text is exactly the
line below.

## Lines to paste into a shell

Two lines are meant to be pasted into a POSIX shell: the probe host-binding line of a check with
env headers and the heartbeat example. HTML escaping protects only the page, not the copied
text, so both lines are built in `src/shell-line.ts` and nowhere else.

- Every value from data (host names, the pulse-api URL, the heartbeat URL) is one single-quoted
  word. Each `'` in it becomes `'\''`. A plain word is quoted too; there is no allow-list.
- The host-binding line is `PULSE_PROBE_HEADER_HOSTS=` and the quoted JSON text of one object:
  each env variable of the check, in header order, maps to a list with the host of the check
  URL. The JSON text is quoted as a whole, so a host such as `a';id;'b` stays data:

  ```sh
  PULSE_PROBE_HEADER_HOSTS='{"PULSE_HEADER_TOKEN":["a'\'';id;'\''b"]}'
  ```

- The heartbeat example quotes the header and the URL:

  ```sh
  curl -fsS -X POST -H 'Authorization: Bearer <secret>' 'http://localhost:3000/heartbeat/nightly-backup'
  ```

  `<secret>` stays a placeholder. Type the secret inside the quotes: a secret holds only
  `A-Z a-z 0-9 . _ ~ -`.

## Ids `.` and `..`

A URL parser turns the path segments `.` and `..` into dot segments, so pulse-api cannot be
asked for such an id. `apiIdSegment` in `src/api-path.ts` is the only way an id enters an api
path; it encodes the id as one segment and refuses exactly `.` and `..`.

Such a check is still listed, exported and shown. Its detail page reads only `/admin/config`,
`/checks` and `/uptime`; the results, location-uptime and latency panels say `pulse-api cannot
address the id "<id>" in a URL path, so its results, per-location uptime and latency cannot be
read. Rename the check to use them.` A heartbeat check shows `... so pulse-api cannot receive
pings for it. Rename the check.` instead of the curl line.

## Display formats

- Percentages are never rounded up: `99.995` shows `99.99 %`, `100` shows `100 %`, no results
  show `No results`.
- The error budget takes its sign from the raw value: `-0.04` shows
  `Error budget exceeded (-0.0 %)`.
- Times are UTC, `YYYY-MM-DD HH:MM:SS UTC`.

## List filters

The list takes `q` (at most 200 characters after trimming, compared without case against id,
name and target), `type`, `state` and `source` (`file`, `database`, `shadowed`). Filters combine
with AND. A repeated, empty or unknown value is ignored, and the page says
`Some filter values were not understood and were ignored.` A state never matches a shadowed
definition.

## Export

`GET /checks/export` (Member or higher) answers a JSON attachment with `cache-control: no-store`;
`HEAD` sends no body.

- No query: the whole `GET /admin/config/export` document, as `checks.json`.
- `?id=<id>`: one effective check from the same document, as `check.json`.
- `?id=<id>&shadowed=1`: the shadowed definition from `GET /admin/config`, as `check.json`.

An unknown id and any other query shape answer `404`. A failed read answers `502` with the
failure state.

The export leaves out literal header values, bodies and heartbeat secrets and lists them in
`redacted`. The export of one check holds its entry, its maintenance windows and its `redacted`
entries. The export of a shadowed definition follows the same rules from the stored view: no
`source`, no `hasSecret`, no keep marker, and no maintenance windows, because those belong to the
check that runs.
