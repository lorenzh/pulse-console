import type { ConsoleRole } from "./roles.ts";

export type SignInStage = "factor" | "enrol" | "full";

/** The only rule for who must have a second factor: the Owner, every Admin, or all with the switch. */
export function isSecondFactorRequired(
  user: { role: ConsoleRole },
  organisation: { isRequiredForAll: boolean },
): boolean {
  return organisation.isRequiredForAll || user.role === "owner" || user.role === "admin";
}

/** The session stage that a correct password starts. */
export function signInStage(view: { isRequired: boolean; hasAuthenticator: boolean }): SignInStage {
  if (view.hasAuthenticator) return "factor";
  return view.isRequired ? "enrol" : "full";
}
