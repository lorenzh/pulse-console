# pulse-console documentation

pulse-console is the web console of pulse. It is a small web server that will manage pulse through the pulse-api admin API. Today it serves first-run setup with a local owner account, password sign-in with sessions, sign-out and the ops routes. Two-factor sign-in follows in [#563](https://github.com/lorenzh/pulse-meta/issues/563).

- [configuration.md](configuration.md): every environment variable, the modes, setup, the database, routes, sign-in and sessions, cookies, the image defaults and the security headers.
- [checks.md](checks.md): the Checks list, its filters, the export and the shell lines.
- [tokens.md](tokens.md): the Tokens and Probes screens: presets, show once, rotation overlap, the console's own token, location states and probe snippets.
- [incidents.md](incidents.md): the Incidents pages: routes, roles, MTTR, text limits, untitled incidents, the preview and the outcomes.
- [team.md](team.md): roles, the permission matrix, target rules, the two-factor requirement and the People log.
- [development.md](development.md): local run, layout, tests, lint and CI.

Related pages in other repositories:

- [pulse-api configuration](https://github.com/lorenzh/pulse-api/blob/main/docs/configuration.md), the service that the console will call, and the Compose variables of the stack.
- [pulse architecture](https://github.com/lorenzh/pulse-meta/blob/main/docs/architecture.md).
