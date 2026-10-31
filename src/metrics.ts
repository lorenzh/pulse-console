import { createRegistry } from "@lorenzh/pulse-kit";

/** The `path` label values; every other request path counts as "other". */
export type PathLabel = "/" | "/healthz" | "/readyz" | "/metrics" | "other";

export interface Metrics {
  recordRequest: (path: PathLabel, code: number) => void;
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
  let isShuttingDown = false;

  registry.collect(() => {
    upGauge.set(isShuttingDown ? 0 : 1);
  });

  return {
    recordRequest: (path, code) => httpCounter.inc({ path, code: String(code) }),
    setShuttingDown: () => {
      isShuttingDown = true;
    },
    isReady: () => !isShuttingDown,
    render: () => registry.render(),
  };
}
