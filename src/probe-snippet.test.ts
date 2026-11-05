/* eslint-disable sonarjs/no-clear-text-protocols -- the URLs are snippet values under test; no request is made */
import { describe, expect, test } from "bun:test";
import {
  checkLocation,
  checkProbeApiUrl,
  checkProbeImage,
  checkProbeName,
  checkProbeNetwork,
  composeFile,
  composeRestartCommand,
  composeStopCommand,
  composeUpCommand,
  dockerRemoveCommand,
  dockerRunCommand,
  envCommand,
  locationSlug,
  type ProbeSnippetInput,
  probeBase,
} from "./probe-snippet.ts";

const TOKEN_ID = "tok_0000000000000000000a1b2c3";
const SECRET = "pulse_s3cretSECRETs3cret0000000000";

const REMOTE: ProbeSnippetInput = {
  location: "eu-west",
  apiUrl: "https://pulse.example",
  image: "ghcr.io/lorenzh/pulse-probe:1",
  network: "",
  tokenId: TOKEN_ID,
};
const LOCAL: ProbeSnippetInput = { ...REMOTE, network: "pulse_default" };

describe("names", () => {
  test("slug and base follow the rule", () => {
    expect(locationSlug("Ünïcode Zone/1")).toBe("n-code-zone-1");
    expect(locationSlug("!!!")).toBe("location");
    expect(locationSlug("")).toBe("location");
    expect(locationSlug("EU West")).toBe("eu-west");
    expect(locationSlug(`${"a".repeat(31)}-bbb`)).toBe("a".repeat(31));
    expect(locationSlug("x".repeat(40))).toBe("x".repeat(32));
    expect(probeBase("Ünïcode Zone/1", TOKEN_ID)).toBe("pulse-probe-n-code-zone-1-a1b2c3");
    expect(probeBase("!!!", TOKEN_ID)).toBe("pulse-probe-location-a1b2c3");
  });
});

describe("field rules", () => {
  test("location", () => {
    expect(checkLocation("  eu  ")).toEqual({ isValid: true, value: "eu" });
    expect(checkLocation("a".repeat(64))).toEqual({ isValid: true, value: "a".repeat(64) });
    for (const bad of ["heartbeat", "a".repeat(65), "eu\u0007", "", "   ", "eu\u0085"]) {
      expect(checkLocation(bad).isValid).toBe(false);
    }
    expect(checkLocation("Heartbeat").isValid).toBe(true);
  });

  test("name defaults to probe <location>", () => {
    expect(checkProbeName(" ", "eu")).toEqual({ isValid: true, value: "probe eu" });
    expect(checkProbeName(" ops ", "eu")).toEqual({ isValid: true, value: "ops" });
    expect(checkProbeName("a".repeat(101), "eu").isValid).toBe(false);
    expect(checkProbeName("a\u0000b", "eu").isValid).toBe(false);
  });

  test("api url", () => {
    expect(checkProbeApiUrl("https://pulse.example/")).toEqual({
      isValid: true,
      value: "https://pulse.example",
    });
    expect(checkProbeApiUrl("http://api:3000/base/")).toEqual({
      isValid: true,
      value: "http://api:3000/base",
    });
    for (const bad of [
      "",
      "ftp://api",
      "http://u:p@api",
      "http://api/?",
      "http://api/?a=1",
      "http://api/#x",
      "http://api/a b",
      "not a url",
      "javascript:alert(1)",
      `http://api/${"a".repeat(2040)}`,
    ]) {
      expect(checkProbeApiUrl(bad).isValid).toBe(false);
    }
  });

  test("image", () => {
    expect(checkProbeImage("ghcr.io/x/probe@sha256:ab").isValid).toBe(true);
    expect(checkProbeImage("a".repeat(255)).isValid).toBe(true);
    for (const bad of ["", "-x", ".x", "a b", "a$b", "a".repeat(256), "a'b"]) {
      expect(checkProbeImage(bad).isValid).toBe(false);
    }
  });

  test("network", () => {
    expect(checkProbeNetwork("")).toEqual({ isValid: true, value: "" });
    expect(checkProbeNetwork("pulse_default").isValid).toBe(true);
    expect(checkProbeNetwork(`a${"b".repeat(127)}`).isValid).toBe(true);
    for (const bad of ["-net", `a${"b".repeat(128)}`, "a b", "a/b"]) {
      expect(checkProbeNetwork(bad).isValid).toBe(false);
    }
  });
});

describe("snippets", () => {
  test("env command holds the secret once", () => {
    const line = envCommand("pulse-probe-eu-west-a1b2c3", SECRET);
    expect(line).toBe(
      "(umask 077 && printf '%s\\n' 'PULSE_PROBE_TOKEN=pulse_s3cretSECRETs3cret0000000000' > 'pulse-probe-eu-west-a1b2c3.env')",
    );
    expect(line.split(SECRET).length - 1).toBe(1);
  });

  test("docker run without a network", () => {
    expect(dockerRunCommand(REMOTE)).toBe(
      [
        "docker run -d --name 'pulse-probe-eu-west-a1b2c3' --restart unless-stopped \\",
        "  --security-opt no-new-privileges:true --cap-drop ALL \\",
        "  --env-file 'pulse-probe-eu-west-a1b2c3.env' \\",
        "  -e 'PULSE_API_URL=https://pulse.example' \\",
        "  -e 'PULSE_LOCATION=eu-west' \\",
        "  -e 'PULSE_PROBE_BLOCK_PRIVATE_RANGES=false' \\",
        "  'ghcr.io/lorenzh/pulse-probe:1'",
      ].join("\n"),
    );
  });

  test("docker run with a network", () => {
    expect(dockerRunCommand(LOCAL)).toBe(
      [
        "docker run -d --name 'pulse-probe-eu-west-a1b2c3' --restart unless-stopped \\",
        "  --security-opt no-new-privileges:true --cap-drop ALL \\",
        "  --network 'pulse_default' \\",
        "  --env-file 'pulse-probe-eu-west-a1b2c3.env' \\",
        "  -e 'PULSE_API_URL=https://pulse.example' \\",
        "  -e 'PULSE_LOCATION=eu-west' \\",
        "  -e 'PULSE_PROBE_BLOCK_PRIVATE_RANGES=false' \\",
        "  'ghcr.io/lorenzh/pulse-probe:1'",
      ].join("\n"),
    );
  });

  test("compose file without a network has no networks keys", () => {
    expect(composeFile(REMOTE)).toBe(
      [
        'name: "pulse-probe-eu-west-a1b2c3"',
        "services:",
        "  probe:",
        '    image: "ghcr.io/lorenzh/pulse-probe:1"',
        "    restart: unless-stopped",
        '    security_opt: ["no-new-privileges:true"]',
        "    cap_drop: [ALL]",
        '    env_file: ["pulse-probe-eu-west-a1b2c3.env"]',
        "    environment:",
        '      PULSE_API_URL: "https://pulse.example"',
        '      PULSE_LOCATION: "eu-west"',
        '      PULSE_PROBE_BLOCK_PRIVATE_RANGES: "false"',
        "",
      ].join("\n"),
    );
  });

  test("compose file with a network", () => {
    expect(composeFile(LOCAL)).toBe(
      [
        'name: "pulse-probe-eu-west-a1b2c3"',
        "services:",
        "  probe:",
        '    image: "ghcr.io/lorenzh/pulse-probe:1"',
        "    restart: unless-stopped",
        '    security_opt: ["no-new-privileges:true"]',
        "    cap_drop: [ALL]",
        '    env_file: ["pulse-probe-eu-west-a1b2c3.env"]',
        "    environment:",
        '      PULSE_API_URL: "https://pulse.example"',
        '      PULSE_LOCATION: "eu-west"',
        '      PULSE_PROBE_BLOCK_PRIVATE_RANGES: "false"',
        "    networks: [pulse]",
        "networks:",
        "  pulse:",
        "    external: true",
        '    name: "pulse_default"',
        "",
      ].join("\n"),
    );
  });

  test("compose start, restart, stop and docker rm lines carry -p and -f", () => {
    const base = "pulse-probe-eu-west-a1b2c3";
    expect(composeUpCommand(base)).toBe(
      "docker compose -p 'pulse-probe-eu-west-a1b2c3' -f 'pulse-probe-eu-west-a1b2c3.compose.yaml' up -d",
    );
    expect(composeRestartCommand(base)).toBe(
      "docker compose -p 'pulse-probe-eu-west-a1b2c3' -f 'pulse-probe-eu-west-a1b2c3.compose.yaml' up -d --force-recreate",
    );
    expect(composeStopCommand(base)).toBe(
      "docker compose -p 'pulse-probe-eu-west-a1b2c3' -f 'pulse-probe-eu-west-a1b2c3.compose.yaml' down",
    );
    expect(dockerRemoveCommand(base)).toBe("docker rm -f 'pulse-probe-eu-west-a1b2c3'");
  });

  test("shell quoting keeps it's and $(id) literal", () => {
    const run = dockerRunCommand({ ...REMOTE, location: "it's $(id)" });
    expect(run).toContain("  -e 'PULSE_LOCATION=it'\\''s $(id)' \\\n");
    expect(run).toContain("--name 'pulse-probe-it-s-id-a1b2c3'");
  });

  test("yaml quoting escapes quotes and doubles $", () => {
    const file = composeFile({ ...REMOTE, location: 'a"b$HOME' });
    expect(file).toContain('      PULSE_LOCATION: "a\\"b$$HOME"\n');
  });

  test("names stay stable on rotate: they depend only on location and token id", () => {
    const base = probeBase("eu-west", TOKEN_ID);
    expect(base).toBe("pulse-probe-eu-west-a1b2c3");
    expect(envCommand(base, "pulse_other").endsWith("> 'pulse-probe-eu-west-a1b2c3.env')")).toBe(
      true,
    );
  });

  test("no snippet but the env command holds the secret, and none says =true", () => {
    for (const input of [REMOTE, LOCAL]) {
      const base = probeBase(input.location, input.tokenId);
      for (const text of [dockerRunCommand(input), composeFile(input), composeUpCommand(base)]) {
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain("=true");
        expect(text).not.toContain(': "true"');
      }
    }
  });
});
