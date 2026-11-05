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
