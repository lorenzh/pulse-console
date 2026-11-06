// Literal pulse-api answers for the Checks pages: all six types, file and database sources, a
// shadowed duplicate and all five states.

export const REVISION = `sha256-${"b".repeat(64)}`;
export const QUOTE_URL = "https://a';id;'b/";
export const LAST_RESULT_AT = Date.UTC(2026, 10, 5, 11, 59, 30);
export const LAST_APPLIED_AT = Date.UTC(2026, 10, 4, 8, 0, 0);

const http = {
  id: "web",
  name: "Web shop",
  url: QUOTE_URL,
  method: "POST",
  intervalMs: 60000,
  source: "database",
  headers: { Authorization: { env: "PULSE_HEADER_TOKEN" }, "X-Api-Key": { keep: true } },
  body: { keep: true },
};
const tls = {
  id: "cert",
  name: "Certificate",
  type: "tls",
  host: "example.com",
  port: 443,
  warnDays: 14,
  intervalMs: 60000,
  source: "database",
};
const tcp = {
  id: "db-port",
  name: "Database port",
  type: "tcp",
  host: "db.internal",
  port: 5432,
  intervalMs: 60000,
  source: "file",
};
const dns = {
  id: "dns-a",
  name: "DNS record",
  type: "dns",
  dnsName: "example.com",
  recordType: "A",
  intervalMs: 60000,
  source: "file",
};
const domain = {
  id: "domain-exp",
  name: "Domain expiry",
  type: "domain",
  domain: "example.org",
  warnDays: 30,
  intervalMs: 3600000,
  source: "database",
};
const heartbeat = {
  id: "nightly-backup",
  name: "Nightly backup",
  type: "heartbeat",
  period: 86400000,
  grace: 3600000,
  source: "database",
  hasSecret: true,
};
/** The database definition that the file check `dns-a` shadows. */
const shadowedDns = { ...dns, name: "DNS record (old)", recordType: "AAAA", source: "database" };

/** `GET /admin/config` with every check view. */
export const checkConfig = {
  revision: REVISION,
  checks: [http, tls, tcp, dns, domain, heartbeat],
  shadowed: [shadowedDns],
  components: [],
  maintenance: [],
  file: { state: "ok", message: null, lastAppliedAt: LAST_APPLIED_AT },
};

function stateOf(id: string, state: string, lastResultAt: number | null) {
  return {
    id,
    name: id,
    url: "https://example.com",
    intervalMs: 60000,
    state,
    consecutiveDown: 0,
    lastResultAt,
    lastReason: null,
    locations: [],
    ...(state === "maintenance"
      ? { maintenance: { checkId: id, start: 0, end: 4102444800000, note: "Window" } }
      : {}),
  };
}

/** `GET /checks`: five states; `nightly-backup` is missing, so it shows `Unknown`. */
export const checkStates = [
  stateOf("web", "up", LAST_RESULT_AT),
  stateOf("cert", "degraded", LAST_RESULT_AT),
  stateOf("db-port", "down", LAST_RESULT_AT),
  stateOf("dns-a", "maintenance", LAST_RESULT_AT),
  stateOf("domain-exp", "unknown", null),
];

/** `GET /admin/config/export` of the fixture, written as the api writes it. */
export const checkExport = {
  checks: [
    {
      id: "web",
      name: "Web shop",
      url: QUOTE_URL,
      method: "POST",
      intervalMs: 60000,
      headers: { Authorization: { env: "PULSE_HEADER_TOKEN" } },
    },
    {
      id: "cert",
      name: "Certificate",
      type: "tls",
      host: "example.com",
      port: 443,
      warnDays: 14,
      intervalMs: 60000,
    },
    {
      id: "db-port",
      name: "Database port",
      type: "tcp",
      host: "db.internal",
      port: 5432,
      intervalMs: 60000,
    },
    {
      id: "dns-a",
      name: "DNS record",
      type: "dns",
      dnsName: "example.com",
      recordType: "A",
      intervalMs: 60000,
    },
    {
      id: "domain-exp",
      name: "Domain expiry",
      type: "domain",
      domain: "example.org",
      warnDays: 30,
      intervalMs: 3600000,
    },
    {
      id: "nightly-backup",
      name: "Nightly backup",
      type: "heartbeat",
      period: 86400000,
      grace: 3600000,
    },
  ],
  components: [],
  maintenance: [
    {
      checkId: "dns-a",
      start: "2026-11-06T00:00:00.000Z",
      end: "2026-11-06T02:00:00.000Z",
      note: "Resolver move",
    },
  ],
  redacted: [
    { checkId: "web", field: "headers.X-Api-Key" },
    { checkId: "web", field: "body" },
    { checkId: "nightly-backup", field: "secret" },
  ],
};

/** 90 UTC days ending 2026-11-05, oldest first. */
export const DAYS = Array.from({ length: 90 }, (_, i) =>
  new Date(Date.UTC(2026, 10, 5) - (89 - i) * 86400000).toISOString().slice(0, 10),
);

function result(location: string, timestamp: number, status = "up", checkId = "web") {
  return {
    checkId,
    timestamp,
    status,
    statusCode: status === "down" ? null : 200,
    latencyMs: 120,
    reason: status === "down" ? "connect timeout" : null,
    location,
    attempts: status === "down" ? 3 : 1,
  };
}

/** `/checks` entry of `web` with two current locations; `us` is stale; `ap` is in no uptime. */
export const webState = {
  ...stateOf("web", "up", LAST_RESULT_AT),
  consecutiveDown: 0,
  locations: [
    { location: "ap", result: result("ap", LAST_RESULT_AT), stale: false },
    { location: "eu", result: result("eu", LAST_RESULT_AT, "degraded"), stale: false },
    { location: "us", result: result("us", LAST_RESULT_AT - 7200000, "down"), stale: true },
  ],
  slo: { target: 99.9, windowDays: 30, availability: 99.95, budgetRemaining: -0.04 },
};

/** `/checks/web/location-uptime`: `eu` and `us` joined; `old` exists only here. */
export const webLocationUptime = {
  checkId: "web",
  windowDays: 90,
  locations: [
    { location: "eu", good: 4, results: 5, uptime: 80 },
    { location: "old", good: 0, results: 0, uptime: null },
    { location: "us", good: 999, results: 1000, uptime: 99.9 },
  ],
};

/** `/uptime` with a 90-day row for every effective fixture check. */
export const checkUptime = [
  "web",
  "cert",
  "db-port",
  "dns-a",
  "domain-exp",
  "nightly-backup",
  ".",
  "..",
].map((checkId) => ({
  checkId,
  uptime: 99.995,
  days: DAYS.map((date, i) => ({
    date,
    uptime: i === 0 ? null : 99.995,
    results: i === 0 ? 0 : 200,
  })),
}));

/** `/checks/web/latency`: 90 days, the oldest without results. */
export const webLatency = {
  checkId: "web",
  days: DAYS.map((date, i) =>
    i === 0
      ? { date, p50Ms: null, p95Ms: null, count: 0 }
      : { date, p50Ms: 100 + i, p95Ms: 300 + i, count: 10 },
  ),
};

/** 21 results: the 20th and 21st share a timestamp, as the api returns a complete group. */
export const webResults = Array.from({ length: 21 }, (_, i) =>
  result(i === 20 ? "us" : "eu", LAST_RESULT_AT - Math.min(i, 19) * 60000),
);

/** One view per type with every optional field set, for the settings labels. */
export const labelViews = [
  {
    id: "full-http",
    name: "Full HTTP",
    url: "https://example.com/health",
    method: "POST",
    intervalMs: 60000,
    timeoutMs: 5000,
    latencyObjectiveMs: 500,
    retries: 2,
    retryDelayMs: 1000,
    keyword: "ok",
    expectedStatus: ["200-299"],
    jsonAssert: [{ pointer: "/ok", exists: true }],
    availabilityTarget: 99.9,
    source: "database",
  },
  {
    id: "full-tls",
    name: "Full TLS",
    type: "tls",
    host: "example.com",
    port: 443,
    warnDays: 14,
    intervalMs: 60000,
    timeoutMs: 5000,
    availabilityTarget: 99.9,
    source: "database",
  },
  {
    id: "full-tcp",
    name: "Full TCP",
    type: "tcp",
    host: "db.internal",
    port: 5432,
    intervalMs: 60000,
    timeoutMs: 5000,
    retries: 1,
    retryDelayMs: 500,
    source: "database",
  },
  {
    id: "full-dns",
    name: "Full DNS",
    type: "dns",
    dnsName: "example.com",
    recordType: "A",
    expected: ["192.0.2.1"],
    resolver: "192.0.2.53",
    intervalMs: 60000,
    source: "database",
  },
  {
    id: "full-domain",
    name: "Full domain",
    type: "domain",
    domain: "example.org",
    warnDays: 30,
    intervalMs: 3600000,
    source: "database",
  },
  {
    id: "full-heartbeat",
    name: "Full heartbeat",
    type: "heartbeat",
    period: 86400000,
    grace: 3600000,
    source: "database",
    hasSecret: true,
  },
];
