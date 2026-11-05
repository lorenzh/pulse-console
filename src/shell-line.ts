/**
 * The check lines that a person pastes into a POSIX shell, and `shellQuote`, which every shell
 * line of the console uses (also the probe snippets of `probe-snippet.ts`). Every value from data
 * goes through `shellQuote`; HTML escaping protects only the page, not the copied text.
 */

/** `value` as one single-quoted POSIX shell word; each `'` becomes `'\''`. Always quoted. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** One env header of a check and the host its value may be sent to. */
export type HostBinding = { variable: string; host: string };

/** `PULSE_PROBE_HEADER_HOSTS=<one quoted JSON word>`, the bindings in header order. */
export function hostBindingLine(bindings: readonly HostBinding[]): string {
  // fromEntries defines own keys, so a name like `__proto__` cannot run a setter.
  const object = Object.fromEntries(bindings.map(({ variable, host }) => [variable, [host]]));
  return `PULSE_PROBE_HEADER_HOSTS=${shellQuote(JSON.stringify(object))}`;
}

/** The curl line that sends one heartbeat ping to `url`. `<secret>` stays a placeholder. */
export function heartbeatLine(url: string): string {
  return `curl -fsS -X POST -H ${shellQuote("Authorization: Bearer <secret>")} ${shellQuote(url)}`;
}
