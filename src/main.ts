import { readFileSync } from "node:fs";
import { createLogger, readLogLevel, runService, StartupError } from "@lorenzh/pulse-kit";
import { createMetrics } from "./metrics.ts";
import { createConsoleServer, listen } from "./server.ts";
import { readSettings } from "./settings.ts";

const SHUTDOWN_TIMEOUT_MS = 5000;
const EXIT_STARTUP = 2;
const EXIT_RUNTIME = 1;

let level: ReturnType<typeof readLogLevel>;
try {
  level = readLogLevel(process.env);
} catch (err) {
  const message = err instanceof StartupError ? err.message : String(err);
  console.error(`pulse-console: ${message}`);
  process.exit(EXIT_STARTUP);
}
const log = createLogger({ level });

let stopRunning: (() => Promise<void>) | undefined;

// Settings are read inside `start`, so the signal handlers exist first and a StartupError exits 2.
async function start(): Promise<void> {
  const settings = readSettings(process.env, (path) => readFileSync(path, "utf8"));
  const metrics = createMetrics();
  const server = createConsoleServer(metrics);
  const port = await listen(server, settings.host, settings.port);
  server.on("error", (err) => {
    log.error("server error", { error: err.message });
    process.exit(EXIT_RUNTIME);
  });
  stopRunning = () =>
    new Promise<void>((resolve) => {
      metrics.setShuttingDown();
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  log.info("pulse-console listening", {
    host: settings.host,
    port,
    apiUrl: new URL(settings.apiUrl).origin,
    hasAdminToken: settings.adminToken !== undefined,
  });
}

await runService({
  service: "console",
  start,
  stop: async () => {
    await stopRunning?.();
  },
  timeoutMs: SHUTDOWN_TIMEOUT_MS,
  log,
});
