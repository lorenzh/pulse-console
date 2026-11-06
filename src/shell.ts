import { escapeHtml } from "@lorenzh/pulse-kit";
import { csrfField, documentHead, formTokenField, submitButton, wordmark } from "./html.ts";
import { navIcon } from "./icons.ts";
import {
  NAVIGATION,
  type NavEntry,
  type NavId,
  navigationGroups,
  visibleNavigation,
} from "./navigation.ts";
import { type ConsoleRole, roleLabel } from "./roles.ts";

export type ShellView = {
  instanceName: string;
  user: { name: string; email: string };
  role: ConsoleRole;
  /** The session CSRF token. */
  csrf: string;
  /** The form token of the sign-out form. */
  signOutToken: string;
  current: NavId | undefined;
  /** HTML from a state renderer, shown above `main`. */
  banner?: string | undefined;
  title: string;
  /** The page body HTML, inside `main` after the `h1`. */
  body: string;
  registry?: readonly NavEntry[] | undefined;
};

function navList(entries: readonly NavEntry[], current: NavId | undefined, labelled = ""): string {
  const items = entries
    .map((e) => {
      const isCurrent = e.id === current ? ' aria-current="page"' : "";
      return `<li><a class="nav-item" href="${escapeHtml(e.path)}"${isCurrent}>${navIcon(e.id)}<span>${escapeHtml(e.label)}</span></a></li>`;
    })
    .join("\n");
  return `<ul${labelled}>\n${items}\n</ul>`;
}

function navigationHtml(view: ShellView): string {
  const groups = navigationGroups(visibleNavigation(view.role, view.registry));
  const instance =
    groups.instance.length === 0
      ? ""
      : `\n<p class="eyebrow nav-group" id="nav-instance">Instance</p>\n${navList(groups.instance, view.current, ' aria-labelledby="nav-instance"')}`;
  return `<div class="nav-strip">
<nav aria-label="Main">
${navList(groups.main, view.current)}${instance}
</nav>
<span class="nav-edge nav-edge-start" aria-hidden="true"></span>
<span class="nav-edge nav-edge-end" aria-hidden="true"></span>
</div>`;
}

function firstCodePoint(text: string): string {
  const first = text.codePointAt(0);
  return first === undefined ? "" : String.fromCodePoint(first);
}

/** The avatar initials: first and last word of the name, else the email, else "?". */
function initials(user: { name: string; email: string }): string {
  const words = user.name
    .trim()
    .split(/\s+/u)
    .filter((w) => w !== "");
  const first = words[0];
  const last = words[words.length - 1];
  if (first === undefined || last === undefined) {
    return firstCodePoint(user.email).toLocaleUpperCase("en") || "?";
  }
  const letters =
    words.length === 1 ? firstCodePoint(first) : firstCodePoint(first) + firstCodePoint(last);
  return letters.toLocaleUpperCase("en");
}

function breadcrumbsHtml(view: ShellView): string {
  const registry = view.registry ?? NAVIGATION;
  const entry = registry.find((e) => e.id === view.current);
  const parent =
    entry === undefined || entry.label === view.title
      ? ""
      : `<li><a href="${escapeHtml(entry.path)}">${escapeHtml(entry.label)}</a></li>`;
  return `<nav aria-label="Breadcrumb" class="breadcrumbs"><ol>${parent}<li aria-current="page">${escapeHtml(view.title)}</li></ol></nav>`;
}

/** A signed-in page: skip link, sidebar with navigation and account, top bar, banner and main. */
export function shellPage(view: ShellView): string {
  const banner = view.banner === undefined ? "" : `<div class="banner">\n${view.banner}</div>\n`;
  return `<!doctype html>
<html lang="en">
${documentHead({ title: view.title, instanceName: view.instanceName, hasScript: true })}
  <body>
<a class="skip-link" href="#main">Skip to content</a>
<div class="shell">
<header class="sidebar">
<div class="sidebar-inner">
${wordmark()}
<p class="instance">${escapeHtml(view.instanceName)}</p>
${navigationHtml(view)}
<div class="sidebar-foot">
<span class="avatar" aria-hidden="true">${escapeHtml(initials(view.user))}</span>
<p class="account"><span class="account-who"><span class="account-prefix">Signed in as </span>${escapeHtml(view.user.name)} <span class="account-email">(${escapeHtml(view.user.email)})</span></span> <span class="account-role">Role: ${roleLabel(view.role)}</span></p>
<a href="/account/security">Account security</a>
<form method="post" action="/sign-out" class="sign-out">
${csrfField(view.csrf)}
${formTokenField(view.signOutToken)}
${submitButton({ label: "Sign out", busyLabel: "Signing out…", variant: "secondary", size: "small" })}
</form>
</div>
</div>
</header>
<div class="shell-column">
<div class="topbar">${breadcrumbsHtml(view)}</div>
${banner}<main id="main" class="shell-main">
<div class="page-head"><h1>${escapeHtml(view.title)}</h1></div>
${view.body}
</main>
</div>
</div>
  </body>
</html>
`;
}
