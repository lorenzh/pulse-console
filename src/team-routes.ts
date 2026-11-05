import type { AccountStore } from "./account-store.ts";
import { routeRole } from "./permissions.ts";
import type { ProtectedRoute } from "./protected-route.ts";
import { teamPageBody } from "./team-pages.ts";
import type { TeamStore } from "./team-store.ts";

export type TeamRouteDeps = {
  store: AccountStore;
  teamStore: TeamStore;
  now: () => number;
};

/** `GET /team`: the People list and pending invites, Admin and Owner (`team.view`). */
export function teamRoute(deps: TeamRouteDeps): ProtectedRoute {
  return {
    path: "/team",
    methods: ["GET"],
    requiredRole: routeRole("team.view"),
    navId: "team",
    handle: (request) =>
      Promise.resolve({
        kind: "page",
        status: 200,
        title: "Team",
        body: teamPageBody({
          role: request.role,
          members: deps.teamStore.members(),
          invites: deps.teamStore.pendingInvites(),
          isTwoFactorRequiredForAll: deps.store.instance()?.isTwoFactorRequiredForAll === true,
          now: deps.now(),
        }),
      }),
  };
}

/** The production protected team routes, keyed by raw path. */
export function teamRoutes(deps: TeamRouteDeps): ProtectedRoute[] {
  return [teamRoute(deps)];
}
