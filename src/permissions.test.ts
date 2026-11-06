import { describe, expect, test } from "bun:test";
import { NAVIGATION } from "./navigation.ts";
import {
  type Action,
  isAllowed,
  minimumRole,
  NoMinimumRoleError,
  PERMISSION_MATRIX,
  routeRole,
  targetDecision,
} from "./permissions.ts";
import type { ConsoleRole } from "./roles.ts";

const ROLES: readonly ConsoleRole[] = ["viewer", "member", "admin", "owner"];

// Copied from spec #564, section 1: Viewer, Member, Admin, Owner. Not imported from the module.
const MATRIX: readonly (readonly [number, Action, string])[] = [
  [1, "overview.view", "YYYY"],
  [2, "check.write", "NYYY"],
  [3, "check.delete", "NNYY"],
  [4, "incident.write", "NYYY"],
  [5, "incident.delete", "NNYY"],
  [6, "incident.edit-text", "NNNN"],
  [7, "maintenance.create", "NYYY"],
  [8, "maintenance.edit", "NYYY"],
  [9, "maintenance.delete", "NNYY"],
  [10, "settings.edit", "NNNY"],
  [11, "token.write", "NNYY"],
  [12, "probe.write", "NNYY"],
  [13, "activity.view", "NNYY"],
  [14, "invite.member", "NNYY"],
  [15, "invite.admin", "NNNY"],
  [16, "remove.member", "NNYY"],
  [17, "remove.admin", "NNNY"],
  [18, "role.member-viewer", "NNNY"],
  [19, "role.admin", "NNNY"],
  [20, "reset-link.member", "NNYY"],
  [21, "reset-link.admin", "NNNY"],
  [22, "reset-link.owner", "NNNN"],
  [23, "2fa-reset.member", "NNYY"],
  [24, "2fa-reset.admin", "NNNY"],
  [25, "owner.transfer", "NNNY"],
  [26, "org.delete", "NNNN"],
  [27, "account.self", "YYYY"],
];

describe("permission matrix", () => {
  test("the literal table has 27 rows and 108 cells", () => {
    expect(MATRIX).toHaveLength(27);
    expect(MATRIX.map(([n]) => n)).toEqual(Array.from({ length: 27 }, (_, i) => i + 1));
    expect(MATRIX.reduce((sum, [, , cells]) => sum + cells.length, 0)).toBe(108);
  });

  const cells = MATRIX.flatMap(([row, action, yn]) =>
    ROLES.map((role, i) => [row, action, role, yn[i] === "Y"] as const),
  );
  test.each(cells)("row %d %s for %s: %p", (_row, action, role, expected) => {
    expect(isAllowed(role, action)).toBe(expected);
  });

  test("each row has allowed and denied cases, or records why one is inapplicable", () => {
    for (const [row, action, yn] of MATRIX) {
      if (yn === "YYYY") {
        // All-Y rows (1, 27): a denied role case is inapplicable.
        expect([1, 27]).toContain(row);
        expect(minimumRole(action)).toBe("viewer");
      } else if (yn === "NNNN") {
        // All-N rows (6, 22, 26): an allowed case is inapplicable.
        expect([6, 22, 26]).toContain(row);
        expect(minimumRole(action)).toBeUndefined();
      } else {
        expect(yn).toContain("Y");
        expect(yn).toContain("N");
      }
    }
  });

  test.each([
    ["team.view", "NNYY"],
    ["team.require-2fa", "NNNY"],
  ] as const)("%s is %s", (action, yn) => {
    expect(ROLES.map((r) => (isAllowed(r, action) ? "Y" : "N")).join("")).toBe(yn);
  });

  test("a route with an action that no role may do throws a named error", () => {
    for (const action of ["incident.edit-text", "reset-link.owner", "org.delete"] as const) {
      expect(() => routeRole(action)).toThrow(NoMinimumRoleError);
    }
    expect(routeRole("overview.view")).toBe("viewer");
    expect(routeRole("team.view")).toBe("admin");
  });

  test("navigation minimum roles are the literal values", () => {
    expect(NAVIGATION.map((e) => [e.label, e.minRole])).toEqual([
      ["Overview", "viewer"],
      ["Checks", "viewer"],
      ["Incidents", "viewer"],
      ["Maintenance", "viewer"],
      ["Tokens", "admin"],
      ["Probes", "admin"],
      ["Status page", "owner"],
      ["Team", "admin"],
      ["Activity", "admin"],
      ["System", "admin"],
    ]);
  });
});

describe("target rules", () => {
  test("the Owner is never a target", () => {
    for (const actor of ROLES) {
      for (const kind of [
        "remove",
        "role-change",
        "reset-link",
        "2fa-reset",
        "transfer",
      ] as const) {
        expect(targetDecision(actor, kind, "owner")).toEqual({
          isAllowed: false,
          reason: "owner-target",
        });
      }
    }
  });

  test.each([
    ["admin", "invite", "member", undefined, { isAllowed: true }],
    [
      "member",
      "invite",
      "member",
      undefined,
      { isAllowed: false, reason: "role", requiredRole: "admin" },
    ],
    [
      "admin",
      "invite",
      "admin",
      undefined,
      { isAllowed: false, reason: "role", requiredRole: "owner" },
    ],
    ["owner", "invite", "admin", undefined, { isAllowed: true }],
    ["admin", "remove", "viewer", undefined, { isAllowed: true }],
    [
      "admin",
      "remove",
      "admin",
      undefined,
      { isAllowed: false, reason: "role", requiredRole: "owner" },
    ],
    ["owner", "remove", "admin", undefined, { isAllowed: true }],
    [
      "admin",
      "role-change",
      "member",
      "viewer",
      { isAllowed: false, reason: "role", requiredRole: "owner" },
    ],
    ["owner", "role-change", "member", "viewer", { isAllowed: true }],
    ["owner", "role-change", "member", "admin", { isAllowed: true }],
    ["owner", "role-change", "member", "owner", { isAllowed: false, reason: "owner-target" }],
    ["admin", "reset-link", "member", undefined, { isAllowed: true }],
    [
      "admin",
      "reset-link",
      "admin",
      undefined,
      { isAllowed: false, reason: "role", requiredRole: "owner" },
    ],
    ["admin", "2fa-reset", "viewer", undefined, { isAllowed: true }],
    [
      "admin",
      "2fa-reset",
      "admin",
      undefined,
      { isAllowed: false, reason: "role", requiredRole: "owner" },
    ],
    ["owner", "transfer", "admin", undefined, { isAllowed: true }],
    ["owner", "transfer", "member", undefined, { isAllowed: false, reason: "transfer-not-admin" }],
    [
      "admin",
      "transfer",
      "admin",
      undefined,
      { isAllowed: false, reason: "role", requiredRole: "owner" },
    ],
  ] as const)("%s %s of %s (to %p)", (actor, kind, target, toRole, expected) => {
    expect(targetDecision(actor, kind, target, toRole)).toEqual(expected);
  });
});

describe("exported matrix data", () => {
  test("PERMISSION_MATRIX holds the spec rows and the two Team actions", () => {
    const expected: Record<string, ConsoleRole | null> = {
      "team.view": "admin",
      "team.require-2fa": "owner",
    };
    for (const [, action, cells] of MATRIX) {
      const first = cells.indexOf("Y");
      expected[action] = first === -1 ? null : (ROLES[first] ?? null);
    }
    expect(Object.fromEntries(Object.entries(PERMISSION_MATRIX))).toEqual(expected);
    expect(Object.keys(PERMISSION_MATRIX)).toHaveLength(29);
  });
});
