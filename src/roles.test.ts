import { describe, expect, test } from "bun:test";
import { type ConsoleRole, hasRole, InvalidRoleError, parseRole, roleLabel } from "./roles.ts";

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

describe("parseRole", () => {
  test("accepts the four stored roles", () => {
    expect(["owner", "admin", "member", "viewer"].map((r) => parseRole(r))).toEqual([
      "owner",
      "admin",
      "member",
      "viewer",
    ]);
  });

  test.each([["superuser"], ["Owner"], [""], [null], [3], ["toString"], ["__proto__"]])(
    "rejects %p with invalid role",
    (value) => {
      expect(() => parseRole(value)).toThrow(InvalidRoleError);
      expect(() => parseRole(value)).toThrow("invalid role");
    },
  );
});
