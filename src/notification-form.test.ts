import { describe, expect, test } from "bun:test";
import type { NotifyDatabaseChannelView } from "@lorenzh/pulse-contract";
import {
  channelInputOf,
  NUMBER_INVALID_TEXT,
  parseChannelForm,
  SWITCH_INVALID_TEXT,
  TYPE_INVALID_TEXT,
} from "./notification-form.ts";

const stamps = { createdAt: 1, updatedAt: 2, source: "database" } as const;

function definitionOf(channel: NotifyDatabaseChannelView): Record<string, unknown> {
  return Object.fromEntries(Object.entries(channel).filter(([key]) => !(key in stamps)));
}

describe("parseChannelForm", () => {
  test("an email channel keeps only its own fields and adds the env prefix", () => {
    const parsed = parseChannelForm({
      id: "mail",
      type: "email",
      url_env: "IGNORED",
      smtp_host: "smtp.example.com",
      smtp_port: "587",
      smtp_tls: "starttls",
      smtp_username: "pulse",
      smtp_password_env: "PULSE_NOTIFY_SECRET_SMTP",
      smtp_client_name: "pulse.example.com",
      from: "Pulse <pulse@example.com>",
      to: "a@example.com\r\n\r\nb@example.com",
      subject_prefix: "[pulse]",
      status_url: "https://status.example.com",
      hide_reason: "on",
      remind_every_seconds: "600",
      alert_tls_expiry: "on",
      send_incidents: "off",
    });
    expect(parsed).toEqual({
      isOk: true,
      definition: {
        id: "mail",
        type: "email",
        remindEverySeconds: 600,
        alerts: ["tls-expiry"],
        sendIncidents: false,
        smtp: {
          host: "smtp.example.com",
          port: 587,
          tls: "starttls",
          username: "pulse",
          passwordEnv: "PULSE_NOTIFY_SECRET_SMTP",
          clientName: "pulse.example.com",
        },
        from: "Pulse <pulse@example.com>",
        to: ["a@example.com", "b@example.com"],
        subjectPrefix: "[pulse]",
        statusUrl: "https://status.example.com",
        hideReason: true,
      },
    });
  });

  test("a slack channel takes a url file reference", () => {
    expect(parseChannelForm({ id: "s", type: "slack", url_file: "slack.txt" })).toEqual({
      isOk: true,
      definition: { id: "s", type: "slack", urlFile: "slack.txt" },
    });
  });

  test.each([
    [{ id: "x", type: "file" }, "type", TYPE_INVALID_TEXT],
    [
      { id: "x", type: "webhook", url_env: "A", remind_every_seconds: "1e3" },
      "remind_every_seconds",
      NUMBER_INVALID_TEXT,
    ],
    [
      { id: "x", type: "webhook", url_env: "A", send_incidents: "yes" },
      "send_incidents",
      SWITCH_INVALID_TEXT,
    ],
  ])("%o fails on %s", (input, name, text) => {
    expect(parseChannelForm(input)).toEqual({ isOk: false, errors: [{ name, text }] });
  });

  test("the contract validator decides the rest", () => {
    const parsed = parseChannelForm({ id: "x", type: "webhook", url_env: "A", url_file: "b" });
    expect(parsed.isOk).toBe(false);
  });
});

describe("channelInputOf", () => {
  test("a stored webhook round-trips through the form", () => {
    const channel: NotifyDatabaseChannelView = {
      id: "w",
      type: "webhook",
      urlEnv: "PULSE_NOTIFY_SECRET_HOOK",
      secretFile: "sig.txt",
      checks: ["a", "b"],
      alerts: ["budget-low"],
      sendIncidents: true,
      ...stamps,
    };
    const input = channelInputOf(channel);
    expect(input.url_env).toBe("HOOK");
    expect(input.checks).toBe("a\nb");
    expect(input.alert_budget_low).toBe("on");
    expect(input.send_incidents).toBe("on");
    const definition = definitionOf(channel);
    const parsed = parseChannelForm(input);
    const actual: unknown = parsed.isOk ? parsed.definition : undefined;
    expect(actual).toEqual(definition);
  });

  test("stored email and teams channels round-trip", () => {
    const email: NotifyDatabaseChannelView = {
      id: "e",
      type: "email",
      smtp: { host: "h", port: 25, passwordFile: "pw" },
      from: "a@example.com",
      to: ["b@example.com"],
      hideReason: false,
      ...stamps,
    };
    const teams: NotifyDatabaseChannelView = {
      id: "t",
      type: "teams",
      urlEnv: "PULSE_NOTIFY_SECRET_T",
      statusUrl: "https://s.example.com",
      ...stamps,
    };
    for (const channel of [email, teams]) {
      const definition = definitionOf(channel);
      const parsed = parseChannelForm(channelInputOf(channel));
      const actual: unknown = parsed.isOk ? parsed.definition : undefined;
      expect(actual).toEqual(definition);
    }
  });
});
