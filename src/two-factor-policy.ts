import type { User } from "./account-store.ts";

export type SignInStage = "factor" | "enrol" | "full";

/** The only rule for who must have a second factor. #564 extends it to every admin. */
export function isSecondFactorRequired(user: { role: User["role"] }): boolean {
  return user.role === "owner";
}

/** The session stage that a correct password starts. */
export function signInStage(view: { isRequired: boolean; hasAuthenticator: boolean }): SignInStage {
  if (view.hasAuthenticator) return "factor";
  return view.isRequired ? "enrol" : "full";
}
