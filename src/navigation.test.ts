import { describe, expect, test } from "bun:test";
import { NAVIGATION, navigationGroups, visibleNavigation } from "./navigation.ts";
import type { ConsoleRole } from "./roles.ts";
import { shellPage } from "./shell.ts";

const allAvailable = NAVIGATION.map((e) => ({ ...e, isAvailable: true }));
const labels = (role: ConsoleRole, registry = NAVIGATION) =>
  visibleNavigation(role, registry).map((e) => e.label);

describe("navigation registry", () => {
  test("has exactly 11 entries, 4 of them unavailable; Tokens, Probes, Status page and Notifications are available", () => {
    expect(NAVIGATION).toHaveLength(11);
    expect(NAVIGATION.filter((e) => !e.isAvailable)).toHaveLength(4);
    expect(NAVIGATION.find((e) => e.id === "tokens")).toMatchObject({
      isAvailable: true,
      minRole: "admin",
    });
    expect(NAVIGATION.find((e) => e.id === "probes")).toMatchObject({
      isAvailable: true,
      minRole: "admin",
    });
    expect(NAVIGATION.find((e) => e.id === "status-page")).toMatchObject({
      label: "Status page",
      path: "/status-page",
      isAvailable: true,
      minRole: "owner",
    });
    expect(NAVIGATION.find((e) => e.id === "notifications")).toMatchObject({
      label: "Notifications",
      path: "/notifications",
      isAvailable: true,
      minRole: "owner",
    });
  });

  test.each([
    ["viewer", ["Overview", "Checks"]],
    ["member", ["Overview", "Checks"]],
    ["admin", ["Overview", "Checks", "Tokens", "Probes", "Team"]],
    ["owner", ["Overview", "Checks", "Tokens", "Probes", "Status page", "Notifications", "Team"]],
  ] as const)("today %s sees its available entries", (role, expected) => {
    expect(labels(role)).toEqual([...expected]);
  });

  test.each([
    ["viewer", ["Overview", "Checks", "Incidents", "Maintenance"]],
    ["member", ["Overview", "Checks", "Incidents", "Maintenance"]],
    [
      "admin",
      [
        "Overview",
        "Checks",
        "Incidents",
        "Maintenance",
        "Tokens",
        "Probes",
        "Team",
        "Activity",
        "System",
      ],
    ],
    [
      "owner",
      [
        "Overview",
        "Checks",
        "Incidents",
        "Maintenance",
        "Tokens",
        "Probes",
        "Status page",
        "Notifications",
        "Team",
        "Activity",
        "System",
      ],
    ],
  ] as const)("all available: %s sees its entries", (role, expected) => {
    expect(labels(role, allAvailable)).toEqual([...expected]);
  });

  test("no unavailable entry renders a link", () => {
    const html = shellPage({
      instanceName: "pulse Console",
      user: { name: "A", email: "a@example.com" },
      role: "owner",
      csrf: "c",
      signOutToken: "t",
      current: "overview",
      title: "Overview",
      body: "",
    });
    expect(html.match(/<a (?:class="nav-item" )?href="[^"]*"/g)).toEqual([
      '<a class="nav-item" href="/"',
      '<a class="nav-item" href="/checks"',
      '<a class="nav-item" href="/tokens"',
      '<a class="nav-item" href="/probes"',
      '<a class="nav-item" href="/status-page"',
      '<a class="nav-item" href="/notifications"',
      '<a class="nav-item" href="/team"',
      '<a href="/account/security"',
    ]);
    for (const path of ["/incidents", "/system"]) {
      expect(html).not.toContain(`href="${path}"`);
    }
    expect(html).not.toContain("Incidents");
  });
});

describe("navigationGroups", () => {
  test("splits admin entries into the instance group in registry order", () => {
    const groups = navigationGroups(visibleNavigation("owner", allAvailable));
    expect(groups.main.map((e) => e.label)).toEqual([
      "Overview",
      "Checks",
      "Incidents",
      "Maintenance",
    ]);
    expect(groups.instance.map((e) => e.label)).toEqual([
      "Tokens",
      "Probes",
      "Status page",
      "Notifications",
      "Team",
      "Activity",
      "System",
    ]);
  });

  test("a member has an empty instance group", () => {
    expect(navigationGroups(visibleNavigation("member")).instance).toEqual([]);
  });
});
