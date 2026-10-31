import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { handleOps, type OpsHandlers, StartupError } from "@lorenzh/pulse-kit";
import type { Metrics, PathLabel } from "./metrics.ts";
import { PAGE_HTML } from "./page.ts";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};
const NOT_FOUND = "not found\n";
const ERROR_CODE = /^E[A-Z0-9_]+$/;

/**
 * The raw path before the first "?", not decoded and not normalised, as kit's handleOps reads
 * it. A parsed URL would turn "//healthz" or "/%2e%2e/" into "/".
 */
function rawPath(req: IncomingMessage): string {
  return (req.url ?? "/").split("?")[0] ?? "/";
}

function pathLabel(path: string): PathLabel {
  switch (path) {
    case "/":
    case "/healthz":
    case "/readyz":
    case "/metrics":
      return path;
    default:
      return "other";
  }
}

function sendPage(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(PAGE_HTML),
  });
  res.end(req.method === "HEAD" ? undefined : PAGE_HTML);
}

function sendNotFound(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(404, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(NOT_FOUND),
  });
  res.end(req.method === "HEAD" ? undefined : NOT_FOUND);
}

/** The console HTTP server: the page, the ops routes, 404 and 405. It reads no request body. */
export function createConsoleServer(metrics: Metrics): Server {
  const ops: OpsHandlers = {
    ready: () => (metrics.isReady() ? { ready: true } : { ready: false, reason: "shutting down" }),
    metrics: () => metrics.render(),
    allowHead: true,
  };
  return createServer((req, res) => {
    const path = rawPath(req);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    res.once("finish", () => metrics.recordRequest(pathLabel(path), res.statusCode));
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", "content-length": 0 }).end();
      return;
    }
    if (handleOps(req, res, ops)) return;
    if (path === "/") sendPage(req, res);
    else sendNotFound(req, res);
  });
}

function errorCode(err: unknown): string {
  const code: unknown = typeof err === "object" && err !== null ? Reflect.get(err, "code") : "";
  return typeof code === "string" && ERROR_CODE.test(code) ? code : "unknown";
}

/** Listens and resolves with the bound port. A bind failure names the code only. */
export function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      reject(
        new StartupError(
          `PULSE_CONSOLE_HOST/PULSE_CONSOLE_PORT: cannot listen on ${host}:${port} (${errorCode(err)})`,
          { setting: "PULSE_CONSOLE_PORT", cause: err },
        ),
      );
    });
    server.listen(port, host, () => {
      // Listening on a TCP host and port, so the address is never a string or null.
      resolve((server.address() as AddressInfo).port);
    });
  });
}
