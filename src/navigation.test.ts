import { describe, expect, test } from "bun:test";
import { NAVIGATION, visibleNavigation } from "./navigation.ts";
import type { ConsoleRole } from "./roles.ts";
import { shellPage } from "./shell.ts";

const ROLES: ConsoleRole[] = ["viewer", "member", "admin", "owner"];
const allAvailable = NAVIGATION.map((e) => ({ ...e, isAvailable: true }));
const labels = (role: ConsoleRole, registry = NAVIGATION) =>
  visibleNavigation(role, registry).map((e) => e.label);

describe("navigation registry", () => {
  test("has exactly 9 entries, 8 of them unavailable", () => {
    expect(NAVIGATION).toHaveLength(9);
    expect(NAVIGATION.filter((e) => !e.isAvailable)).toHaveLength(8);
  });

  test.each(ROLES)("today %s sees only Overview", (role) => {
    expect(labels(role)).toEqual(["Overview"]);
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
    expect(html.match(/<a href="[^"]*"/g)).toEqual(['<a href="/account/security"', '<a href="/"']);
    for (const path of ["/checks", "/incidents", "/tokens", "/system"]) {
      expect(html).not.toContain(`href="${path}"`);
    }
    expect(html).not.toContain("Checks");
  });
});
