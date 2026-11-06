import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@lorenzh/pulse-kit";
import { startSignedInConsole } from "../test/signed-in-console.ts";
import { createAccountStore } from "./account-store.ts";
import { openDatabase } from "./database.ts";
import { createFactorStore } from "./factor-store.ts";
import { createMetrics, type Metrics } from "./metrics.ts";
import { createConsoleServer, listen } from "./server.ts";
import { createSetupGate } from "./setup-code.ts";
import { createTeamStore } from "./team-store.ts";

// Lengths and SHA-256 values from the @fontsource 5.3.0 npm tarballs (spec R15).
const FONTS: readonly (readonly [string, number, string])[] = [
  [
    "/fonts/space-grotesk-latin-400-normal.woff2",
    13388,
    "65fd17fcbd2e2f522940b5f67ead3d23329e02891aa5495e74d11a499c0b0673",
  ],
  [
    "/fonts/space-grotesk-latin-500-normal.woff2",
    13312,
    "1b1a8131d9edf975d9decee81e2f2bf504812f7a4f498e5500f28a613e22e64c",
  ],
  [
    "/fonts/space-grotesk-latin-600-normal.woff2",
    13284,
    "685bbbf69fa616df1ef81847c85fc76be097ddfb3468ff2257be54511ab3130f",
  ],
  [
    "/fonts/space-grotesk-latin-700-normal.woff2",
    12840,
    "35f8aec56cfd5cbfdb03cc68733a54a0b05bb3617ffcd5fd332badc0b045ca55",
  ],
  [
    "/fonts/jetbrains-mono-latin-400-normal.woff2",
    21168,
    "14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb",
  ],
  [
    "/fonts/jetbrains-mono-latin-500-normal.woff2",
    21832,
    "cb182feeed4d798ff6961d3c79f7026279448fca0676438aaecb21f3fc39553a",
  ],
  [
    "/fonts/jetbrains-mono-latin-600-normal.woff2",
    21860,
    "400c6bfda18d5d14acad1c15d6dcb9f8e13c015e7286317e0b9a482539bef147",
  ],
];
// eslint-disable-next-line sonarjs/no-clear-text-protocols -- an unreachable stored value; no request is made
const API_URL = "http://api.invalid:3000";
const FONT_CACHE = "public, max-age=31536000, immutable";
const TEST_SECRET_KEY = Uint8Array.from(Buffer.from("0123456789abcdef".repeat(4), "hex"));

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

type Running = { base: string; port: number; metrics: Metrics };

async function startBeforeSetup(): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), "console-fonts-"));
  const db = openDatabase(join(dir, "console.db"), {
    createFile: (path, mode) => closeSync(openSync(path, "wx", mode)),
    chmod: chmodSync,
  });
  const bytes = (size: number): Uint8Array => new Uint8Array(size).fill(7);
  const metrics = createMetrics();
  const server: Server = createConsoleServer({
    instanceName: "pulse Console",
    metrics,
    log: createLogger({ level: "error", write: () => undefined }),
    mode: "loopback",
    publicOrigin: undefined,
    defaultApiUrl: API_URL,
    adminToken: undefined,
    store: createAccountStore(db),
    factorStore: createFactorStore(db),
    teamStore: createTeamStore(db),
    secretKey: TEST_SECRET_KEY,
    gate: createSetupGate({ now: () => 0, randomBytes: bytes }).gate,
    now: () => 0,
    randomBytes: bytes,
    hashPassword: () => Promise.reject(new Error("not used")),
    verifier: { verify: () => Promise.reject(new Error("not used")) },
    fetch: () => Promise.reject(new Error("no network in this test")),
  });
  const port = await listen(server, "127.0.0.1", 0);
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
        server.closeAllConnections();
      }),
  );
  return { base: `http://127.0.0.1:${port}`, port, metrics };
}

async function startAfterSetup(): Promise<Running> {
  const c = await startSignedInConsole({ apiUrl: API_URL });
  closers.push(c.close);
  return { base: c.base, port: Number(new URL(c.base).port), metrics: c.metrics };
}

/** Sends one request line as written, without fetch's path normalisation. */
function rawRequest(port: number, head: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.on("connect", () => socket.write(`${head}\r\nConnection: close\r\n\r\n`));
    socket.on("data", (chunk) => {
      data += String(chunk);
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

function sha256(bytes: ArrayBuffer): string {
  return createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
}

const STARTS = [
  ["before setup", startBeforeSetup],
  ["after setup", startAfterSetup],
] as const;

describe.each(STARTS)("font routes %s", (_label, start) => {
  test("each of the seven routes serves the pinned bytes with a year of public cache", async () => {
    const { base } = await start();
    for (const [path, length, hash] of FONTS) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("font/woff2");
      expect(res.headers.get("cache-control")).toBe(FONT_CACHE);
      expect(res.headers.get("content-length")).toBe(String(length));
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const body = await res.arrayBuffer();
      expect(body.byteLength).toBe(length);
      expect(sha256(body)).toBe(hash);
    }
  });

  test("HEAD is empty with the same length, and a query keeps the bytes", async () => {
    const { base } = await start();
    const head = await fetch(`${base}/fonts/space-grotesk-latin-700-normal.woff2`, {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("12840");
    expect(head.headers.get("cache-control")).toBe(FONT_CACHE);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const queried = await fetch(`${base}/fonts/space-grotesk-latin-700-normal.woff2?v=2`);
    expect(queried.status).toBe(200);
    expect(sha256(await queried.arrayBuffer())).toBe(
      "35f8aec56cfd5cbfdb03cc68733a54a0b05bb3617ffcd5fd332badc0b045ca55",
    );
  });

  test("POST answers 405 with GET, HEAD", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/fonts/space-grotesk-latin-700-normal.woff2`, {
      method: "POST",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  test.each([
    ["/fonts/space-grotesk-latin-700-normal.woff2", "POST"],
    ["/fonts/jetbrains-mono-latin-400-normal.woff2", "DELETE"],
    ["/console.css", "POST"],
    ["/healthz", "POST"],
  ])("405 on %s %s keeps no-store", async (path, method) => {
    const { base } = await start();
    const res = await fetch(`${base}${path}`, { method });
    expect(res.status).toBe(405);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("another Host is refused with 421", async () => {
    const { port } = await start();
    const res = await rawRequest(
      port,
      "GET /fonts/space-grotesk-latin-700-normal.woff2 HTTP/1.1\r\nHost: evil.example:8082",
    );
    expect(res.startsWith("HTTP/1.1 421 ")).toBe(true);
  });

  test("other paths under /fonts are 404 under the other label", async () => {
    const { port, metrics } = await start();
    const paths = [
      "/fonts/",
      "/fonts/space-grotesk-latin-300-normal.woff2",
      "/fonts/Space-Grotesk-latin-400-normal.woff2",
      "/fonts/space-grotesk-latin-400-normal.woff2/",
      "//fonts/space-grotesk-latin-400-normal.woff2",
      "/fonts/%2e%2e/package.json",
      "/fonts/../src/server.ts",
      "/fonts/OFL-space-grotesk.txt",
      "/assets/fonts/space-grotesk-latin-400-normal.woff2",
    ];
    for (const path of paths) {
      const res = await rawRequest(port, `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}`);
      expect(`${path} ${res.slice(0, 12)}`).toBe(`${path} HTTP/1.1 404`);
      expect(res.toLowerCase()).toContain("cache-control: no-store");
    }
    const series = metrics
      .render()
      .split("\n")
      .filter((l) => l.startsWith("pulse_console_http_requests_total{"));
    expect(series).toEqual([`pulse_console_http_requests_total{path="other",code="404"} 9`]);
  });

  test("one font GET counts under /fonts/:file and other responses keep no-store", async () => {
    const { base, metrics } = await start();
    await fetch(`${base}/fonts/jetbrains-mono-latin-600-normal.woff2`);
    expect(metrics.render()).toContain(
      'pulse_console_http_requests_total{path="/fonts/:file",code="200"} 1',
    );
    for (const path of ["/console.css", "/console.js", "/sign-in"]) {
      expect((await fetch(`${base}${path}`)).headers.get("cache-control")).toBe("no-store");
    }
  });
});
