import { describe, expect, test } from "bun:test";
import { NAVIGATION, visibleNavigation } from "./navigation.ts";
import type { ConsoleRole } from "./roles.ts";
import { shellPage } from "./shell.ts";

const allAvailable = NAVIGATION.map((e) => ({ ...e, isAvailable: true }));
const labels = (role: ConsoleRole, registry = NAVIGATION) =>
  visibleNavigation(role, registry).map((e) => e.label);

describe("navigation registry", () => {
  test("has exactly 9 entries, 6 of them unavailable", () => {
    expect(NAVIGATION).toHaveLength(9);
    expect(NAVIGATION.filter((e) => !e.isAvailable)).toHaveLength(6);
  });

  test.each([
    ["viewer", ["Overview", "Checks"]],
    ["member", ["Overview", "Checks"]],
    ["admin", ["Overview", "Checks", "Team"]],
    ["owner", ["Overview", "Checks", "Team"]],
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
    expect(html.match(/<a href="[^"]*"/g)).toEqual([
      '<a href="/account/security"',
      '<a href="/"',
      '<a href="/checks"',
      '<a href="/team"',
    ]);
    for (const path of ["/incidents", "/tokens", "/system"]) {
      expect(html).not.toContain(`href="${path}"`);
    }
    expect(html).not.toContain("Incidents");
  });
});
