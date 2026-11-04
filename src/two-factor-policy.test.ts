import { expect, test } from "bun:test";
import { isSecondFactorRequired, signInStage } from "./two-factor-policy.ts";

test("the owner must have a second factor", () => {
  expect(isSecondFactorRequired({ role: "owner" })).toBe(true);
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
