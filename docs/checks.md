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

Rows are the effective checks in api order, then the shadowed database definitions. The table
has four columns. Check holds the name, then the id in code with the source tag (`checks.json
(read-only)` or `Console`). Target holds the type and the target. State holds the state (the text
of `/checks`; `Unknown` when `/checks` does not list the check; `Shadowed by checks.json` for a
shadowed definition) and the last result time. Actions holds the row actions. At 1280 px the
table fits its box; a long name, id or target is cut with an ellipsis and stays whole in the page
and on the detail page. Narrower screens scroll the table sideways. Words never break inside a
table cell. The counts above the table count only effective
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

- Settings: every stored field with a readable label in the editor's wording (`Interval (ms)`,
  `Retry delay (ms)`, `Record type`, …); a field the console does not know keeps its raw key as
  the label. Env header names as stored, `set` for a kept header value or
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
- Recent results: one row per result, newest first, with times to the millisecond. A note above
  the table reads `One row per result. Each location reports its own result, so two rows can share
  a time.`; `No results yet` has no note. pulse-api returns complete timestamp
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
  curl -fsS -X POST -H 'Authorization: Bearer <secret>' '<pulse-api-url>/heartbeat/nightly-backup'
  ```

  `<pulse-api-url>` and `<secret>` stay placeholders: the console never prints its saved API URL
  here, because that is often an internal address. The note reads `Replace <pulse-api-url> with
  the address under which your job reaches pulse-api, for example https://pulse-api.example.com,
  and <secret> with the secret of this check. The secret is not shown again.` Type the secret inside the quotes: a secret holds only
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

`src/check-editor-page.ts` renders the create and edit forms. Create is served at `/checks/new`, edit at `/checks/edit?id=<id>`.

- Create shows an `id` input and a hidden `type`. Edit shows the id and the type as text and
  has neither input: both come from the stored view.
- Durations are whole milliseconds; each such label ends in `(ms)`. Defaults: method GET, TLS
  port 443 and warn days 14, domain warn days 30 and interval 86400000, heartbeat grace 0.
- HTTP has 20 header rows and 10 JSON assertion rows. The Headers and JSON assertions
  disclosures are always open, on create and edit, with or without stored values. The first `max(existing + 3, 5)` header
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

## Create

`GET /checks/new` (Member and higher; a Viewer gets `403`) without a known `type` shows the six
types, each a link to `?type=<type>` with one line of explanation. With a known type it shows
that type's form with its defaults; it reads nothing from pulse-api.

`POST /checks/new` accepts a form of up to 524288 bytes (every other POST keeps 8192). After the
dispatcher (Origin, content type, size, repeated fields, CSRF, role, form token) it runs, in
this order:

1. Field checks of the posted type only (`422` with the form). A free header row named exactly
   `__proto__` and a header name used twice (compared without case) are field errors before
   any header object is built.
2. The built JSON must be at most 1048576 bytes: `422` `The check is larger than pulse-api
   accepts (1 MiB).`
3. `GET /admin/config`; a failed read answers `502` with the state.
4. An id that is already in `checks` or `shadowed`: `409` `A check with this id exists.`
5. The session row must still exist (`409` `Not saved`) and the stored role must still be
   Member or higher (`403`).
6. One `POST /admin/checks` with `If-Match: "<revision of that read>"`.

A saved check answers `303` to `/checks/check?id=<encoded id>&saved=1`, which says
`Check saved.` An expired form token renders the form of the posted type with the kept
non-secret input (the choice page for an unknown type), `409`. A replayed token answers `409`
`Already submitted` with a link to `/checks/new`.

## Edit

`GET /checks/edit?id=<id>` (Member and higher) reads `GET /admin/config` once and shows the form
of the stored type, filled from that entry, with the read's revision as hidden `revision`. The
id and the type are fixed.

`POST /checks/edit?id=<id>` accepts up to 524288 bytes. After the dispatcher it runs:

1. `GET /admin/config`. A failed read answers `502` with the state, the heading `Not saved: the
   current version could not be read.`, the kept non-secret input as text and a link to open
   the page again. Nothing is sent.
2. The target, in this order: an id in `shadowed` answers `409` `Shadowed by checks.json: only
   Delete and Export are possible.` with Delete (Admin+) and Export links; an id missing from
   `checks` answers `404`; a file check answers `409` `This check comes from checks.json. Edit
   the file to change it.`; the ids `.` and `..` answer `409` (see below). The shadowed test
   comes first, because a shadowed id always also has an effective file entry.
3. A posted `revision` other than the read's answers `409` with the stale state, the kept input
   as text and a `Reload` link. No form is shown.
4. Field checks against that entry only (its type, stored header names and order, kept body,
   secret): `422` with the form and the same revision.
5. The 1 MiB JSON size, then the session and role recheck.
6. One `PUT /admin/checks/<encoded id>` with `If-Match: "<form revision>"`.

A save answers `303` to `/checks/check?id=<encoded id>&saved=1`.

## Delete

`GET /checks/delete?id=<id>` (Admin and higher) reads `GET /admin/config` and shows a typed
confirmation of the check's name (trimmed), with hidden `revision` and `target` (`database` or
`shadowed`). A database check says `The check stops running. Its results stay in pulse-api and
its open incidents are resolved.`; a shadowed definition says `Only the database definition is
removed. The check from checks.json keeps running.` A file check answers `409` `This check
comes from checks.json.`

`POST /checks/delete?id=<id>` reads `GET /admin/config` (a failure says `Not deleted: the
current version could not be read.`), derives the target from it, answers `409` stale when the
posted `target` or `revision` differs, checks the typed name against the read's name (both
trimmed and NFC-normalized; `422` with the confirmation), rechecks the session and role, and
sends one `DELETE /admin/checks/<encoded id>` with `If-Match: "<form revision>"`. A save answers
`303` to `/checks?deleted=1`, which says `Check deleted.`

On edit and delete, the ids `.` and `..` answer `409` `pulse-api cannot address the id "<id>" in
a URL path, so the Console cannot change or delete it.` after the config read and without a
write. An expired form token answers `409` `This form has expired. Nothing was sent. Open it
again to see the current version.` with a link to the same route and `?id=<encoded id>`; it
keeps no input and reads nothing. A replayed token answers `409` `Already submitted` with that
same link.

## Write outcomes

Every write is sent once with a 5000 ms timeout and never follows a redirect. Its outcome
comes only from the response status and the wire header, never from the body:

- `saved`: `200`, `201` or `204` with the wire header. pulse-api answers `2xx` only after its
  commit, so this holds even when the answer body is too large, not JSON or slow. One People
  row with the unquoted `ETag` revision, or `unknown` when the `ETag` is not a revision.
- `refused`: `400` to `599` with the wire header. Nothing was changed, and no People row is
  written. `401` shows the token banner, `403` the scope text, `404` `This check no longer
  exists.`, `409`, `413` and `422` the form with pulse-api's reason, `412` the stale state,
  `429` the throttle text (`503`), other statuses a `502` text.
- `unknown`: no answer in time, a redirect, any other status, or an answer without the wire
  header or with another wire version. One People row with `unknown`; the page says to open
  the check. A proxy in front of pulse-api that answers on its own makes such an answer.

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
- The error budget: from 0 to 100 it shows `<value with one decimal> % of the error budget left`;
  below 0 (also `-0.04`) it shows `Error budget exceeded` with no number; above 100 it shows
  `Error budget not available`.
- A reason `latency <decimal>ms …` that an older probe stored shows the latency rounded to whole
  ms (`latency 1501.4197810000041ms over objective 500ms` shows
  `latency 1501ms over objective 500ms`). Every other reason shows as served.
- Times are UTC, `YYYY-MM-DD HH:MM:SS UTC`; Recent results shows `YYYY-MM-DD HH:MM:SS.mmm UTC`.

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

## Guidance and limits

- Body line breaks: a browser submits the line breaks of a textarea as CRLF (HTML form rules).
  The console sends the body unchanged, so the probe sends CRLF line breaks. Use a body without
  line breaks, such as one-line JSON, when the target needs LF.
- Headers: use one row per header name. Names are compared case-insensitively, so `Accept` and
  `ACCEPT` are a duplicate (`422` on the second row), checked before the headers object is built.
- Source and shadowing: a check in `checks.json` wins over a database check with the same id.
  The database definition is then shown as `Shadowed by checks.json`; only Delete and Export are
  possible. File checks are changed in `checks.json`, never in the console.
- Write-only values: header values, the body and the heartbeat secret are never shown or
  exported. An edit keeps them unless you choose Replace or Remove. A refused form drops them
  with `Not kept for safety: enter it again.`; an expired edit or delete form keeps no input.
- Quorum: every editor shows the fixed rule "Every probe runs this check. It is down when at
  least two locations report down; with one reporting location, that location decides.
  Choosing locations or a quorum per check is not available yet." Heartbeat editors show
  "Heartbeat checks are not run by probes and have no quorum; your job pings pulse-api. With no
  ping for longer than the period plus the grace time, the check is down at once." instead.
- TLS and domain checks warn `warn_days` days before the certificate or registration expires.
- Older pulse-api: an answer without database checks shows the old-api state; upgrade pulse-api.
- Typed delete: the typed name and the check's name are both trimmed and NFC-normalized, so outer
  spaces do not count; inner spaces and case do.
- Tokens: the CSRF value and the form token appear only in the hidden `csrf` and `form_token`
  controls of a form, including the shell's sign-out form on error pages. They never appear in
  other HTML, headers (apart from the session's own `Set-Cookie`), redirects, downloads, logs or
  `/metrics`.
- Proxy limit: the outcome relies on pulse-api's wire header. A proxy that strips it turns every
  answer into `unknown`; one that adds it to its own answers can make a refusal look like
  pulse-api's.
