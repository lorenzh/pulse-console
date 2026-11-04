/* eslint-disable sonarjs/no-clear-text-protocols -- loopback test servers and URL inputs under test */
import { describe, expect, test } from "bun:test";
import {
  expectedOrigin,
  isCsrfTokenValid,
  isLoopbackHost,
  isOriginAllowed,
  safeNext,
} from "./request-guard.ts";

describe("loopback Host", () => {
  test("accepts loopback names with an optional port", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]", "localhost:8082", "[::1]:1"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });
  test("refuses other names", () => {
    for (const host of [undefined, "", "evil.example:8082", "127.0.0.2", "localhost.evil", "::1"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("Origin", () => {
  test("loopback mode expects http://<Host>", () => {
    expect(expectedOrigin("loopback", "localhost:8082", undefined)).toBe("http://localhost:8082");
    expect(expectedOrigin("loopback", undefined, undefined)).toBeUndefined();
  });
  test("strict modes expect the public origin", () => {
    expect(expectedOrigin("strict-https", "x", "https://console.example.com")).toBe(
      "https://console.example.com",
    );
    expect(expectedOrigin("strict-http", "x", "http://console.lan")).toBe("http://console.lan");
  });
  test("missing, null or different origins are refused", () => {
    expect(isOriginAllowed(undefined, "http://localhost:8082")).toBe(false);
    expect(isOriginAllowed("null", "http://localhost:8082")).toBe(false);
    expect(isOriginAllowed("http://127.0.0.1:8082", "http://localhost:8082")).toBe(false);
    expect(isOriginAllowed("http://console.example.com", "https://console.example.com")).toBe(
      false,
    );
    expect(isOriginAllowed("http://localhost:8082", undefined)).toBe(false);
    expect(isOriginAllowed("http://localhost:8082", "http://localhost:8082")).toBe(true);
  });
});

describe("CSRF token", () => {
  test("only an equal token matches", () => {
    expect(isCsrfTokenValid("abcdef", "abcdef")).toBe(true);
    expect(isCsrfTokenValid("abcdeg", "abcdef")).toBe(false);
    expect(isCsrfTokenValid("abcde", "abcdef")).toBe(false);
    expect(isCsrfTokenValid(undefined, "abcdef")).toBe(false);
    expect(isCsrfTokenValid("abcdef", undefined)).toBe(false);
    expect(isCsrfTokenValid("", "")).toBe(false);
  });
});

describe("next", () => {
  test("unsafe values become /", () => {
    for (const value of [
      undefined,
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      "/a b",
      `/${"a".repeat(512)}`,
      "",
    ]) {
      expect(safeNext(value)).toBe("/");
    }
  });
  test("same-site paths are kept", () => {
    expect(safeNext("/")).toBe("/");
    expect(safeNext("/checks?x=1")).toBe("/checks?x=1");
    expect(safeNext(`/${"a".repeat(511)}`)).toBe(`/${"a".repeat(511)}`);
  });
});
