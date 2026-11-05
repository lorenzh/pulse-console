import { expect, test } from "bun:test";
import {
  linkDigest,
  linkOfPath,
  linkOrigin,
  linkPathLabel,
  linkUrl,
  newLinkToken,
} from "./account-links.ts";

const TOKEN = "A".repeat(43);

test("a link path is /invite/ or /reset/ plus exactly 43 base64url characters", () => {
  expect(linkOfPath(`/invite/${TOKEN}`)).toEqual({ kind: "invite", token: TOKEN });
  expect(linkOfPath(`/reset/${"a-_9".repeat(10)}xyz`)).toEqual({
    kind: "reset",
    token: `${"a-_9".repeat(10)}xyz`,
  });
  for (const path of [
    `/invite/${TOKEN}/`,
    `/invite/${"A".repeat(42)}`,
    `/invite/${"A".repeat(44)}`,
    `/invite/%41${"A".repeat(40)}`,
    "/invite/%2e%2e",
    `//invite/${TOKEN}`,
    `/invite/${TOKEN}/x`,
    `/invites/${TOKEN}`,
    `/invite/${"A".repeat(42)}=`,
    "/invite/",
  ]) {
    expect(linkOfPath(path)).toBeUndefined();
  }
});

test("the label of a link path never holds the token", () => {
  expect(linkPathLabel("invite")).toBe("/invite/:token");
  expect(linkPathLabel("reset")).toBe("/reset/:token");
});

test("a new token is 32 bytes as base64url, 43 characters", () => {
  expect(newLinkToken((size) => new Uint8Array(size))).toBe(TOKEN);
  expect(newLinkToken((size) => new Uint8Array(size).fill(255))).toBe(`${"_".repeat(42)}8`);
});

test("the digest is the SHA-256 hex of the token", () => {
  expect(linkDigest("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("links start with the public origin, else http:// and the request Host", () => {
  expect(linkOrigin("https://console.example.com", "evil.example")).toBe(
    "https://console.example.com",
  );
  expect(linkOrigin(undefined, "127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  expect(linkUrl("http://localhost:1", "invite", TOKEN)).toBe(`http://localhost:1/invite/${TOKEN}`);
});
