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
  | "other";

export type AuthKind = "sign-in" | "setup-code";
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
    "Sign-in and setup-code attempts by kind and result.",
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
