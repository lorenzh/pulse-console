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

## Editor fields

The create and edit forms post fields for all six types. The Console reads only the fields of
the chosen type and never sends the others. An empty optional field means absent.

- All types: `id` (create only: `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`, fixed afterwards), `name`
  (trimmed, 1 to 200 characters, no control character), `availability_target` (at most two
  digits and three decimals, at least 90 and below 100; `100`, `89.999` and `1e2` are refused).
- HTTP: `url`, `method` (default GET), `interval_ms`, `timeout_ms`, `retries` (0 to 10),
  `retry_delay_ms` (0 to 60000), `latency_objective_ms`, `expected_status` (codes or `lo-hi`
  ranges separated by commas, at most 20; `200 , 204` is `[200, 204]`), `keyword` (empty is
  absent), `body`, 20 header rows and 10 JSON assertion rows. A body needs POST, PUT, PATCH,
  DELETE or OPTIONS; HEAD allows no keyword and no assertion.
- TLS: `host`, `port` (default 443), `warn_days` (0 to 3650, default 14), `interval_ms`,
  `timeout_ms`.
- TCP: `host`, `port`, `interval_ms`, `timeout_ms`, `retries`, `retry_delay_ms`.
- DNS: `dns_name`, `record_type` (A, AAAA, CNAME, MX, TXT, NS), `expected` (one value per line,
  blank lines ignored, at most 20), `resolver`, `interval_ms`, `timeout_ms`, `retries`,
  `retry_delay_ms`.
- Domain: `domain`, `warn_days` (default 30), `interval_ms` (at least 3600000, default
  86400000), `timeout_ms`, `retries`, `retry_delay_ms`.
- Heartbeat: `period_ms` (1000 to 86400000), `grace_ms` (0 to 86400000, empty is 0), `secret`
  (16 to 128 characters of `A-Z a-z 0-9 . _ ~ -`, not starting with `replace-with-`).

Durations are whole milliseconds (at most 10 digits), so a stored 1500 comes back as 1500.
After the local rules the built input is checked with the contract's
`validateAdminCheckInput`; an error it finds is shown on the matching field.

Header row `i` (0 to 19) has `header_<i>_name`, `header_<i>_kind` (`plain` or `env`) and
`header_<i>_value`. A row with an empty name and value is ignored. A row named exactly
`__proto__` is refused with `__proto__ is not an allowed header name.`; `__Proto__` or `X-Proto`
are ordinary names. Each name becomes an own key of the headers object.

One header name is used once, compared without case. The Console checks this on the names
before it builds the headers object, in row order: stored rows with Keep or Replace first, then
the free rows. The later row gets `This header is already set in another row (names are compared
without case).` A stored row with Remove frees its name, so a free row can switch the header to
an env value.

JSON assertion row `i` (0 to 9) has `assert_<i>_pointer`, `assert_<i>_mode` (`none`, `exists`
or `equals`) and `assert_<i>_equals`, which must be JSON (`"ok"`, `200`, `true`).

## Editor pages

`src/check-editor-page.ts` renders the create and edit forms; the routes come later.

- Create shows an `id` input and a hidden `type`. Edit shows the id and the type as text and
  has neither input: both come from the stored view.
- Durations are whole milliseconds; each such label ends in `(ms)`. Defaults: method GET, TLS
  port 443 and warn days 14, domain warn days 30 and interval 86400000, heartbeat grace 0.
- HTTP has 20 header rows and 10 JSON assertion rows. The first `max(existing + 3, 5)` header
  rows are open; the rest sit in `More rows`. On edit the stored literal headers come first, as
  text with `Value: set` and Keep, Replace and Remove; env headers fill the next free rows.
- The heartbeat secret is a `password` input with `autocomplete="new-password"`. On edit it
  shows `Secret: set` with Keep and Replace.
- After a failed POST the form keeps all non-secret input. The secret, the body and every
  literal header value come back empty with `Not kept for safety: enter it again.` An env
  header keeps its variable name: it is not a secret.
- An HTTP form with env headers and a valid URL shows the host-binding line in a `<pre>` with a
  copy button (see "Lines to paste into a shell"). Paste it in a POSIX shell such as `sh`, `bash`
  or `dash`; merge its list with the value that the probe already has.
- Above the submit button, HTTP, TLS, TCP, DNS and domain forms state the fixed quorum rule:
  every probe runs the check, it is down when at least two locations report down, and one
  reporting location decides alone. Heartbeat forms state instead that the check has no quorum
  and is down at once after the period plus the grace time. No form has a quorum or location
  field.

## Write-only values on edit

An edit takes the id, the type, the names and order of the stored literal headers, whether a
body is kept and the heartbeat secret from the stored view that the POST read itself. Posted
`id` and `type` are ignored.

- Stored literal headers are rows `0` to `k - 1`. Their names come from the view; only
  `header_<i>_intent` and `header_<i>_value` are read, never a posted name or kind.
- A stored header and a stored body (`body_intent`) take an intent: `keep` (default) sends
  `{"keep": true}`, `replace` needs a non-empty new value (`Enter the new value, or choose
  Remove.`), `remove` leaves the entry out. A value typed with `keep` is refused with `Choose
  Replace to use the new value.` A kept body with GET or HEAD is refused like any body.
- A heartbeat secret takes `secret_intent` `keep` (default, no `secret` is sent) or `replace`
  (a new secret by the create rules).

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
