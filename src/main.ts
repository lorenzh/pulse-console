import { chmodSync, closeSync, openSync, readFileSync } from "node:fs";
import { createLogger, readLogLevel, runService, StartupError } from "@lorenzh/pulse-kit";
import { createAccountStore, SESSION_IDLE_MS } from "./account-store.ts";
import { openDatabase } from "./database.ts";
import { createFactorStore } from "./factor-store.ts";
import { createMetrics } from "./metrics.ts";
import { createCredentialVerifier, PASSWORD_HASH_OPTIONS } from "./passwords.ts";
import { createConsoleServer, listen } from "./server.ts";
import { readSettings } from "./settings.ts";
import { createSetupGate } from "./setup-code.ts";

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

const randomBytes = (size: number): Uint8Array => crypto.getRandomValues(new Uint8Array(size));

// Settings and the database are read inside `start`, so the signal handlers exist first and a
// StartupError exits 2. The database opens before the setup code is printed.
async function start(): Promise<void> {
  const settings = readSettings(process.env, (path) => readFileSync(path, "utf8"));
  const db = openDatabase(settings.dbPath, {
    createFile: (path, mode) => closeSync(openSync(path, "wx", mode)),
    chmod: chmodSync,
  });
  const store = createAccountStore(db);
  const instance = store.instance();
  store.deleteExpiredSessions(Date.now(), SESSION_IDLE_MS);
  if (instance !== undefined && instance.apiUrl !== settings.apiUrl) {
    log.warn("PULSE_API_URL differs from the API URL saved at setup; the saved URL is used");
  }
  if (settings.secretKey === undefined) {
    log.warn(
      "PULSE_CONSOLE_SECRET_KEY_FILE is not set: authenticator enrolment and TOTP sign-in are unavailable",
    );
  }
  if (settings.mode === "strict-http") {
    log.warn("PULSE_CONSOLE_PUBLIC_URL uses http: session cookies are not marked Secure");
  }
  let gate: ReturnType<typeof createSetupGate>["gate"] | undefined;
  if (instance === undefined) {
    const setup = createSetupGate({ now: Date.now, randomBytes });
    gate = setup.gate;
    // Written outside the logger, so PULSE_LOG_LEVEL never hides it.
    process.stdout.write(
      `pulse-console setup code: ${setup.code} (open /setup; a restart prints a new code)\n`,
    );
  }
  const hashPassword = (password: string): Promise<string> =>
    Bun.password.hash(password, PASSWORD_HASH_OPTIONS);
  const verifier = await createCredentialVerifier({
    hash: hashPassword,
    verify: (password, hash) => Bun.password.verify(password, hash),
    dummySecret: Buffer.from(randomBytes(32)).toString("base64url"),
  });
  const metrics = createMetrics();
  const server = createConsoleServer({
    metrics,
    log,
    instanceName: "pulse Console",
    mode: settings.mode,
    publicOrigin: settings.publicOrigin,
    defaultApiUrl: settings.apiUrl,
    adminToken: settings.adminToken,
    store,
    factorStore: createFactorStore(db),
    secretKey: settings.secretKey,
    gate,
    now: Date.now,
    randomBytes,
    hashPassword,
    verifier,
    fetch,
  });
  const port = await listen(server, settings.host, settings.port);
  server.on("error", (err) => {
    log.error("server error", { error: err.message });
    process.exit(EXIT_RUNTIME);
  });
  stopRunning = () =>
    new Promise<void>((resolve) => {
      metrics.setShuttingDown();
      server.close(() => {
        db.close();
        resolve();
      });
      server.closeIdleConnections();
    });
  log.info("pulse-console listening", {
    host: settings.host,
    port,
    apiUrl: new URL(instance?.apiUrl ?? settings.apiUrl).origin,
    hasAdminToken: settings.adminToken !== undefined,
    hasSecretKey: settings.secretKey !== undefined,
    mode: settings.mode,
    isSetUp: instance !== undefined,
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
