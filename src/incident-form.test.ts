import { describe, expect, test } from "bun:test";
import {
  composerBody,
  incidentConfirmName,
  incidentTitleText,
  isUntitledIncident,
  resolveBody,
  updateBody,
} from "./incident-form.ts";

const KNOWN = new Set(["web", "public-api"]);
const base = {
  title: "Slow",
  impact: "minor",
  status: "investigating",
  components: [],
  message: "m",
};

describe("untitled incidents", () => {
  test.each(["   ", "　", "​", "́"])("%p is untitled", (title) => {
    expect(isUntitledIncident(title)).toBe(true);
  });
  test.each([" Slow", "😀", "-"])("%p is titled", (title) => {
    expect(isUntitledIncident(title)).toBe(false);
  });
  test("confirm name and title text", () => {
    expect(incidentConfirmName(12, "   ")).toBe("Incident 12");
    expect(incidentConfirmName(12, "Slow checkout")).toBe("Slow checkout");
    expect(incidentTitleText(12, "​")).toBe("Untitled incident #12");
  });
  test("the composer refuses a new untitled title", () => {
    expect(composerBody({ ...base, title: "   " }, KNOWN)).toEqual({
      ok: false,
      errors: { title: "The title needs at least one letter, digit, punctuation mark or symbol." },
    });
  });
});

describe("composer body", () => {
  test("CRLF becomes LF and the title is not trimmed", () => {
    const result = composerBody({ ...base, title: " Slow", message: "a\r\nb\rc" }, KNOWN);
    expect(result).toEqual({
      ok: true,
      body: {
        title: " Slow",
        impact: "minor",
        componentIds: [],
        status: "investigating",
        message: "a\nb\nc",
      },
    });
  });
  test.each(['"😀".repeat(1000)+"x"', '"a".repeat(1999)+"😀"', '"😀".repeat(2000)'])(
    "message %s passes",
    (name) => {
      const messages: Record<string, string> = {
        '"😀".repeat(1000)+"x"': `${"😀".repeat(1000)}x`,
        '"a".repeat(1999)+"😀"': `${"a".repeat(1999)}😀`,
        '"😀".repeat(2000)': "😀".repeat(2000),
      };
      expect(composerBody({ ...base, message: messages[name] ?? "" }, KNOWN).ok).toBe(true);
    },
  );
  test("title of 200 emoji passes, 201 fails on the title", () => {
    expect(composerBody({ ...base, title: "😀".repeat(200) }, KNOWN).ok).toBe(true);
    expect(composerBody({ ...base, title: "😀".repeat(201) }, KNOWN)).toEqual({
      ok: false,
      errors: { title: "must be 1..200 characters" },
    });
  });
  test.each([["x".repeat(2001)], [`${"a".repeat(2000)}😀`], ["😀".repeat(2001)]])(
    "an over-limit message fails",
    (message) => {
      expect(composerBody({ ...base, message }, KNOWN)).toEqual({
        ok: false,
        errors: { message: "must be 1..2000 characters" },
      });
    },
  );
  test("an unknown component is refused", () => {
    expect(composerBody({ ...base, components: ["gone"] }, KNOWN)).toEqual({
      ok: false,
      errors: { component: "Component gone is not configured any more." },
    });
  });
});

describe("update and resolve bodies", () => {
  test("forged status resolved is refused", () => {
    expect(updateBody("resolved", "m")).toEqual({
      ok: false,
      errors: { status: "Use Resolve to resolve an incident." },
    });
  });
  test("update and resolve normalize CRLF", () => {
    expect(updateBody("identified", "a\r\nb")).toEqual({
      ok: true,
      body: { status: "identified", message: "a\nb" },
    });
    expect(resolveBody("Resolved.\r\n")).toEqual({ ok: true, body: { message: "Resolved.\n" } });
    expect(resolveBody("")).toEqual({
      ok: false,
      errors: { message: "must be 1..2000 characters" },
    });
  });
});
