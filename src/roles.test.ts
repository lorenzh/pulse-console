import { describe, expect, test } from "bun:test";
import { type ConsoleRole, hasRole, roleLabel } from "./roles.ts";

describe("hasRole", () => {
  const order: ConsoleRole[] = ["viewer", "member", "admin", "owner"];
  test.each(order.flatMap((role, i) => order.map((needed, j) => [role, needed, i >= j] as const)))(
    "%s needs %s: %p",
    (role, needed, expected) => {
      expect(hasRole(role, needed)).toBe(expected);
    },
  );

  test("literal order viewer < member < admin < owner", () => {
    expect(hasRole("member", "viewer")).toBe(true);
    expect(hasRole("member", "admin")).toBe(false);
    expect(hasRole("admin", "owner")).toBe(false);
    expect(hasRole("owner", "admin")).toBe(true);
  });
});

test("roleLabel", () => {
  const roles: ConsoleRole[] = ["viewer", "member", "admin", "owner"];
  expect(roles.map((r) => roleLabel(r))).toEqual(["Viewer", "Member", "Admin", "Owner"]);
});
