import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database.ts";
import { appendPeopleEvent, PeopleLogError } from "./people-log.ts";

const dirs: string[] = [];
const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fresh(): Database {
  const dir = mkdtempSync(join(tmpdir(), "console-people-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "console.db"), {
    createFile: (path, mode) => closeSync(openSync(path, "wx", mode)),
    chmod: chmodSync,
  });
  dbs.push(db);
  return db;
}

const OWNER = { id: 1, email: "owner@example.com", name: "Owner" };
const MEMBER = { id: 2, email: "m@example.com", name: "Mo" };

function rows(db: Database): unknown[] {
  return db.query("SELECT * FROM people_events ORDER BY id").all();
}

test("appends user, invite, instance and container events with literal columns", () => {
  const db = fresh();
  appendPeopleEvent(db, {
    at: 10,
    actor: { kind: "user", person: OWNER },
    action: "user.role-change",
    target: { kind: "user", person: MEMBER },
    fromRole: "member",
    toRole: "viewer",
  });
  appendPeopleEvent(db, {
    at: 11,
    actor: { kind: "user", person: OWNER },
    action: "invite.create",
    target: { kind: "invite", id: 4, email: "new@example.com" },
    toRole: "admin",
  });
  appendPeopleEvent(db, {
    at: 12,
    actor: { kind: "user", person: OWNER },
    action: "team.require-2fa",
    target: { kind: "instance" },
    value: "on",
  });
  appendPeopleEvent(db, {
    at: 13,
    actor: { kind: "container" },
    action: "owner.recovery-link",
    target: { kind: "user", person: OWNER },
  });
  const base = {
    actor_user_id: null,
    actor_email: null,
    actor_name: null,
    target_id: null,
    target_email: null,
    target_name: null,
    from_role: null,
    to_role: null,
    value: null,
  };
  const owner = { actor_user_id: 1, actor_email: "owner@example.com", actor_name: "Owner" };
  expect(rows(db)).toEqual([
    {
      ...base,
      ...owner,
      id: 1,
      at: 10,
      actor_kind: "user",
      action: "user.role-change",
      target_kind: "user",
      target_id: 2,
      target_email: "m@example.com",
      target_name: "Mo",
      from_role: "member",
      to_role: "viewer",
    },
    {
      ...base,
      ...owner,
      id: 2,
      at: 11,
      actor_kind: "user",
      action: "invite.create",
      target_kind: "invite",
      target_id: 4,
      target_email: "new@example.com",
      to_role: "admin",
    },
    {
      ...base,
      ...owner,
      id: 3,
      at: 12,
      actor_kind: "user",
      action: "team.require-2fa",
      target_kind: "instance",
      value: "on",
    },
    {
      ...base,
      id: 4,
      at: 13,
      actor_kind: "container",
      action: "owner.recovery-link",
      target_kind: "user",
      target_id: 1,
      target_email: "owner@example.com",
      target_name: "Owner",
    },
  ]);
});

test("rows are append-only", () => {
  const db = fresh();
  appendPeopleEvent(db, {
    at: 1,
    actor: { kind: "container" },
    action: "owner.recover",
    target: { kind: "user", person: OWNER },
    value: "owner-recovery",
  });
  expect(() => db.run("UPDATE people_events SET value = 'x'")).toThrow(
    "people_events is append-only",
  );
  expect(() => db.run("DELETE FROM people_events")).toThrow("people_events is append-only");
  expect(rows(db)).toHaveLength(1);
});

test("a failed insert rolls back the change of its transaction", () => {
  const db = fresh();
  db.run("INSERT INTO instance (id, api_url, setup_completed_at) VALUES (1, 'http://api:3000', 1)");
  db.run(
    "CREATE TRIGGER people_events_fail BEFORE INSERT ON people_events BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  const change = db.transaction(() => {
    db.run("UPDATE instance SET require_2fa_all = 1");
    appendPeopleEvent(db, {
      at: 1,
      actor: { kind: "user", person: OWNER },
      action: "team.require-2fa",
      target: { kind: "instance" },
      value: "on",
    });
  });
  let caught: unknown;
  try {
    change.immediate();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(PeopleLogError);
  expect(caught instanceof Error ? caught.name : "").toBe("PeopleLogError");
  expect(db.query("SELECT require_2fa_all AS v FROM instance").get()).toEqual({ v: 0 });
  expect(rows(db)).toHaveLength(0);
});
