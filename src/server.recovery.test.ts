import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Client,
  type Console,
  closeAll,
  count,
  csrfIn,
  EMAIL,
  enrolledConsole,
  PASSWORD,
  STEP_MS,
  startConsole,
  stepAt,
  totpCode,
} from "./two-factor-harness.ts";

afterEach(closeAll);

/** SHA-256 hex of a shown code after normalisation, computed here with node:crypto. */
function digestOf(code: string): string {
  return createHash("sha256").update(code.replaceAll("-", "")).digest("hex");
}

function digests(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.query<{ digest: string }, []>("SELECT digest FROM recovery_codes").all();
  db.close();
  return rows.map((r) => r.digest).sort((x, y) => x.localeCompare(y));
}

function usedCount(dbPath: string): number {
  return count(dbPath, "SELECT count(*) AS n FROM recovery_codes WHERE used_at IS NOT NULL");
}

/** A code of the shown format that differs from `code` in its last hex digit. */
function changedCode(code: string): string {
  return `${code.slice(0, -1)}${code.endsWith("0") ? "1" : "0"}`;
}

async function freshFactor(c: Console): Promise<Client> {
  const client = new Client(c);
  expect((await client.password()).headers.get("location")).toBe("/sign-in/factor");
  return client;
}

describe("recovery codes at sign-in", () => {
  test("10 distinct codes are stored only as digests", async () => {
    const { c, codes } = await enrolledConsole();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/);
    expect(digests(c.dbPath)).toEqual(codes.map(digestOf).sort((x, y) => x.localeCompare(y)));
    const dir = join(c.dbPath, "..");
    const bytes = Buffer.concat(readdirSync(dir).map((n) => readFileSync(join(dir, n))));
    expect(bytes.includes(Buffer.from(EMAIL))).toBe(true);
    for (const code of codes) {
      expect(bytes.includes(Buffer.from(code))).toBe(false);
      expect(bytes.includes(Buffer.from(code.replaceAll("-", "")))).toBe(false);
    }
  });

  test("a code works once, also after a reopen; another unused code works", async () => {
    const { c, codes } = await enrolledConsole();
    const [first = "", second = ""] = codes;
    const a = await freshFactor(c);
    const ok = await a.factor({ recovery_code: first });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/");
    expect(
      c.logs.some((l) => l.includes('"factor":"recovery-code"') && l.includes('"remaining":9')),
    ).toBe(true);
    const b = await freshFactor(c);
    expect((await b.factor({ recovery_code: first })).status).toBe(401);
    const reopened = await startConsole({ dbPath: c.dbPath, clock: c.clock });
    const d = await freshFactor(reopened);
    expect(
      (await d.factor({ recovery_code: first.toUpperCase().replaceAll("-", " ") })).status,
    ).toBe(401);
    expect((await d.factor({ recovery_code: second })).status).toBe(303);
    expect(usedCount(c.dbPath)).toBe(2);
  });

  test("two browsers using one code concurrently give one 303 and one 401", async () => {
    const { c, codes } = await enrolledConsole();
    const code = codes[3] ?? "";
    const a = await freshFactor(c);
    const b = await freshFactor(c);
    const [pa, pb] = await Promise.all([a.get("/sign-in/factor"), b.get("/sign-in/factor")]);
    const replies = await Promise.all([
      a.post("/sign-in/factor", { csrf: csrfIn(pa.body), recovery_code: code }),
      b.post("/sign-in/factor", { csrf: csrfIn(pb.body), recovery_code: code }),
    ]);
    expect(replies.map((r) => r.status).sort((x, y) => x - y)).toEqual([303, 401]);
    expect(usedCount(c.dbPath)).toBe(1);
    expect(count(c.dbPath, "SELECT count(*) AS n FROM recovery_codes WHERE used_at IS NULL")).toBe(
      9,
    );
    const winner = replies[0]?.status === 303 ? a : b;
    const loser = winner === a ? b : a;
    expect((await winner.get("/")).status).toBe(200);
    expect((await loser.get("/")).status).toBe(303);
  });

  test("two servers on one file using one code concurrently give one 303 and one 401", async () => {
    const { c, codes } = await enrolledConsole();
    const code = codes[5] ?? "";
    const other = await startConsole({ dbPath: c.dbPath, clock: c.clock });
    const a = await freshFactor(c);
    const b = await freshFactor(other);
    const [pa, pb] = await Promise.all([a.get("/sign-in/factor"), b.get("/sign-in/factor")]);
    const replies = await Promise.all([
      a.post("/sign-in/factor", { csrf: csrfIn(pa.body), recovery_code: code }),
      b.post("/sign-in/factor", { csrf: csrfIn(pb.body), recovery_code: code }),
    ]);
    expect(replies.map((r) => r.status).sort((x, y) => x - y)).toEqual([303, 401]);
    expect(usedCount(c.dbPath)).toBe(1);
    const winner = replies[0]?.status === 303 ? a : b;
    const loser = winner === a ? b : a;
    expect((await winner.get("/")).status).toBe(200);
    expect((await loser.get("/")).status).toBe(303);
  });

  test("a wrong code of the same length is 401 and changes no row", async () => {
    const { c, codes } = await enrolledConsole();
    const wrong = changedCode(codes[0] ?? "");
    expect(codes).not.toContain(wrong);
    expect(wrong).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/);
    const client = await freshFactor(c);
    const res = await client.factor({ recovery_code: wrong });
    expect(res.status).toBe(401);
    expect(res.body).toContain("Wrong code.");
    expect(usedCount(c.dbPath)).toBe(0);
    expect((await client.factor({ recovery_code: codes[0] ?? "" })).status).toBe(303);
  });

  test("a recovery code never replaces the password", async () => {
    const { c, codes } = await enrolledConsole();
    const client = new Client(c);
    const page = await client.get("/sign-in");
    const res = await client.post("/sign-in", {
      csrf: csrfIn(page.body),
      email: EMAIL,
      password: codes[0] ?? "",
      next: "/",
    });
    expect(res.status).toBe(401);
    expect(usedCount(c.dbPath)).toBe(0);
  });
});

describe("new recovery codes", () => {
  async function fullClient(c: Console, seed: Buffer): Promise<Client> {
    c.clock.now += STEP_MS;
    const client = await freshFactor(c);
    expect((await client.factor({ code: totpCode(seed, stepAt(c.clock.now)) })).status).toBe(303);
    return client;
  }

  test("wrong or empty passwords change nothing; the new set replaces every old code", async () => {
    const { c, seed, codes: old } = await enrolledConsole();
    const owner = await fullClient(c, seed);
    const form = await owner.get("/account/recovery-codes");
    expect(form.status).toBe(200);
    expect(form.body).toContain("Your current recovery codes stop working.");
    expect(form.body).toContain("10 of 10 recovery codes left");
    const csrf = csrfIn(form.body);
    const before = digests(c.dbPath);
    const wrong = await owner.post("/account/recovery-codes", { csrf, password: "wrong-password" });
    expect(wrong.status).toBe(401);
    const empty = await owner.post("/account/recovery-codes", { csrf, password: "" });
    expect(empty.status).toBe(422);
    expect(digests(c.dbPath)).toEqual(before);

    const made = await owner.post("/account/recovery-codes", { csrf, password: PASSWORD });
    expect(made.status).toBe(200);
    const fresh = [...made.body.matchAll(/<li><code>([^<]+)<\/code><\/li>/g)].map(
      (m) => m[1] ?? "",
    );
    expect(fresh).toHaveLength(10);
    expect(new Set(fresh).size).toBe(10);
    for (const code of fresh) expect(code).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/);
    for (const code of old) expect(fresh).not.toContain(code);
    expect(digests(c.dbPath)).toEqual(fresh.map(digestOf).sort((x, y) => x.localeCompare(y)));
    expect(c.logs.some((l) => l.includes("recovery codes created"))).toBe(true);
    expect((await owner.get("/")).status).toBe(200);

    const statuses: number[] = [];
    let start = 0;
    for (const size of [4, 4, 2]) {
      const server = await startConsole({ dbPath: c.dbPath, clock: c.clock });
      const client = await freshFactor(server);
      for (const code of old.slice(start, start + size)) {
        const res = await client.factor({ recovery_code: code });
        statuses.push(res.status);
        for (const later of old) expect(res.body).not.toContain(later);
      }
      start += size;
    }
    expect(statuses).toEqual(Array.from({ length: 10 }, () => 401));
    const last = await freshFactor(await startConsole({ dbPath: c.dbPath, clock: c.clock }));
    const ok = await last.factor({ recovery_code: fresh[0] ?? "" });
    expect(ok.status).toBe(303);
  });
});
