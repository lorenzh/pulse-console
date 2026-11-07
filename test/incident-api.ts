// A stateful fake of the pulse-api incident routes for the server tests and the browser checks.
// One Bun server on 127.0.0.1 port 0. It keeps public manual incidents in memory, validates
// write bodies with the pinned contract and records every request.
import {
  type AdminMaintenanceWindow,
  type Incident,
  type ManualIncident,
  validateAdminMaintenanceWindowInput,
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
  /** Maintenance windows of `/admin/maintenance`; `phase` is computed from `now`. */
  maintenance?: SeedWindow[];
  /** Database windows whose id a file window also defines. */
  shadowed?: SeedWindow[];
};

/** A seeded window: everything but the phase, which the fake computes. */
export type SeedWindow = Omit<AdminMaintenanceWindow, "phase">;

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
  /** The current database and file windows, and the shadowed database copies. */
  windows: SeedWindow[];
  shadowed: SeedWindow[];
  /** The shared admin revision of `/admin/config` and `/admin/maintenance`. */
  revision: () => string;
  /** Changes the shared revision, as another client's write would. */
  bumpRevision: () => void;
  /** Runs once right before the answer of the next request of `method` and `path`. */
  beforeAnswer: (method: string, path: string, fn: () => void | Promise<void>) => void;
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
  windows: SeedWindow[];
  shadowed: SeedWindow[];
  revision: number;
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

function revisionOf(state: State): string {
  // Revision 0 is the fixtures' REVISION; every saved write changes it.
  const count = state.revision === 0 ? "" : state.revision.toString(16);
  return `sha256-${count.padStart(64, "b")}`;
}

function phaseOf(window: SeedWindow, now: number): AdminMaintenanceWindow {
  if (now < window.start) return { ...window, phase: "planned" };
  return { ...window, phase: now < window.end ? "current" : "past" };
}

function maintenanceList(state: State): Response {
  const now = state.options.now();
  return json(200, {
    revision: revisionOf(state),
    windows: state.windows.map((w) => phaseOf(w, now)),
    shadowed: state.shadowed.map((w) => phaseOf(w, now)),
  });
}

function configOf(state: State): unknown {
  const config = state.options.config;
  return typeof config === "object" && config !== null
    ? { ...config, revision: revisionOf(state) }
    : config;
}

function handleRead(state: State, path: string, query: URLSearchParams): Response {
  if (path === "/admin/config") return json(200, configOf(state));
  if (path === "/admin/maintenance") return maintenanceList(state);
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

function saved(state: State, status: number, body: unknown): Response {
  state.revision += 1;
  const headers = { ...WIRE_HEADERS, etag: `"${revisionOf(state)}"` };
  return body === undefined
    ? new Response(null, { status, headers })
    : new Response(JSON.stringify(body), { status, headers });
}

/** The If-Match rule of pulse-api's admin writes; undefined when it holds. */
function ifMatchProblem(state: State, ifMatch: string | null): Response | undefined {
  if (ifMatch === null) return error(428, "If-Match is required");
  if (ifMatch === "*") return error(400, "If-Match must name a revision");
  if (ifMatch !== `"${revisionOf(state)}"`) return error(412, "revision changed");
  return undefined;
}

function missingWindow(state: State, id: string): Response {
  const isFile = state.windows.some((w) => w.source === "file" && w.id === id);
  return error(isFile ? 409 : 404, isFile ? "the checks file defines this id" : "not found");
}

function databaseIndex(state: State, id: string): number {
  return state.windows.findIndex((w) => w.source === "database" && w.id === id);
}

function deleteWindow(state: State, id: string): Response {
  const shadowedAt = state.shadowed.findIndex((w) => w.id === id);
  if (shadowedAt >= 0) {
    state.shadowed.splice(shadowedAt, 1);
    return saved(state, 204, undefined);
  }
  const at = databaseIndex(state, id);
  if (at < 0) return missingWindow(state, id);
  state.windows.splice(at, 1);
  return saved(state, 204, undefined);
}

function windowOf(body: unknown): SeedWindow | Response {
  const checked = validateAdminMaintenanceWindowInput(body);
  if (!checked.ok) return error(400, checked.error);
  return { ...checked.value, index: null, source: "database" };
}

function createWindow(state: State, body: unknown): Response {
  const window = windowOf(body);
  if (window instanceof Response) return window;
  const id = window.id;
  if (state.windows.some((w) => w.id === id) || state.shadowed.some((w) => w.id === id)) {
    return error(409, "a window with this id exists");
  }
  state.windows.push(window);
  return saved(state, 201, phaseOf(window, state.options.now()));
}

function replaceWindow(state: State, id: string, body: unknown): Response {
  const window = windowOf(body);
  if (window instanceof Response) return window;
  if (window.id !== id) return error(400, "id must equal the path id");
  const at = databaseIndex(state, id);
  if (at < 0) return missingWindow(state, id);
  state.windows[at] = window;
  return saved(state, 200, phaseOf(window, state.options.now()));
}

/** The maintenance writes: If-Match first, then the body, then the state. */
function maintenanceWrite(
  state: State,
  method: string,
  id: string | undefined,
  body: unknown,
  ifMatch: string | null,
): Response {
  const problem = ifMatchProblem(state, ifMatch);
  if (problem !== undefined) return problem;
  if (id === undefined) return createWindow(state, body);
  return method === "DELETE" ? deleteWindow(state, id) : replaceWindow(state, id, body);
}

function handleWrite(
  state: State,
  method: string,
  path: string,
  body: unknown,
  ifMatch: string | null,
): Response {
  if (method === "POST" && path === "/admin/maintenance") {
    return maintenanceWrite(state, method, undefined, body, ifMatch);
  }
  const window = /^\/admin\/maintenance\/([^/]+)$/.exec(path);
  if (window?.[1] !== undefined && (method === "PUT" || method === "DELETE")) {
    return maintenanceWrite(state, method, decodeURIComponent(window[1]), body, ifMatch);
  }
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
  const hooks = new Map<string, () => void | Promise<void>>();
  let writeGate: Promise<void> | undefined;
  const state: State = {
    options,
    manual: [...(options.manual ?? [])],
    windows: [...(options.maintenance ?? [])],
    shadowed: [...(options.shadowed ?? [])],
    revision: 0,
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
      const hookKey = `${req.method} ${url.pathname}`;
      const hook = hooks.get(hookKey);
      if (hook !== undefined) {
        hooks.delete(hookKey);
        await hook();
      }
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
      return handleWrite(state, req.method, url.pathname, body, req.headers.get("if-match"));
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
    windows: state.windows,
    shadowed: state.shadowed,
    revision: () => revisionOf(state),
    bumpRevision: () => {
      state.revision += 1;
    },
    beforeAnswer: (method, path, fn) => {
      hooks.set(`${method} ${path}`, fn);
    },
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
