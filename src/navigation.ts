import { type ConsoleRole, hasRole } from "./roles.ts";

export type NavId =
  | "overview"
  | "checks"
  | "incidents"
  | "maintenance"
  | "tokens"
  | "probes"
  | "status-page"
  | "team"
  | "activity"
  | "system";

export type NavEntry = {
  id: NavId;
  label: string;
  path: string;
  minRole: ConsoleRole;
  /** A later screen sets this in the same change that adds its route. */
  isAvailable: boolean;
};

// Minimum roles follow the role matrix of #564.
export const NAVIGATION: readonly NavEntry[] = [
  { id: "overview", label: "Overview", path: "/", minRole: "viewer", isAvailable: true },
  { id: "checks", label: "Checks", path: "/checks", minRole: "viewer", isAvailable: true },
  {
    id: "incidents",
    label: "Incidents",
    path: "/incidents",
    minRole: "viewer",
    isAvailable: false,
  },
  {
    id: "maintenance",
    label: "Maintenance",
    path: "/maintenance",
    minRole: "viewer",
    isAvailable: false,
  },
  { id: "tokens", label: "Tokens", path: "/tokens", minRole: "admin", isAvailable: true },
  { id: "probes", label: "Probes", path: "/probes", minRole: "admin", isAvailable: true },
  {
    id: "status-page",
    label: "Status page",
    path: "/status-page",
    minRole: "owner",
    isAvailable: true,
  },
  { id: "team", label: "Team", path: "/team", minRole: "admin", isAvailable: true },
  { id: "activity", label: "Activity", path: "/activity", minRole: "admin", isAvailable: false },
  { id: "system", label: "System", path: "/system", minRole: "admin", isAvailable: false },
];

/** The entries that are available and allowed for `role`, in registry order. */
export function visibleNavigation(
  role: ConsoleRole,
  registry: readonly NavEntry[] = NAVIGATION,
): NavEntry[] {
  return registry.filter((e) => e.isAvailable && hasRole(role, e.minRole));
}

/** Splits visible entries into the main group and the admin "Instance" group, in order. */
export function navigationGroups(entries: readonly NavEntry[]): {
  main: NavEntry[];
  instance: NavEntry[];
} {
  return {
    main: entries.filter((e) => !hasRole(e.minRole, "admin")),
    instance: entries.filter((e) => hasRole(e.minRole, "admin")),
  };
}
