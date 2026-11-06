// A stateful fake of the pulse-api incident routes for the server tests and the browser checks.
// One Bun server on 127.0.0.1 port 0. It keeps public manual incidents in memory, validates
// write bodies with the pinned contract and records every request.
import {
  type Incident,
  type ManualIncident,
  validateManualIncidentInput,
  validateManualIncidentUpdateInput,
} from "@lorenzh/pulse-contract";
import { checkConfig, webResults } from "./check-fixtures.ts";
import { WIRE_HEADERS } from "./fake-api.ts";

/** The clock of the incident fixtures: 2026-11-06 12:00:00 UTC. */
export const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const HOUR = 3_600_000;

/** `/admin/config` with two components; `public-api` contains the check `.`. */
export const incidentConfig = {
  ...checkConfig,
  components: [
    { id: "web", name: "Web", checkIds: ["web"] },
    { id: "public-api", name: "Public API", checkIds: ["."] },
  ],
};

/** Public manual incidents: #1 open, #2 untitled and resolved, #3 resolved. */
export function seedManual(): ManualIncident[] {
  return [
    {
      id: 1,
      title: "Checkout slow",
      componentIds: ["web"],
      impact: "major",
      status: "investigating",
      createdAt: NOW - 2 * HOUR,
      resolvedAt: null,
      updates: [{ at: NOW - 2 * HOUR, status: "investigating", message: "Looking into it." }],
    },
    {
      id: 2,
      title: "   ",
      componentIds: [],
      impact: "minor",
      status: "resolved",
      createdAt: NOW - 5 * HOUR,
      resolvedAt: NOW - 4 * HOUR,
      updates: [
        { at: NOW - 5 * HOUR, status: "investigating", message: "Start." },
        { at: NOW - 4 * HOUR, status: "resolved", message: "Fixed." },
      ],
    },
    {
      id: 3,
      title: "Login errors",
      componentIds: ["public-api", "gone"],
      impact: "critical",
      status: "monitoring",
      createdAt: NOW - 3 * HOUR,
      resolvedAt: null,
      updates: [{ at: NOW - 3 * HOUR, status: "monitoring", message: "Watching." }],
    },
  ];
}

/** Automatic incidents: #7 open on `web`, #31 on `.`, #32 on `..`, both resolved. */
export const seedAutomatic: Incident[] = [
  { id: 7, checkId: "web", openedAt: NOW - HOUR, resolvedAt: null, reason: "timeout" },
  { id: 31, checkId: ".", openedAt: NOW - 6 * HOUR, resolvedAt: NOW - 5 * HOUR, reason: null },
  { id: 32, checkId: "..", openedAt: NOW - 7 * HOUR, resolvedAt: NOW - 6 * HOUR, reason: null },
];

export const seedResults: Record<string, unknown> = { web: webResults };

/** One request the fake received; `body` is the parsed JSON of a write, else undefined. */
export type IncidentApiSeen = { method: string; path: string; query: string; body: unknown };

export type IncidentApiOptions = {
  token: string;
  /** The `/admin/config` answer, written as pulse-api writes it. */
  config: unknown;
  manual?: ManualIncident[];
  automatic?: Incident[];
  /** Results by check id; a check without an entry answers `404`. */
  results?: Record<string, unknown>;
  /** The clock of `at`, `createdAt` and `resolvedAt` of writes. */
  now: () => number;
};

export type IncidentApi = {
  url: string;
  seen: IncidentApiSeen[];
  manual: ManualIncident[];
  /** Requests of one method whose path starts with `prefix`. */
  count: (method: string, prefix: string) => number;
  /** `GET` requests to pulse-api. */
  reads: () => number;
  /** `POST`, `PUT` and `DELETE` requests to pulse-api. */
  writes: () => number;
  /** The public list also returns a private-looking item (section 3). */
  setPrivateItem: (isOn: boolean) => void;
  /** The incident is resolved right after its next single read (the resolve race). */
  resolveAfterNextRead: (id: number) => void;
  /** Holds every write until the promise resolves. */
  holdWrites: (gate: Promise<void> | undefined) => void;
  /** Answers one method and path prefix with a fixed reply instead of the state. */
  override: (method: string, prefix: string, reply: () => Response) => void;
  stop: () => void;
};

const MAX_UPDATES = 100;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: WIRE_HEADERS });
}

function error(status: number, message: string): Response {
  return json(status, { error: message });
}

const PRIVATE_ITEM = {
  id: 999,
  title: "Private draft title",
  componentIds: [],
  impact: "minor",
  visibility: "private",
  status: "investigating",
  createdAt: 1,
  publishedAt: null,
  resolvedAt: null,
  updates: [],
};

type State = {
  options: IncidentApiOptions;
  manual: ManualIncident[];
  nextId: number;
  isPrivateItem: boolean;
  resolveAfterRead: Set<number>;
};

function listManual(state: State): Response {
  const items: unknown[] = [...state.manual].sort((a, b) => b.id - a.id);
  if (state.isPrivateItem) items.push(PRIVATE_ITEM);
  return json(200, items);
}

function oneManual(state: State, id: number): Response {
  const incident = state.manual.find((m) => m.id === id);
  if (incident === undefined) return error(404, "incident not found");
  const body = json(200, incident);
  if (state.resolveAfterRead.delete(id)) {
    incident.status = "resolved";
    incident.resolvedAt = state.options.now();
  }
  return body;
}

function automaticList(state: State, query: URLSearchParams): Response {
  const since = Number(query.get("since") ?? "0");
  const limit = Number(query.get("limit") ?? "1000");
  const items = (state.options.automatic ?? []).filter(
    (i) => i.resolvedAt === null || i.resolvedAt >= since,
  );
  return json(200, items.slice(0, limit));
}

function results(state: State, checkId: string): Response {
  const list = state.options.results?.[checkId];
  return list === undefined ? error(404, "check not found") : json(200, list);
}

function handleRead(state: State, path: string, query: URLSearchParams): Response {
  if (path === "/admin/config") return json(200, state.options.config);
  if (path === "/manual-incidents") return listManual(state);
  if (path === "/incidents") return automaticList(state, query);
  const one = /^\/manual-incidents\/(\d+)$/.exec(path);
  if (one?.[1] !== undefined) return oneManual(state, Number(one[1]));
  const res = /^\/checks\/([^/]+)\/results$/.exec(path);
  if (res?.[1] !== undefined) return results(state, decodeURIComponent(res[1]));
  return error(404, "not found");
}

function create(state: State, body: unknown): Response {
  const checked = validateManualIncidentInput(body);
  if (!checked.ok) return error(400, checked.error);
  const now = state.options.now();
  const status = checked.value.status ?? "investigating";
  const incident: ManualIncident = {
    id: state.nextId,
    title: checked.value.title,
    componentIds: checked.value.componentIds,
    impact: checked.value.impact,
    status,
    createdAt: now,
    resolvedAt: null,
    updates: [{ at: now, status, message: checked.value.message }],
  };
  state.nextId += 1;
  state.manual.push(incident);
  return json(201, incident);
}

function addUpdate(state: State, id: number, body: unknown, isResolve: boolean): Response {
  const incident = state.manual.find((m) => m.id === id);
  if (incident === undefined) return error(404, "incident not found");
  const message =
    typeof body === "object" && body !== null && "message" in body ? body.message : undefined;
  const posted = typeof body === "object" && body !== null ? body : {};
  const input = isResolve ? { status: "resolved", message } : posted;
  const checked = validateManualIncidentUpdateInput(input);
  if (!checked.ok) return error(400, checked.error);
  if (incident.resolvedAt !== null) return error(409, "incident is resolved");
  if (incident.updates.length >= MAX_UPDATES) return error(409, "incident has 100 updates");
  const now = state.options.now();
  incident.updates.push({ at: now, status: checked.value.status, message: checked.value.message });
  incident.status = checked.value.status;
  if (isResolve) incident.resolvedAt = now;
  return json(isResolve ? 200 : 201, incident);
}

function remove(state: State, id: number): Response {
  const index = state.manual.findIndex((m) => m.id === id);
  if (index < 0) return error(404, "incident not found");
  state.manual.splice(index, 1);
  return new Response(null, { status: 204, headers: WIRE_HEADERS });
}

function handleWrite(state: State, method: string, path: string, body: unknown): Response {
  if (method === "POST" && path === "/manual-incidents") return create(state, body);
  const match = /^\/manual-incidents\/(\d+)(\/updates|\/resolve)?$/.exec(path);
  const id = Number(match?.[1] ?? "0");
  if (match === null) return error(404, "not found");
  if (method === "POST" && match[2] === "/updates") return addUpdate(state, id, body, false);
  if (method === "POST" && match[2] === "/resolve") return addUpdate(state, id, body, true);
  if (method === "DELETE" && match[2] === undefined) return remove(state, id);
  return error(405, "method not allowed");
}

function parsed(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // A body that is not JSON is recorded as its text; the handler answers 400.
    return text;
  }
}

export function startIncidentApi(options: IncidentApiOptions): IncidentApi {
  const seen: IncidentApiSeen[] = [];
  const overrides = new Map<string, () => Response>();
  let writeGate: Promise<void> | undefined;
  const state: State = {
    options,
    manual: [...(options.manual ?? [])],
    nextId: Math.max(0, ...(options.manual ?? []).map((m) => m.id)) + 1,
    isPrivateItem: false,
    resolveAfterRead: new Set(),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const isWrite = req.method !== "GET" && req.method !== "HEAD";
      const body = isWrite ? parsed(await req.text()) : undefined;
      seen.push({ method: req.method, path: url.pathname, query: url.search, body });
      for (const [key, reply] of overrides) {
        const [method, prefix] = key.split(" ");
        if (method === req.method && prefix !== undefined && url.pathname.startsWith(prefix)) {
          return reply();
        }
      }
      const isAdmin = isWrite || url.pathname.startsWith("/admin/");
      if (isAdmin && req.headers.get("authorization") !== `Bearer ${options.token}`) {
        return error(401, "unauthorized");
      }
      if (!isWrite) return handleRead(state, url.pathname, url.searchParams);
      if (writeGate !== undefined) await writeGate;
      return handleWrite(state, req.method, url.pathname, body);
    },
  });
  const count = (method: string, prefix: string): number =>
    seen.filter((s) => s.method === method && s.path.startsWith(prefix)).length;
  return {
    url: `http://127.0.0.1:${server.port}`,
    seen,
    manual: state.manual,
    count,
    reads: () => seen.filter((s) => s.method === "GET").length,
    writes: () => seen.filter((s) => ["POST", "PUT", "DELETE"].includes(s.method)).length,
    setPrivateItem: (isOn) => {
      state.isPrivateItem = isOn;
    },
    resolveAfterNextRead: (id) => {
      state.resolveAfterRead.add(id);
    },
    holdWrites: (gate) => {
      writeGate = gate;
    },
    override: (method, prefix, reply) => {
      overrides.set(`${method} ${prefix}`, reply);
    },
    stop: () => {
      void server.stop(true);
    },
  };
}
