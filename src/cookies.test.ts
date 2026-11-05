import { describe, expect, test } from "bun:test";
import {
  readCookie,
  serializeCookie,
  serializeCookieDeletion,
  serializeSessionCookie,
} from "./cookies.ts";

describe("serialize", () => {
  test("loopback and strict-http: plain names, no Secure, no Domain", () => {
    for (const mode of ["loopback", "strict-http"] as const) {
      expect(serializeCookie("session", "s1", mode)).toBe(
        "pulse_console_session=s1; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000",
      );
      expect(serializeCookie("setup", "g1", mode)).toBe(
        "pulse_console_setup=g1; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800",
      );
      expect(serializeCookie("csrf", "c1", mode)).toBe(
        "pulse_console_csrf=c1; Path=/; HttpOnly; SameSite=Strict",
      );
      expect(serializeCookieDeletion("session", mode)).toBe(
        "pulse_console_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
      );
    }
  });

  test("strict-https: __Host- prefix and Secure", () => {
    expect(serializeCookie("session", "s1", "strict-https")).toBe(
      "__Host-pulse_console_session=s1; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=2592000",
    );
    expect(serializeCookie("setup", "g1", "strict-https")).toBe(
      "__Host-pulse_console_setup=g1; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=1800",
    );
    expect(serializeCookie("csrf", "c1", "strict-https")).toBe(
      "__Host-pulse_console_csrf=c1; Path=/; HttpOnly; SameSite=Strict; Secure",
    );
    expect(serializeCookieDeletion("csrf", "strict-https")).toBe(
      "__Host-pulse_console_csrf=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0",
    );
  });

  test("a session refresh keeps the value", () => {
    const value = "abc_DEF-123";
    expect(serializeCookie("session", value, "loopback")).toBe(
      "pulse_console_session=abc_DEF-123; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000",
    );
  });
});

describe("read", () => {
  test("finds the mode's name; the first repeat wins; empty and missing are undefined", () => {
    const header = "a=1; pulse_console_session=s1; pulse_console_session=s2; pulse_console_csrf=";
    expect(readCookie(header, "session", "loopback")).toBe("s1");
    expect(readCookie(header, "csrf", "loopback")).toBeUndefined();
    expect(readCookie(header, "setup", "loopback")).toBeUndefined();
    expect(readCookie(header, "session", "strict-https")).toBeUndefined();
    expect(readCookie("__Host-pulse_console_session=h; junk", "session", "strict-https")).toBe("h");
    expect(readCookie(null, "session", "loopback")).toBeUndefined();
    expect(readCookie(undefined, "session", "loopback")).toBeUndefined();
  });
});

describe("session cookie of a stage", () => {
  test("partial stages get Max-Age=900, full keeps 30 days", () => {
    expect(serializeSessionCookie("s1", "factor", "loopback")).toBe(
      "pulse_console_session=s1; Path=/; HttpOnly; SameSite=Strict; Max-Age=900",
    );
    expect(serializeSessionCookie("s1", "enrol", "strict-https")).toBe(
      "__Host-pulse_console_session=s1; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=900",
    );
    expect(serializeSessionCookie("s1", "full", "loopback")).toBe(
      "pulse_console_session=s1; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000",
    );
  });
});
