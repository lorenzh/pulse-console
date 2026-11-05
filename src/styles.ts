// Served at /console.css. No width over 360 px, so the forms fit a 390 px viewport.
export const CONSOLE_CSS = `*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; line-height: 1.5; color: #1b1f24; background: #f6f7f9; }
main { max-width: 32rem; margin: 0 auto; padding: 1.5rem 1rem; }
h1 { font-size: 1.5rem; margin: 0 0 1rem; }
form { display: grid; gap: 0.75rem; }
label { display: grid; gap: 0.25rem; font-weight: 600; }
input { width: 100%; font: inherit; padding: 0.5rem; border: 1px solid #8a929c; border-radius: 4px; background: #fff; }
button { font: inherit; padding: 0.5rem 1rem; border: 1px solid #1b4f9c; border-radius: 4px; background: #1b4f9c; color: #fff; cursor: pointer; }
button.secondary { background: #fff; color: #1b4f9c; }
input:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid #e3a008; outline-offset: 2px; }
.error { color: #a4161a; font-weight: 400; margin: 0; }
.notice { padding: 0.5rem; border-left: 4px solid #1b4f9c; background: #fff; }
.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
code, .secret { font-family: ui-monospace, monospace; overflow-wrap: anywhere; word-break: break-all; }
#recovery-codes { padding-left: 1.5rem; }
#sessions { width: 100%; border-collapse: collapse; }
#sessions th, #sessions td { text-align: left; padding: 0.25rem 0.5rem 0.25rem 0; vertical-align: top; }
`;
