# Maintenance

The Maintenance pages plan, edit and delete the database maintenance windows of pulse-api. They read `GET /admin/maintenance` and `GET /admin/config` with the admin token and write through `POST /admin/maintenance`, `PUT /admin/maintenance/<id>` and `DELETE /admin/maintenance/<id>`.

## Routes and roles

| Route                                | Role             |
| ------------------------------------ | ---------------- |
| `GET /maintenance`                   | every role       |
| `GET`/`POST /maintenance/new`        | Member or higher |
| `GET`/`POST /maintenance/edit?id=`   | Member or higher |
| `GET`/`POST /maintenance/delete?id=` | Admin or higher  |

A role below the route's role answers `403` before any api request. The console token needs the `admin` and `checks` scopes to save a window. An id matches the contract's window id rule (lower case, starts with a letter, at most 64 characters); any other id answers `404`.

## Sections, phases and sources

The list has four sections: Current, Planned, Past and Shadowed. The phase comes from pulse-api, not from the console clock. A window is current from its start; at its end it is past. Past shows at most the 50 most recent windows and says how many there are. A window from the checks file shows the source `File` and has no actions. A database window with the same id as a file window is shadowed: the file window stays in force, and the database copy can only be deleted. A check that is no longer configured shows `(not configured)`.

## Selection snapshot

The form offers checks and components. Saving stores a snapshot of check ids: the checked checks first, then the members of each checked component, without repeats. A later change of a component does not change a saved window. A window needs 1 to 50 checks.

## Times

Times are UTC. The form uses `datetime-local` fields with seconds. Browsers may omit `:00` seconds (`2026-11-06T10:00`); the console reads both forms. A date that does not exist (`2026-02-30T10:00`) or a year over 9999 is refused with `422`. The end must be after the start.

On edit, the console keeps the stored milliseconds when a time did not change. It compares parsed epochs, never text: for start and end separately, it keeps the stored epoch when the parsed value equals the stored value without its milliseconds, else it sends the parsed value. The stored values come only from the database row of the edit POST's own `GET /admin/maintenance`, never from hidden fields or `/admin/config`.

## Note

The note has 1 to 500 UTF-16 units, as the contract counts them, so an emoji counts twice. This differs from the incident rule, which counts code points. A note is not trimmed; leading or trailing white space and control characters are refused.

## Stale input

The form carries the admin revision. A form GET whose two reads disagree reads both once more, so at most 4 requests; if they still disagree, the page shows no form. An edit POST reads `/admin/maintenance` and then `/admin/config` (2 reads); both revisions must equal the posted one, else the form comes back with the input kept, `Open the form again` and 0 writes. A create POST reads only `/admin/config`. A POST never retries a read.

## Request counts

API requests, as reads and writes: list `2/0`; new or edit GET `2/0` (`4/0` with the retry); create POST `1/1`; edit POST `2/1`; delete GET `1/0`; delete POST `0/1`.

## Outcomes

Every write is sent once with a quoted `If-Match` of the revision, a 5000 ms timeout and no retry.

- Saved: `303` to `/maintenance?saved=1` or `/maintenance?deleted=1`, and one People row with the window id.
- `412`: the form again with the stale text. `409`: the id exists or is a file window. `404`: `This maintenance window no longer exists.`
- `403`: `The console token lacks the admin or checks scope. Saving maintenance windows needs both.` with `502`.
- A timeout or an unreadable answer: `The result is unknown. Open Maintenance to see whether the window was saved.` with `504` or `502`, and a People row with the value `unknown`.
- A pulse-api without database windows (`404` or `405` on `/admin/maintenance`) shows `This pulse-api is too old for the Maintenance page.` without a form.
