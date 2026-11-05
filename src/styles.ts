// Served at /console.css. No fixed width over 360 px, so every page fits a 390 px viewport.
// Long values wrap (overflow-wrap) instead of being cut off.
export const CONSOLE_CSS = `*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; line-height: 1.5; color: #1b1f24; background: #f6f7f9; }
main { max-width: 32rem; margin: 0 auto; padding: 1.5rem 1rem; }
h1 { font-size: 1.5rem; margin: 0 0 1rem; }
form { display: grid; gap: 0.75rem; }
label { display: grid; gap: 0.25rem; font-weight: 600; }
input, textarea, select { width: 100%; font: inherit; padding: 0.5rem; border: 1px solid #8a929c; border-radius: 4px; background: #fff; }
button { font: inherit; padding: 0.5rem 1rem; border: 1px solid #1b4f9c; border-radius: 4px; background: #1b4f9c; color: #fff; cursor: pointer; }
button.secondary { background: #fff; color: #1b4f9c; }
input:focus-visible, textarea:focus-visible, select:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid #e3a008; outline-offset: 2px; }
.error { color: #a4161a; font-weight: 400; margin: 0; }
.notice { padding: 0.5rem; border-left: 4px solid #1b4f9c; background: #fff; }
.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
form + form { margin-top: 1rem; }
code, .secret { font-family: ui-monospace, monospace; overflow-wrap: anywhere; word-break: break-all; }
#recovery-codes { padding-left: 1.5rem; }
#sessions { width: 100%; border-collapse: collapse; }
#sessions th, #sessions td { text-align: left; padding: 0.25rem 0.5rem 0.25rem 0; vertical-align: top; }
.table-wrap table { width: 100%; border-collapse: collapse; }
.table-wrap th, .table-wrap td { text-align: left; padding: 0.25rem 0.5rem 0.25rem 0; vertical-align: top; overflow-wrap: anywhere; }
.table-scroll { overflow-x: auto; max-width: 100%; }
.table-scroll table.checks { min-width: 56rem; }
.table-scroll table.tokens { min-width: 60rem; }
.table-scroll table.checks td { overflow-wrap: normal; word-break: normal; }
.filters { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: flex-end; margin: 1rem 0; }
.filters label { display: flex; flex-direction: column; }
.settings { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
.settings dd { margin: 0; overflow-wrap: anywhere; }
.editor-row { margin: 0.75rem 0; }
.hint { display: block; font-size: 0.875rem; }
.quorum-rule { margin-top: 1.5rem; }
pre { overflow-x: auto; max-width: 100%; padding: 0.5rem; border: 1px solid currentColor; }
body, p, h1, h2, li, label, a { overflow-wrap: anywhere; }
.skip-link { position: absolute; left: 0.5rem; top: -3rem; padding: 0.5rem; background: #fff; }
.skip-link:focus { top: 0.5rem; }
.shell-header { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; padding: 0.75rem 1rem; background: #fff; border-bottom: 1px solid #d0d5db; }
.shell-header p { margin: 0; }
.instance { font-weight: 700; }
.account-email { display: inline-block; max-width: 100%; }
.account { flex: 1 0 auto; max-width: 100%; min-width: 0; }
.sign-out { display: block; }
a, a:visited { color: #1b4f9c; }
nav ul { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; list-style: none; margin: 0; padding: 0.5rem 1rem; background: #fff; border-bottom: 1px solid #d0d5db; }
nav a { color: #1b4f9c; }
nav a[aria-current="page"] { font-weight: 700; text-decoration-thickness: 3px; }
.banner { max-width: 64rem; margin: 1rem auto 0; padding: 0 1rem; }
main.shell-main { max-width: 64rem; }
.state { padding: 0.75rem 1rem; margin: 0 0 1rem; border-left: 4px solid #8a929c; background: #fff; }
.state h2 { font-size: 1.125rem; margin: 0 0 0.5rem; }
.state-error { border-left-color: #a4161a; }
.state-warning { border-left-color: #b45309; }
.error-summary { padding: 0.75rem 1rem; border: 2px solid #a4161a; background: #fff; }
.error-summary h2 { font-size: 1.125rem; margin: 0 0 0.5rem; }
.confirm-target { font-weight: 600; overflow-wrap: anywhere; }
.confirm .actions { align-items: center; }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.link-output { font-family: ui-monospace, monospace; }
.invite-form { margin-top: 1rem; max-width: 32rem; }
`;
