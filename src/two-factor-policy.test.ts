import { expect, test } from "bun:test";
import { isSecondFactorRequired, signInStage } from "./two-factor-policy.ts";

test("the owner must have a second factor", () => {
  expect(isSecondFactorRequired({ role: "owner" }, { isRequiredForAll: false })).toBe(true);
});

test("the predicate covers every role with the switch off and on", () => {
  const cases = [
    { role: "owner", off: true, on: true },
    { role: "admin", off: true, on: true },
    { role: "member", off: false, on: true },
    { role: "viewer", off: false, on: true },
  ] as const;
  for (const { role, off, on } of cases) {
    expect(isSecondFactorRequired({ role }, { isRequiredForAll: false })).toBe(off);
    expect(isSecondFactorRequired({ role }, { isRequiredForAll: true })).toBe(on);
  }
});

test("signInStage covers factor, enrol and full", () => {
  const cases = [
    { isRequired: false, hasAuthenticator: false, stage: "full" },
    { isRequired: true, hasAuthenticator: false, stage: "enrol" },
    { isRequired: true, hasAuthenticator: true, stage: "factor" },
    { isRequired: false, hasAuthenticator: true, stage: "factor" },
  ] as const;
  for (const { stage, ...view } of cases) expect(signInStage(view)).toBe(stage);
});
