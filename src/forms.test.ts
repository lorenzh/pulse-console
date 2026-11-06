/* eslint-disable sonarjs/no-clear-text-protocols -- loopback test servers and URL inputs under test */
import { describe, expect, test } from "bun:test";
import {
  checkApiUrl,
  checkEmail,
  checkName,
  isFormContentType,
  MAX_CHECK_FORM_BYTES,
  MAX_FORM_BYTES,
  MAX_INCIDENT_FORM_BYTES,
  MAX_MAINTENANCE_FORM_BYTES,
  parseForm,
  passwordText,
} from "./forms.ts";

describe("content type", () => {
  test("only the urlencoded form type is accepted", () => {
    expect(isFormContentType("application/x-www-form-urlencoded")).toBe(true);
    expect(isFormContentType("Application/X-WWW-Form-Urlencoded; charset=UTF-8")).toBe(true);
    expect(isFormContentType("application/json")).toBe(false);
    expect(isFormContentType("multipart/form-data")).toBe(false);
    expect(isFormContentType(undefined)).toBe(false);
  });
});

describe("parseForm", () => {
  test("reads known fields and ignores unknown ones", () => {
    expect(parseForm("email=a%40b.c&x=1&x=2", ["email", "csrf"])).toEqual({
      isOk: true,
      fields: { email: "a@b.c" },
      lists: {},
    });
  });
  test("a repeated known field fails", () => {
    expect(parseForm("email=a&email=b", ["email"])).toEqual({ isOk: false, repeated: "email" });
  });
});

describe("parseForm list fields", () => {
  const LIMITS = { component: 1000 };
  test("ordered distinct values survive, an absent list is empty", () => {
    expect(parseForm("component=db&title=T&component=api", ["title"], LIMITS)).toEqual({
      isOk: true,
      fields: { title: "T" },
      lists: { component: ["db", "api"] },
    });
    expect(parseForm("title=T", ["title"], LIMITS)).toEqual({
      isOk: true,
      fields: { title: "T" },
      lists: { component: [] },
    });
  });
  test("one value twice in a list fails", () => {
    expect(parseForm("component=web&component=web", [], LIMITS)).toEqual({
      isOk: false,
      repeated: "component",
    });
  });
  test("1000 distinct values fit a 1000-value limit; 1001 fail", () => {
    const body = (n: number): string =>
      Array.from({ length: n }, (_, i) => `component=c${i}`).join("&");
    const ok = parseForm(body(1000), [], LIMITS);
    expect(ok.isOk && ok.lists.component?.length).toBe(1000);
    expect(ok.isOk && ok.lists.component?.[999]).toBe("c999");
    expect(parseForm(body(1001), [], LIMITS)).toEqual({ isOk: false, repeated: "component" });
  });
  test("a known field, csrf or form_token, never becomes a list", () => {
    const known = ["title", "csrf", "form_token"];
    const limits = { title: 5, csrf: 5, form_token: 5 };
    for (const name of known) {
      expect(parseForm(`${name}=a&${name}=b`, known, limits)).toEqual({
        isOk: false,
        repeated: name,
      });
    }
    expect(parseForm("title=a&csrf=c&form_token=t", known, limits)).toEqual({
      isOk: true,
      fields: { title: "a", csrf: "c", form_token: "t" },
      lists: {},
    });
  });
});

describe("form limits", () => {
  test("the limits are 8192, 524288, 32768 and 131072 bytes", () => {
    expect(MAX_FORM_BYTES).toBe(8192);
    expect(MAX_CHECK_FORM_BYTES).toBe(524288);
    expect(MAX_INCIDENT_FORM_BYTES).toBe(32768);
    expect(MAX_MAINTENANCE_FORM_BYTES).toBe(131072);
  });
  test("the largest valid incident form fits 32768 bytes", () => {
    const emoji = "\u{1F600}";
    const params = new URLSearchParams({
      csrf: "c".repeat(43),
      form_token: "t".repeat(43),
      title: emoji.repeat(200),
      impact: "major_outage",
      status: "investigating",
      message: emoji.repeat(2000),
      action: "publish",
    });
    for (let i = 0; i < 50; i++) params.append("component", `${i}`.padStart(64, "a"));
    const bytes = new TextEncoder().encode(params.toString()).length;
    expect(bytes).toBeGreaterThan(30000);
    expect(bytes).toBeLessThanOrEqual(32768);
  });
});

describe("API URL", () => {
  test("invalid URLs are refused", () => {
    for (const raw of [
      "http://user:pw@api:3000",
      "http://api:3000/?a=1",
      "http://api:3000/#x",
      "ftp://api",
      "http://api\t:3000",
      "not a url",
    ]) {
      expect(checkApiUrl(raw)).toEqual({
        isOk: false,
        text: "Enter an http(s) URL without credentials, query or fragment.",
      });
    }
    expect(checkApiUrl(`http://api/${"a".repeat(2038)}`)).toEqual({
      isOk: false,
      text: "The URL must have at most 2048 characters.",
    });
    expect(checkApiUrl("")).toEqual({ isOk: false, text: "Enter the pulse-api URL." });
    expect(checkApiUrl(undefined)).toEqual({ isOk: false, text: "Enter the pulse-api URL." });
  });
  test("one trailing slash is dropped and a path prefix stays", () => {
    expect(checkApiUrl("http://api:3000/")).toEqual({ isOk: true, url: "http://api:3000" });
    expect(checkApiUrl(" http://api:3000/pulse/ ")).toEqual({
      isOk: true,
      url: "http://api:3000/pulse",
    });
    expect(checkApiUrl("\thttp://api:3000\n")).toEqual({ isOk: true, url: "http://api:3000" });
    expect(checkApiUrl("   ")).toEqual({ isOk: false, text: "Enter the pulse-api URL." });
    expect(checkApiUrl("http://api:3000/pulse/")).toEqual({
      isOk: true,
      url: "http://api:3000/pulse",
    });
    expect(checkApiUrl(`http://api/${"a".repeat(2037)}`).isOk).toBe(true);
  });
});

describe("email and name", () => {
  test("email is trimmed and lowercased", () => {
    expect(checkEmail("  Owner@Example.COM ")).toEqual({ isOk: true, email: "owner@example.com" });
  });
  test("invalid emails are refused", () => {
    for (const raw of [
      undefined,
      "",
      "a@",
      "@b",
      "a@b@c",
      "a b@c",
      "ab",
      `${"a".repeat(251)}@b.c`,
    ]) {
      expect(checkEmail(raw)).toEqual({ isOk: false, text: "Enter a valid email address." });
    }
  });
  test("names are trimmed with 1 to 100 characters and no control", () => {
    expect(checkName("  Ada  ")).toEqual({ isOk: true, name: "Ada" });
    for (const raw of [undefined, "   ", "a".repeat(101), "a\u0007b"]) {
      expect(checkName(raw)).toEqual({ isOk: false, text: "Enter a name of 1 to 100 characters." });
    }
  });
});

describe("password text", () => {
  test("maps each problem to its text", () => {
    expect(passwordText("a".repeat(11), "a".repeat(11))).toBe(
      "The password must have at least 12 characters.",
    );
    expect(passwordText("a".repeat(129), "a".repeat(129))).toBe(
      "The password must have at most 128 characters.",
    );
    expect(passwordText("a".repeat(12), "b".repeat(12))).toBe("The passwords do not match.");
    expect(passwordText("😀".repeat(12), "😀".repeat(12))).toBeUndefined();
    expect(passwordText(`  ${"a".repeat(10)}`, `  ${"a".repeat(10)}`)).toBeUndefined();
  });
});

test("form limits: 8192 by default, 524288 for the two check editor POSTs", () => {
  expect(MAX_FORM_BYTES).toBe(8192);
  expect(MAX_CHECK_FORM_BYTES).toBe(524288);
});
