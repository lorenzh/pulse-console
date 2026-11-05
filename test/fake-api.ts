// A fake pulse-api for tests: one Bun server on 127.0.0.1 port 0 with a reply per path, or per
// method and path. It records every request in order.

/** One reply of the fake api. `body` defaults to an upstream sentinel text. */
export type FakeReply = {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** When true, the reply never arrives (for timeout tests). */
  isHeld?: boolean;
  /** When set, the reply waits until this promise resolves. */
  gate?: Promise<void>;
};

/** One request the fake api received. */
export type FakeSeen = {
  method: string;
  path: string;
  /** The path as it reached the server, before any decoding. */
  rawPath: string;
  query: string;
  authorization: string | null;
  headers: Record<string, string>;
  body: string;
};

export type FakeApi = {
  url: string;
  seen: FakeSeen[];
  /** Sets the reply of `path` (for example `/checks`). */
  reply: (path: string, reply: FakeReply) => void;
  /** Sets the reply of one method on `path`; it wins over the reply of `reply(path)`. */
  replyTo: (method: string, path: string, reply: FakeReply) => void;
  /** Resolves once the fake api has received a request for `path`. */
  received: (path: string) => Promise<void>;
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
  const methodReplies = new Map<string, FakeReply>();
  const waiters: Array<{ path: string; resolve: () => void }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const afterOrigin = req.url.slice(url.origin.length);
      const rawPath = afterOrigin.split("?")[0] ?? "";
      seen.push({
        method: req.method,
        path,
        rawPath,
        query: url.search,
        authorization: req.headers.get("authorization"),
        headers: Object.fromEntries(req.headers.entries()),
        body: await req.text(),
      });
      for (const waiter of waiters.filter((w) => w.path === path)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
      const reply = methodReplies.get(`${req.method} ${path}`) ??
        replies.get(path) ?? { status: 404 };
      if (reply.isHeld === true) {
        return new Promise<Response>(() => undefined);
      }
      if (reply.gate !== undefined) await reply.gate;
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
    replyTo(method, path, reply) {
      methodReplies.set(`${method} ${path}`, reply);
    },
    received(path) {
      if (seen.some((s) => s.path === path)) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push({ path, resolve }));
    },
    stop() {
      void server.stop(true);
    },
  };
}
