import type { Logger } from "@lorenzh/pulse-kit";
import type { AccountStore } from "./account-store.ts";
import type { ApiReadDeps, FetchLike } from "./api-read.ts";
import { checkDetailPage, type DetailPage, shadowedPage } from "./check-detail-pages.ts";
import { exportBody, shadowedCheckExport, singleCheckExport } from "./check-export.ts";
import { parseCheckFilters } from "./check-filters.ts";
import { checkListView, checkProblemView } from "./check-pages.ts";
import {
  readCheckConfig,
  readCheckDetail,
  readCheckExport,
  readCheckList,
  resultsBeforeOf,
} from "./check-read.ts";
import { routeRole } from "./permissions.ts";
import type { PageRequest, PageResult, ProtectedRoute } from "./protected-route.ts";
import { notFoundState } from "./states.ts";

export type CheckRouteDeps = {
  store: AccountStore;
  defaultApiUrl: string;
  adminToken: string | undefined;
  fetch: FetchLike;
  schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
  log: Logger;
};

function apiUrlOf(deps: CheckRouteDeps): string {
  return deps.store.instance()?.apiUrl ?? deps.defaultApiUrl;
}

function readDeps(deps: CheckRouteDeps): ApiReadDeps {
  return {
    fetch: deps.fetch,
    token: deps.adminToken,
    schedule: deps.schedule,
    warn: (message, fields) => deps.log.warn(message, fields),
  };
}

function notFound(): PageResult {
  return { kind: "page", status: 404, title: "Page not found", body: notFoundState() };
}

/** R1: `GET /checks`, Viewer+. */
function listRoute(deps: CheckRouteDeps): ProtectedRoute {
  return {
    path: "/checks",
    methods: ["GET"],
    requiredRole: routeRole("overview.view"),
    navId: "checks",
    handle: async (request) => {
      const read = await readCheckList(apiUrlOf(deps), readDeps(deps));
      const view = checkListView(read, parseCheckFilters(request.query), request.role);
      const banner = view.banner === "" ? undefined : view.banner;
      return { kind: "page", status: 200, title: "Checks", body: view.body, banner };
    },
  };
}

/** Decision 4: the query id, present once and non-empty; else `undefined` (the shell 404). */
function queryIdOf(query: URLSearchParams): string | undefined {
  const ids = query.getAll("id");
  const [id] = ids;
  return ids.length === 1 && id !== undefined && id !== "" ? id : undefined;
}

function detailResult(page: DetailPage): PageResult {
  if (page.kind === "not-found") return notFound();
  const banner = page.view.banner === "" ? undefined : page.view.banner;
  return { kind: "page", status: 200, title: page.title, body: page.view.body, banner };
}

/** R2: `GET /checks/check?id=<id>`, Viewer+. */
function detailRoute(deps: CheckRouteDeps): ProtectedRoute {
  return {
    path: "/checks/check",
    methods: ["GET"],
    requiredRole: routeRole("overview.view"),
    navId: "checks",
    handle: async (request) => {
      const id = queryIdOf(request.query);
      if (id === undefined) return notFound();
      const apiUrl = apiUrlOf(deps);
      const before = resultsBeforeOf(request.query);
      const read = await readCheckDetail(apiUrl, readDeps(deps), id, before);
      return detailResult(checkDetailPage(read, { id, before, role: request.role, apiUrl }));
    },
  };
}

/** R3: `GET /checks/shadowed?id=<id>`, Viewer+. Reads only `/admin/config`. */
function shadowedRoute(deps: CheckRouteDeps): ProtectedRoute {
  return {
    path: "/checks/shadowed",
    methods: ["GET"],
    requiredRole: routeRole("overview.view"),
    navId: "checks",
    handle: async (request) => {
      const id = queryIdOf(request.query);
      if (id === undefined) return notFound();
      const read = await readCheckConfig(apiUrlOf(deps), readDeps(deps));
      const shown =
        read.kind === "ok"
          ? { kind: "ok" as const, view: read.config.shadowed.find((check) => check.id === id) }
          : read;
      return detailResult(shadowedPage(shown, id, request.role));
    },
  };
}

/** The export a query asks for; `undefined` for any other query shape (Decision 4). */
type ExportTarget =
  | { kind: "all" }
  | { kind: "single"; id: string }
  | { kind: "shadowed"; id: string };

function exportTargetOf(query: URLSearchParams): ExportTarget | undefined {
  const keys = [...query.keys()];
  if (keys.length === 0) return { kind: "all" };
  const id = queryIdOf(query);
  if (id === undefined || keys[0] !== "id") return undefined;
  if (keys.length === 1) return { kind: "single", id };
  const isShadowed = keys.length === 2 && keys[1] === "shadowed" && query.get("shadowed") === "1";
  return isShadowed ? { kind: "shadowed", id } : undefined;
}

function problemPage(view: { banner: string; body: string }): PageResult {
  const banner = view.banner === "" ? undefined : view.banner;
  return { kind: "page", status: 502, title: "Export", body: view.body, banner };
}

async function exportOf(target: ExportTarget, deps: CheckRouteDeps): Promise<PageResult> {
  const apiUrl = apiUrlOf(deps);
  if (target.kind === "shadowed") {
    const read = await readCheckConfig(apiUrl, readDeps(deps));
    if (read.kind !== "ok") return problemPage(checkProblemView(read, "/checks"));
    const view = read.config.shadowed.find((check) => check.id === target.id);
    if (view === undefined) return notFound();
    const built = shadowedCheckExport(view);
    if (built.kind === "invalid") {
      deps.log.warn("check export invalid", { kind: "shadowed" });
      return problemPage(
        checkProblemView({ kind: "failed", failure: { kind: "invalid" } }, "/checks"),
      );
    }
    return { kind: "download", filename: "check.json", body: exportBody(built.document) };
  }
  const read = await readCheckExport(apiUrl, readDeps(deps));
  if (read.kind !== "ok") return problemPage(checkProblemView(read, "/checks"));
  if (target.kind === "all") {
    return { kind: "download", filename: "checks.json", body: exportBody(read.document) };
  }
  const single = singleCheckExport(read.document, target.id);
  if (single === undefined) return notFound();
  return { kind: "download", filename: "check.json", body: exportBody(single) };
}

/** R7: `GET /checks/export[?id=<id>[&shadowed=1]]`, Member+. */
function exportRoute(deps: CheckRouteDeps): ProtectedRoute {
  return {
    path: "/checks/export",
    methods: ["GET"],
    requiredRole: routeRole("check.write"),
    navId: "checks",
    handle: async (request: PageRequest) => {
      const target = exportTargetOf(request.query);
      return target === undefined ? notFound() : exportOf(target, deps);
    },
  };
}

/** The production Checks routes. Writes follow in later steps. */
export function checkRoutes(deps: CheckRouteDeps): ProtectedRoute[] {
  return [listRoute(deps), detailRoute(deps), shadowedRoute(deps), exportRoute(deps)];
}
