export const PASSWORD_HASH_OPTIONS = {
  algorithm: "argon2id",
  memoryCost: 19456,
  timeCost: 2,
} as const;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export type HashPassword = (password: string) => Promise<string>;
export type VerifyPassword = (password: string, hash: string) => Promise<boolean>;

export type PasswordProblem = "too-short" | "too-long" | "mismatch";

function codePoints(text: string): number {
  return [...text].length;
}

/** The setup rule: 12 to 128 code points, not trimmed, and an equal confirmation. */
export function passwordProblem(
  password: string,
  confirmation: string,
): PasswordProblem | undefined {
  const length = codePoints(password);
  if (length < MIN_PASSWORD_LENGTH) return "too-short";
  if (length > MAX_PASSWORD_LENGTH) return "too-long";
  if (password !== confirmation) return "mismatch";
  return undefined;
}

/** The sign-in rule before the throttle: not empty and at most 128 code points. */
export function isSignInPasswordAcceptable(password: string): boolean {
  return password !== "" && codePoints(password) <= MAX_PASSWORD_LENGTH;
}

export type CredentialVerifier = {
  /** Checks a password against a stored hash; an unknown account runs the dummy and fails. */
  verify: (password: string, storedHash: string | undefined) => Promise<boolean>;
};

/**
 * Makes the dummy verifier with the same hash function, so an unknown email costs one full
 * verification like a known one. `dummySecret` comes from injected randomness.
 */
export async function createCredentialVerifier(deps: {
  hash: HashPassword;
  verify: VerifyPassword;
  dummySecret: string;
}): Promise<CredentialVerifier> {
  const dummyHash = await deps.hash(deps.dummySecret);
  return {
    async verify(password, storedHash) {
      if (storedHash === undefined) {
        await deps.verify(password, dummyHash);
        return false;
      }
      return deps.verify(password, storedHash);
    },
  };
}
