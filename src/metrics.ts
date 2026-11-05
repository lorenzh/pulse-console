import { createRegistry } from "@lorenzh/pulse-kit";

/** The `path` label values; every other request path counts as "other". */
export type PathLabel =
  | "/"
  | "/healthz"
  | "/readyz"
  | "/metrics"
  | "/setup"
  | "/setup/owner"
  | "/sign-in"
  | "/sign-out"
  | "/console.css"
  | "/sign-in/factor"
  | "/account/authenticator"
  | "/account/security"
  | "/account/recovery-codes"
  | "/account/sessions"
  | "/account/sessions/sign-out-all"
  | "/account/password"
  | "/console.js"
  | "/team"
  | "/team/invites"
  | "/team/invites/revoke"
  | "/team/role"
  | "/team/remove"
  | "/team/reset-2fa"
  | "/team/reset-link"
  | "/team/transfer"
  | "/team/require-2fa"
  | "/invite/:token"
  | "/reset/:token"
  | "other";

export type AuthKind =
  | "sign-in"
  | "setup-code"
  | "totp"
  | "recovery-code"
  | "enrolment"
  | "password-confirm";
export type AuthResult = "success" | "failure" | "throttled";

export interface Metrics {
  recordRequest: (path: PathLabel, code: number) => void;
  recordAuthAttempt: (kind: AuthKind, result: AuthResult) => void;
  setShuttingDown: () => void;
  isReady: () => boolean;
  render: () => string;
}

/** Counters and readiness state in memory; they reset on restart. */
export function createMetrics(): Metrics {
  const registry = createRegistry();
  const upGauge = registry.gauge("pulse_up", "1 when the service is ready, else 0.");
  const httpCounter = registry.counter(
    "pulse_console_http_requests_total",
    "HTTP responses by request path and status code.",
  );
  const authCounter = registry.counter(
    "pulse_console_auth_attempts_total",
    "Sign-in, setup-code and second-factor attempts by kind and result.",
  );
  let isShuttingDown = false;

  registry.collect(() => {
    upGauge.set(isShuttingDown ? 0 : 1);
  });

  return {
    recordRequest: (path, code) => httpCounter.inc({ path, code: String(code) }),
    recordAuthAttempt: (kind, result) => authCounter.inc({ kind, result }),
    setShuttingDown: () => {
      isShuttingDown = true;
    },
    isReady: () => !isShuttingDown,
    render: () => registry.render(),
  };
}
