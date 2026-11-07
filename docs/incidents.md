# Incidents

The Incidents pages show the manual incidents of pulse-api and the automatic incidents of the checks. A Member or higher publishes, updates and resolves a manual incident; an Admin or higher deletes one. Automatic incidents are read-only.

## Routes and roles

| Route                          | Methods               | Role             | What it does                                                             |
| ------------------------------ | --------------------- | ---------------- | ------------------------------------------------------------------------ |
| `/incidents`                   | `GET`, `HEAD`         | every role       | The list, the MTTR lines and the filters.                                |
| `/incidents/manual?id=<id>`    | `GET`, `HEAD`         | every role       | A manual incident and its timeline.                                      |
| `/incidents/automatic?id=<id>` | `GET`, `HEAD`         | every role       | An automatic incident, its check, reason and recent results.             |
| `/incidents/new[?from=<id>]`   | `GET`, `HEAD`, `POST` | Member or higher | The composer. `from` preselects the components of an automatic incident. |
| `/incidents/update?id=<id>`    | `GET`, `HEAD`, `POST` | Member or higher | Post a public update.                                                    |
| `/incidents/resolve?id=<id>`   | `GET`, `HEAD`, `POST` | Member or higher | Resolve with a last message.                                             |
| `/incidents/delete?id=<id>`    | `GET`, `HEAD`, `POST` | Admin or higher  | Delete after typing the name.                                            |

An id must match `^[1-9][0-9]{0,14}$`; any other value, or a repeated id, is the shell `404`. Another method is `405` with `allow`. The pages read only public incidents: a private or draft item is dropped before it is validated, and a manual list that answers `404` is an empty list. The console token needs the `admin` and `incidents` scopes of pulse-api for incident writes.

## List and MTTR

Open incidents come first, then resolved ones. On equal times a manual incident comes before an automatic one, then the higher id. At most 200 rows are shown. The filters (kind, state) only change the rows, never the MTTR samples.

MTTR is the mean of `resolvedAt - startedAt` over resolved incidents, in two separate populations:

- manual: the 50 most recent resolved manual incidents;
- automatic: the automatic incidents resolved in the last 14 days. When pulse-api returns the read limit of 1000 items, the console does not compute it, because the sample may be cut.

Durations read `under 1 min`, `<m> min`, `<h> h <m> min` or `<d> d <h> h`. No sample shows `—`.

## Text limits

The title has 1 to 200 characters and a message 1 to 2000 characters. Characters are Unicode code points, as pulse-api counts them, so an emoji counts once. The console adds no other length rule. The contract comments may describe the limit in other words; the console follows the runtime validator, so a contract change could move it. The maintenance note counts UTF-16 units instead ([maintenance.md](maintenance.md)). A message keeps its line breaks (CRLF and CR become LF) and is never trimmed; the title is not trimmed either.

## Untitled incidents

A title with no letter, digit, punctuation mark or symbol (for example only spaces or `U+200B`) is untitled. The console shows it as `Untitled incident #<id>` in links, headings and confirmations; the preview and the API body keep the raw text. The composer refuses a new untitled title with `The title needs at least one letter, digit, punctuation mark or symbol.` The delete confirmation of an untitled incident asks for `Incident <id>`; a titled one asks for its title. The typed name is trimmed and compared in NFC.

## Preview

Each form has a status-card preview. The server renders it after `Update preview` with zero writes; with JavaScript on, the console script updates the same parts as you type, without a request, storage or timer. The open preview shows only the newest update; the resolved preview shows all updates. Times are not part of the preview, and the container layout of the status page is not compared.

## Automatic shortcut

An automatic incident links to `/incidents/new?from=<id>`. The composer preselects every component that holds that check. Publishing creates a manual incident and leaves the automatic one unchanged. A check id of `.` or `..` has no addressable results path, so the detail shows the unavailable-results text and reads no results.

## Drafts

Posting an update keeps a private draft of the incident in pulse-api. Resolving discards it. A resolved incident cannot be reopened; its update and resolve pages answer `409` `This incident is already resolved.`

## Outcomes

Every write is sent once, without `If-Match` and without a retry, with a 5000 ms timeout.

- Saved: a redirect with `published`, `posted`, `resolved` or `deleted`. A create whose answer cannot be read redirects to `/incidents?published=1` (`Incident published. Open the list to find it.`).
- `400`, `413`: the form again with `422` and the api message (escaped, at most 1000 characters). `409`: the form with `409`. `429`: the form with `503`.
- `404`: `This incident does not exist or is not public.`
- `401`: the token banner with `502`. `403`: `The console token lacks the admin or incidents scope. Incident changes need both.` with `502`.
- A timeout or an unreadable answer: `The result is unknown. Open the incident list to see whether the change was published before you send it again.` with `504` or `502`.

Each saved change appends one People row; the incident id is the target (`unknown` when the create answer has no id).
