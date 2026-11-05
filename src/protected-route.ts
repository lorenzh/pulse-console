import type { User } from "./account-store.ts";
import type { NavId } from "./navigation.ts";
import type { ConsoleRole } from "./roles.ts";

export type PageMethod = "GET" | "HEAD" | "POST";

/** One request to a protected route, after every check of the dispatcher. */
export type PageRequest = {
  method: PageMethod;
  /** The raw request path. */
  path: string;
  user: User;
  /** The server's role of the user, never a value from the request. */
  role: ConsoleRole;
  /** The session CSRF token, for the `csrf` field of a rendered form. */
  csrf: string;
  /** The known fields of a POST body; empty for GET and HEAD. */
  fields: Readonly<Partial<Record<string, string>>>;
  query: URLSearchParams;
  /** A fresh form token bound to this session and `actionPath`; empty for HEAD. */
  issueFormToken: (actionPath: string) => string;
};

/** A page inside the shell, or a redirect. */
export type PageResult =
  | {
      kind: "page";
      status: number;
      title: string;
      body: string;
      banner?: string | undefined;
    }
  | { kind: "redirect"; location: string };

export type ProtectedRoute = {
  path: string;
  /** GET implies HEAD. */
  methods: readonly PageMethod[];
  requiredRole: ConsoleRole;
  navId?: NavId | undefined;
  /** The POST fields of the route; the dispatcher adds `csrf` and `form_token`. */
  knownFields?: readonly string[] | undefined;
  handle: (request: PageRequest) => Promise<PageResult>;
  /** The GET form with the kept non-secret fields and `notice`, without any action. */
  renderForm?: ((request: PageRequest, notice: string) => PageResult) | undefined;
};
