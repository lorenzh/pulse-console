// A fake pulse-api for tests: one Bun server on 127.0.0.1 port 0 with a reply per path.

/** One reply of the fake api. `body` defaults to an upstream sentinel text. */
export type FakeReply = {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** When true, the reply never arrives (for timeout tests). */
  isHeld?: boolean;
};

/** One request the fake api received. */
export type FakeSeen = { path: string; authorization: string | null };

export type FakeApi = {
  url: string;
  seen: FakeSeen[];
  /** Sets the reply of `path` (for example `/checks`). */
  reply: (path: string, reply: FakeReply) => void;
  stop: () => void;
};

export const UPSTREAM_SENTINEL = "upstream-body-sentinel";
export const WIRE_HEADERS = { "x-pulse-contract": "1", "content-type": "application/json" };

/** A literal `/checks` element with the given state. */
export function checkWithState(id: string, state: string): Record<string, unknown> {
  return {
    id,
    name: id.toUpperCase(),
    url: "https://example.com",
    intervalMs: 60000,
    state,
    consecutiveDown: 0,
    lastResultAt: null,
    lastReason: null,
    locations: [],
    ...(state === "maintenance"
      ? { maintenance: { checkId: id, start: 0, end: 4102444800000, note: "Window" } }
      : {}),
  };
}

export const emptyConfig = {
  revision: `sha256-${"a".repeat(64)}`,
  checks: [],
  components: [],
  maintenance: [],
};

/** A `200` JSON reply with the wire header. */
export function jsonReply(body: unknown): FakeReply {
  return { status: 200, body: JSON.stringify(body), headers: WIRE_HEADERS };
}

export function startFakeApi(): FakeApi {
  const seen: FakeSeen[] = [];
  const replies = new Map<string, FakeReply>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ path, authorization: req.headers.get("authorization") });
      const reply = replies.get(path) ?? { status: 404 };
      if (reply.isHeld === true) {
        return new Promise<Response>(() => undefined);
      }
      return new Response(reply.body ?? UPSTREAM_SENTINEL, {
        status: reply.status,
        headers: reply.headers ?? {},
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    seen,
    reply(path, reply) {
      replies.set(path, reply);
    },
    stop() {
      void server.stop(true);
    },
  };
}
