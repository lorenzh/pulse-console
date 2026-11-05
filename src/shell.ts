import { escapeHtml } from "@lorenzh/pulse-kit";
import { csrfField, documentHead, formTokenField, submitButton } from "./html.ts";
import { type NavEntry, type NavId, visibleNavigation } from "./navigation.ts";
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

function navigationHtml(view: ShellView): string {
  const items = visibleNavigation(view.role, view.registry)
    .map((e) => {
      const current = e.id === view.current ? ' aria-current="page"' : "";
      return `<li><a href="${escapeHtml(e.path)}"${current}>${escapeHtml(e.label)}</a></li>`;
    })
    .join("\n");
  return `<nav aria-label="Main">
<ul>
${items}
</ul>
</nav>`;
}

/** A signed-in page: skip link, header, navigation, banner slot and main. */
export function shellPage(view: ShellView): string {
  const banner = view.banner === undefined ? "" : `<div class="banner">\n${view.banner}</div>\n`;
  return `<!doctype html>
<html lang="en">
${documentHead({ title: view.title, instanceName: view.instanceName, hasScript: true })}
  <body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="shell-header">
<p class="instance">${escapeHtml(view.instanceName)}</p>
<p class="account">Signed in as ${escapeHtml(view.user.name)} (${escapeHtml(view.user.email)})<br>Role: ${roleLabel(view.role)}</p>
<a href="/account/security">Account security</a>
<div class="sign-out">
<form method="post" action="/sign-out">
${csrfField(view.csrf)}
${formTokenField(view.signOutToken)}
${submitButton({ label: "Sign out", busyLabel: "Signing out…", variant: "secondary" })}
</form>
</div>
</header>
${navigationHtml(view)}
${banner}<main id="main" class="shell-main">
<h1>${escapeHtml(view.title)}</h1>
${view.body}
</main>
  </body>
</html>
`;
}
