// Served at /console.css. It is the only CSS of the console: no <style> element, no style
// attribute, no @import and no data: URI. Color tokens are set on :root only, once for light and
// once in the dark @media block. Every :visited rule is listed in the spec's link table and
// carries the same color as its unvisited form; none sits inside an @media block.
// No fixed width over 360 px outside the desktop grid, so every page fits a 390 px viewport.
export const CONSOLE_CSS = `[hidden] { display: none !important; }
@font-face { font-family: "Space Grotesk"; font-style: normal; font-weight: 400; font-display: swap; src: url("/fonts/space-grotesk-latin-400-normal.woff2") format("woff2"); }
@font-face { font-family: "Space Grotesk"; font-style: normal; font-weight: 500; font-display: swap; src: url("/fonts/space-grotesk-latin-500-normal.woff2") format("woff2"); }
@font-face { font-family: "Space Grotesk"; font-style: normal; font-weight: 600; font-display: swap; src: url("/fonts/space-grotesk-latin-600-normal.woff2") format("woff2"); }
@font-face { font-family: "Space Grotesk"; font-style: normal; font-weight: 700; font-display: swap; src: url("/fonts/space-grotesk-latin-700-normal.woff2") format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-style: normal; font-weight: 400; font-display: swap; src: url("/fonts/jetbrains-mono-latin-400-normal.woff2") format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-style: normal; font-weight: 500; font-display: swap; src: url("/fonts/jetbrains-mono-latin-500-normal.woff2") format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-style: normal; font-weight: 600; font-display: swap; src: url("/fonts/jetbrains-mono-latin-600-normal.woff2") format("woff2"); }
:root {
  color-scheme: light dark;
  --bg: #f2eeec; --surface: #e6dfdc; --rule: #dfd7d4; --line-strong: #c4b8b3; --field-line: #93847e; --field: #faf8f7;
  --text: #271b32; --lead: #4a3f52; --muted: #6a5850; --strong: #271b32; --on-strong: #f2eeec;
  --accent: #8a4f9f; --accent-text: #7a4290; --accent2: #56619a; --tint: #e6dbe3; --tint-line: #d6c4d6;
  --error: #a4262c; --error-tint: #f5dddd; --warning: #8a5300; --warning-tint: #f4e5c8;
  --success: #2d6a44; --success-tint: #dcebe0; --info: #3d5a94; --info-tint: #dde4f1;
  --code: #271b32; --code-text: #dfd7d4;
  --font-sans: "Space Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 20px; --space-6: 24px; --space-7: 32px;
  --space-page-1: 40px; --space-page-2: 56px;
  --touch: 44px;
  --radius-field: 6px; --radius-panel: 12px; --radius-dialog: 16px; --radius-pill: 999px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #271b32; --surface: #33263f; --rule: #3e3049; --line-strong: #5a4b66; --field-line: #766877; --field: #1f1529;
    --text: #dfd7d4; --lead: #c9bfc4; --muted: #a89b95; --strong: #dfd7d4; --on-strong: #271b32;
    --accent: #c29bd3; --accent-text: #c29bd3; --accent2: #9da7d4; --tint: #3d2d48; --tint-line: #54406a;
    --error: #f2a7ab; --error-tint: #40232a; --warning: #f0c46b; --warning-tint: #3d3020;
    --success: #9fd4ae; --success-tint: #233a2c; --info: #a9bde6; --info-tint: #262e47;
    --code: #1b1224; --code-text: #dfd7d4;
  }
}
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-family: var(--font-sans); font-size: 1rem; font-weight: 400; line-height: 1.5; color: var(--text); background: var(--bg); }
body, p, h1, h2, h3, li, label, a, dd, td, legend { overflow-wrap: anywhere; }
h1 { font-size: 1.75rem; font-weight: 700; line-height: 1.2; letter-spacing: -0.01em; margin: 0; }
h2 { font-size: 1.125rem; font-weight: 500; line-height: 1.3; margin: 0; }
p { margin: 0; }
strong, b { font-weight: 700; }
small { font-size: 0.8125rem; }
.eyebrow, th { font-family: var(--font-mono); font-size: 0.75rem; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.mono, code, kbd, samp, .secret, .link-output { font-family: var(--font-mono); font-weight: 400; font-variant-numeric: tabular-nums; }
code, .secret { overflow-wrap: anywhere; word-break: break-all; }
pre { font-family: var(--font-mono); background: var(--code); color: var(--code-text); border-radius: var(--radius-field); padding: 12px 14px; margin: 0; max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; }
a, a:visited { color: var(--accent-text); }
a:hover { text-decoration-thickness: 2px; }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
button, a.button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: var(--touch); padding: 0 20px; border-radius: var(--radius-pill); border: 1px solid var(--strong); background: var(--strong); color: var(--on-strong); font: inherit; font-size: 15px; font-weight: 500; line-height: 1.2; text-align: center; text-decoration: none; cursor: pointer; }
a.button, a.button:visited { color: var(--on-strong); }
button:hover, a.button:hover { background: color-mix(in srgb, var(--strong) 85%, var(--bg)); border-color: color-mix(in srgb, var(--strong) 85%, var(--bg)); }
button.secondary, a.button.secondary { background: transparent; border-color: var(--line-strong); color: var(--text); }
a.button.secondary, a.button.secondary:visited { color: var(--text); }
button.secondary:hover, a.button.secondary:hover { background: transparent; border-color: var(--text); }
button.ghost, a.button.ghost { background: transparent; border-color: transparent; color: var(--text); }
a.button.ghost, a.button.ghost:visited { color: var(--text); }
button.ghost:hover, a.button.ghost:hover { background: var(--surface); border-color: transparent; }
button.danger, a.button.danger { background: var(--error); border-color: var(--error); color: var(--bg); }
a.button.danger, a.button.danger:visited { color: var(--bg); }
button.danger:hover, a.button.danger:hover { background: color-mix(in srgb, var(--error) 85%, var(--text)); border-color: color-mix(in srgb, var(--error) 85%, var(--text)); }
button.small, a.button.small { position: relative; min-height: 36px; padding: 0 14px; font-size: 0.8125rem; }
button.small::after, a.button.small::after { content: ""; position: absolute; inset: -4px 0; }
button:disabled, [aria-busy="true"] { opacity: 0.45; cursor: default; }
form { display: flex; flex-direction: column; gap: 16px; }
label { display: grid; gap: 8px; font-size: 0.875rem; font-weight: 500; }
legend { font-size: 0.875rem; font-weight: 500; padding: 0; margin: 0 0 8px; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; display: flex; flex-direction: column; gap: 0; }
input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]), select, textarea { width: 100%; min-height: var(--touch); padding: 0 14px; background: var(--field); border: 1px solid var(--field-line); border-radius: var(--radius-field); color: var(--text); font: inherit; font-size: 1rem; font-weight: 400; }
textarea { padding: 12px 14px; line-height: 1.6; }
input:not([type="radio"]):not([type="checkbox"]):focus-visible, select:focus-visible, textarea:focus-visible { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
[aria-invalid="true"] { border-color: var(--error) !important; box-shadow: 0 0 0 3px color-mix(in srgb, var(--error) 20%, transparent); }
select { appearance: none; padding-right: 36px; background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%); background-position: calc(100% - 20px) 50%, calc(100% - 15px) 50%; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; }
input[type="radio"], input[type="checkbox"] { width: 18px; height: 18px; margin: 0; flex: none; accent-color: var(--accent); }
label.choice { display: inline-flex; align-items: center; gap: 12px; min-height: var(--touch); width: auto; align-self: flex-start; font-size: 1rem; font-weight: 400; }
label.choice.option-card { display: flex; align-self: stretch; padding: 14px 16px; border: 1px solid var(--line-strong); border-radius: var(--radius-panel); }
label.choice.option-card:has(input:checked) { border-color: var(--accent); background: var(--tint); }
.hint { display: block; font-size: 0.875rem; font-weight: 400; color: var(--muted); }
.error { color: var(--error); font-size: 0.8125rem; font-weight: 400; margin: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.skip-link { position: absolute; left: 8px; top: -60px; z-index: 10; padding: 8px 12px; background: var(--bg); color: var(--text); border-radius: var(--radius-field); }
.skip-link:focus { top: 8px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.wordmark { display: flex; align-items: center; gap: 6px; margin: 0; font-family: var(--font-mono); font-size: 19px; font-weight: 600; color: var(--text); }
.wordmark .cursor { display: inline-block; width: 0.55em; height: 1em; background: var(--accent); }
.wordmark .pill { margin-left: 6px; padding: 1px 8px; border: 1px solid var(--line-strong); border-radius: var(--radius-pill); font-family: var(--font-mono); font-size: 11px; font-weight: 400; color: var(--muted); }
.shell { display: grid; grid-template-columns: 236px minmax(0, 1fr); min-height: 100vh; }
.sidebar { position: sticky; top: 0; height: 100vh; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; padding: 14px 12px; border-right: 1px solid var(--rule); min-width: 0; }
.sidebar .instance { font-size: 0.8125rem; color: var(--muted); padding: 0 12px; }
.sidebar nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.nav-group { padding: 16px 12px 6px; margin: 0; }
.nav-item, .nav-item:visited { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 12px; border-radius: var(--radius-field); color: var(--lead); font-weight: 500; text-decoration: none; white-space: nowrap; }
.nav-item:hover { background: var(--surface); }
.nav-item[aria-current="page"], .nav-item[aria-current="page"]:visited { background: var(--tint); color: var(--text); }
.icon { flex: none; }
.sidebar-foot { margin-top: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 12px; border-top: 1px solid var(--rule); min-width: 0; font-size: 0.8125rem; }
.avatar { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 32px; height: 32px; border-radius: 50%; background: var(--surface); font-family: var(--font-mono); font-size: 0.75rem; font-weight: 500; }
.account { flex: 1 0 auto; max-width: 100%; min-width: 0; color: var(--lead); }
.account-email { display: inline-block; max-width: 100%; overflow-wrap: anywhere; }
.sidebar-foot form { display: block; }
.shell-column { display: flex; flex-direction: column; min-width: 0; }
.topbar { display: flex; align-items: center; min-height: 64px; padding: 10px 32px; border-bottom: 1px solid var(--rule); min-width: 0; }
.breadcrumbs ol { display: flex; flex-wrap: wrap; list-style: none; margin: 0; padding: 0; font-family: var(--font-mono); font-size: 0.8125rem; color: var(--muted); }
.breadcrumbs li { min-width: 0; }
.breadcrumbs li + li::before { content: "/"; padding: 0 8px; }
.breadcrumbs a, .breadcrumbs a:visited { color: var(--muted); }
.banner { display: flex; flex-direction: column; gap: 12px; max-width: 1280px; padding: 20px 32px 0; }
main { display: block; }
main.shell-main { display: flex; flex-direction: column; gap: 24px; width: 100%; max-width: 1280px; padding: 28px 32px 56px; min-width: 0; }
main.shell-main > * { min-width: 0; }
.page-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 12px; }
.page-sub { font-size: 0.875rem; color: var(--lead); }
.page-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.plain-head { padding: 20px 24px; }
.plain-main { display: block; padding: 24px 16px 56px; }
.panel { background: var(--bg); border: 1px solid var(--line-strong); border-radius: var(--radius-panel); min-width: 0; }
.panel-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; min-height: 52px; padding: 8px 20px; border-bottom: 1px solid var(--rule); }
.panel-body { padding: 20px; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.panel-foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 12px 20px; background: var(--surface); border-top: 1px solid var(--rule); border-radius: 0 0 var(--radius-panel) var(--radius-panel); }
.plain-panel { display: flex; flex-direction: column; gap: 20px; width: 100%; max-width: 440px; margin: 0 auto; padding: 32px; }
.plain-panel > * { min-width: 0; }
.plain-panel form > .actions button:not(.secondary) { width: 100%; }
.plain-foot { font-size: 0.8125rem; color: var(--muted); }
.callout { display: flex; gap: 12px; padding: 14px 16px; border-radius: var(--radius-field); border: 1px solid var(--line-strong); color: var(--text); font-size: 0.875rem; min-width: 0; }
.callout > .icon { margin-top: 2px; }
.callout-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.callout-body ul { margin: 0; padding-left: 20px; }
.callout-title { font-size: 15px; font-weight: 500; }
.callout a:not(.button), .callout a:not(.button):visited { color: var(--text); text-decoration: underline; }
.callout-info { background: var(--info-tint); border-color: var(--line-strong); }
.callout-info > .icon { color: var(--info); }
.callout-success { background: var(--success-tint); border-color: var(--success); }
.callout-success > .icon { color: var(--success); }
.callout-warning { background: var(--warning-tint); border-color: var(--warning); }
.callout-warning > .icon { color: var(--warning); }
.callout-error { background: var(--error-tint); border-color: var(--error); }
.callout-error > .icon { color: var(--error); }
.callout-neutral { background: var(--tint); border-color: var(--tint-line); }
.callout-neutral > .icon { color: var(--lead); }
.empty-state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 40px 24px; text-align: center; background: transparent; border: 1px dashed var(--line-strong); border-radius: var(--radius-panel); }
.empty-state h2 { font-size: 1.125rem; }
.empty-state p { max-width: 300px; color: var(--lead); }
.empty-state form { align-items: center; }
.check-state { display: inline-flex; align-items: center; gap: 8px; }
.check-state .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
.check-state-up .dot { background: var(--success); }
.check-state-degraded .dot { background: var(--warning); }
.check-state-down .dot { background: var(--error); }
.check-state-down { color: var(--error); }
.check-state-maintenance .dot { width: 10px; height: 10px; border: 1.5px solid var(--accent2); background: transparent; }
.check-state-unknown .dot, .check-state-shadowed .dot { border: 1px solid var(--field-line); background: transparent; }
.check-state.dense { font-family: var(--font-mono); font-size: 0.75rem; color: var(--muted); }
.check-state.dense.check-state-down { color: var(--error); }
.tag { display: inline-flex; align-items: center; height: 24px; padding: 0 9px; border: 1px solid currentColor; border-radius: var(--radius-pill); background: transparent; font-family: var(--font-mono); font-size: 0.75rem; font-weight: 500; white-space: nowrap; }
.tag-neutral { color: var(--muted); }
.tag-info { color: var(--accent2); background: var(--bg); }
.tag-error { color: var(--error); }
table { width: 100%; border-collapse: collapse; }
th { background: var(--surface); padding: 10px 16px; text-align: left; border-bottom: 1px solid var(--line-strong); }
td { padding: 9px 16px; border-bottom: 1px solid var(--rule); vertical-align: middle; }
tr { height: 52px; }
thead tr { height: auto; }
td.num, th.num { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
tbody tr:hover { background: color-mix(in srgb, var(--surface) 45%, transparent); }
.table-wrap { max-width: 100%; overflow-x: auto; }
.table-scroll { max-width: 100%; overflow-x: auto; border: 1px solid var(--line-strong); border-radius: var(--radius-panel); background: linear-gradient(to right, var(--bg) 30%, transparent), linear-gradient(to left, var(--bg) 30%, transparent) 100% 0, radial-gradient(farthest-side at 0 50%, rgb(0 0 0 / 0.18), transparent), radial-gradient(farthest-side at 100% 50%, rgb(0 0 0 / 0.18), transparent) 100% 0; background-repeat: no-repeat; background-size: 40px 100%, 40px 100%, 14px 100%, 14px 100%; background-attachment: local, local, scroll, scroll; }
.table-scroll table tbody tr:last-child td { border-bottom: 0; }
.table-scroll table.checks { min-width: 56rem; }
.table-scroll table.tokens { min-width: 60rem; }
.table-scroll table.checks td { overflow-wrap: normal; word-break: normal; }
.table-scroll-hint { display: none; font-size: 0.875rem; font-weight: 500; color: var(--lead); }
.filters { display: flex; flex-flow: row wrap; gap: 8px 16px; align-items: flex-end; }
.filters label { display: flex; flex-direction: column; }
dl.settings, .settings { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 8px 16px; margin: 0; }
.settings dt { font-family: var(--font-mono); font-size: 0.8125rem; color: var(--muted); }
.settings dd { margin: 0; overflow-wrap: anywhere; }
.grid-2, .grid-4, .form-grid { display: grid; gap: 16px; }
.grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid-2 > *, .grid-4 > *, .form-grid > * { min-width: 0; }
.confirm-title { font-weight: 600; }
.confirm-target { font-family: var(--font-mono); overflow-wrap: anywhere; }
.confirm-danger { border-color: var(--error); }
.confirm input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"])[name="confirm_name"] { font-family: var(--font-mono); }
.quorum-rule, .invite-form { max-width: 40rem; }
#recovery-codes { padding-left: 24px; font-family: var(--font-mono); }
@media (max-width: 1180px) {
  .grid-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 900px) {
  dl.settings, .settings { grid-template-columns: minmax(0, 1fr); }
  .grid-2, .grid-4, .form-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 719px) {
  .shell { grid-template-columns: minmax(0, 1fr); }
  .sidebar { position: static; height: auto; overflow-y: visible; width: 100%; gap: 8px; border-right: 0; border-bottom: 1px solid var(--rule); }
  .sidebar nav { display: flex; flex-wrap: nowrap; overflow-x: auto; padding: 6px; scroll-padding-inline: 6px; scroll-snap-type: x mandatory; gap: 0; background: linear-gradient(to right, var(--bg) 30%, transparent), linear-gradient(to left, var(--bg) 30%, transparent) 100% 0, radial-gradient(farthest-side at 0 50%, rgb(0 0 0 / 0.18), transparent), radial-gradient(farthest-side at 100% 50%, rgb(0 0 0 / 0.18), transparent) 100% 0; background-repeat: no-repeat; background-size: 40px 100%, 40px 100%, 14px 100%, 14px 100%; background-attachment: local, local, scroll, scroll; }
  .sidebar nav ul { flex-direction: row; flex-wrap: nowrap; flex: none; gap: 0; }
  .sidebar nav .nav-item { display: inline-flex; flex-direction: row; align-items: center; gap: 8px; white-space: nowrap; flex: 0 0 auto; padding: 0 8px; }
  .sidebar nav .nav-item:focus { scroll-snap-align: center; }
  .nav-group { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .sidebar-foot { margin-top: 0; }
  .topbar { padding: 10px 16px; min-height: 48px; }
  .banner { padding: 16px 16px 0; }
  main.shell-main { padding: 20px 16px 40px; }
  .plain-panel { padding: 20px; }
  .table-scroll-hint { display: block; }
}
`;
