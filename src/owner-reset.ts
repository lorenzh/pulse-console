import { chmodSync, closeSync, openSync } from "node:fs";
import { linkDigest, linkUrl, newLinkToken } from "./account-links.ts";
import { createAccountStore } from "./account-store.ts";
import { openDatabase } from "./database.ts";
import { readRecoverySettings } from "./settings.ts";
import { createTeamStore } from "./team-store.ts";

// The owner recovery command: `bun --no-env-file src/owner-reset.ts` in the container. It needs
// neither PULSE_API_URL, the admin token nor the secret key.
const EXIT_FAILURE = 2;

function fail(message: string): never {
  console.error(`pulse-console: ${message}`);
  process.exit(EXIT_FAILURE);
}

let line: string | undefined;
try {
  const settings = readRecoverySettings(process.env);
  const db = openDatabase(settings.dbPath, {
    createFile: (path, mode) => closeSync(openSync(path, "wx", mode)),
    chmod: chmodSync,
  });
  const token = newLinkToken((size) => crypto.getRandomValues(new Uint8Array(size)));
  const isSetUp = createAccountStore(db).instance() !== undefined;
  const isIssued =
    isSetUp &&
    createTeamStore(db).issueOwnerRecoveryLink({ tokenDigest: linkDigest(token), now: Date.now() });
  db.close();
  if (isIssued) {
    const link = linkUrl(settings.publicOrigin ?? "", "reset", token);
    const note = settings.publicOrigin === undefined ? "; open it on the console address" : "";
    line = `pulse-console owner reset link: ${link} (valid 15 minutes, one use${note})`;
  }
} catch (err) {
  // A setting or database error; its message names the setting, never a secret.
  fail(err instanceof Error ? err.message : String(err));
}
if (line === undefined) fail("no owner account: finish setup first");
process.stdout.write(`${line}\n`);
