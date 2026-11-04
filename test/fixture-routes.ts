// Test-only protected routes under /__test/. They use the real renderers and the real
// dispatcher; actions only go to the recorder here, never to pulse-api.
import { escapeHtml } from "@lorenzh/pulse-kit";
import type { ApiFailure } from "../src/api-failure.ts";
import {
  csrfField,
  field,
  formErrorSummary,
  formTokenField,
  paragraph,
  submitButton,
  textareaField,
} from "../src/html.ts";
import type { PageRequest, PageResult, ProtectedRoute } from "../src/protected-route.ts";
import {
  alreadySubmittedState,
  apiUnavailableState,
  emptyState,
  notFoundState,
  readOnlyState,
  staleState,
  tokenRejectedBanner,
} from "../src/states.ts";

/** The fake actions that fixture POSTs recorded, in order. */
export type Recorder = { actions: Record<string, string>[] };

export type FixtureOptions = {
  recorder: Recorder;
  /** Runs before the busy POST answers; e2e passes a real wait, `bun test` none. */
  wait?: (() => Promise<void>) | undefined;
};

function page(status: number, title: string, body: string, banner?: string): PageResult {
  return { kind: "page", status, title, body, banner };
}

function getRoute(path: string, render: () => PageResult): ProtectedRoute {
  return {
    path,
    methods: ["GET"],
    requiredRole: "viewer",
    handle: () => Promise.resolve(render()),
  };
}

function notice(text: string | undefined): string {
  return text === undefined ? "" : paragraph(text, ' role="alert"');
}

function busyForm(request: PageRequest, text?: string): string {
  return `${notice(text)}<form method="post" action="${escapeHtml(request.path)}">
${csrfField(request.csrf)}
${formTokenField(request.issueFormToken(request.path))}
${field({ label: "Choice", name: "choice", type: "text", autocomplete: "off", value: request.fields.choice })}
<div class="actions">${submitButton({ label: "Run", busyLabel: "Running…", name: "action", value: "go" })}</div>
</form>
`;
}

function busyRoute(options: FixtureOptions): ProtectedRoute {
  const path = "/__test/states/busy";
  return {
    path,
    methods: ["GET", "POST"],
    requiredRole: "viewer",
    knownFields: ["choice", "action"],
    handle: async (request) => {
      if (request.method !== "POST") return page(200, "Busy button", busyForm(request));
      await options.wait?.();
      const action = request.fields.action ?? "";
      options.recorder.actions.push({ action, choice: request.fields.choice ?? "" });
      const done = paragraph(`Submitted: ${action}`);
      return page(200, "Busy button", `${done}${busyForm(request)}`);
    },
    renderForm: (request, text) => page(200, "Busy button", busyForm(request, text)),
  };
}

type FieldErrors = { name?: string; note?: string };

function editForm(request: PageRequest, errors: FieldErrors = {}): string {
  const list = (["name", "note"] as const).flatMap((name) => {
    const text = errors[name];
    return text === undefined ? [] : [{ name, text }];
  });
  return `${formErrorSummary(list)}<form method="post" action="${escapeHtml(request.path)}">
${csrfField(request.csrf)}
${formTokenField(request.issueFormToken(request.path))}
${field({ label: "Name", name: "name", type: "text", autocomplete: "off", value: request.fields.name, error: errors.name })}
${textareaField({ label: "Note", name: "note", value: request.fields.note, error: errors.note })}
${field({ label: "Secret", name: "secret", type: "password", autocomplete: "off" })}
<div class="actions">${submitButton({ label: "Save", busyLabel: "Saving…" })}</div>
</form>
`;
}

/** A form route whose POST always answers `status` with `state` above the kept form. */
function editRoute(
  path: string,
  title: string,
  answer: (request: PageRequest) => PageResult,
): ProtectedRoute {
  return {
    path,
    methods: ["GET", "POST"],
    requiredRole: "viewer",
    knownFields: ["name", "note", "secret"],
    handle: (request) =>
      Promise.resolve(
        request.method === "POST" ? answer(request) : page(200, title, editForm(request)),
      ),
    renderForm: (request, text) => page(200, title, `${notice(text)}${editForm(request)}`),
  };
}

function conflictRoute(status: 409 | 412): ProtectedRoute {
  const path = `/__test/states/conflict-${status}`;
  return editRoute(path, "Edit", (request) =>
    page(status, "Edit", `${staleState({ status, reloadHref: path })}${editForm(request)}`),
  );
}

function invalidAnswer(request: PageRequest): PageResult {
  const errors = { name: "Enter a name.", note: "Enter a note." };
  return page(422, "Edit", editForm(request, errors));
}

const API_FAILURES: ReadonlyArray<[string, ApiFailure]> = [
  ["api-timeout", { kind: "timeout" }],
  ["api-network", { kind: "network", origin: "http://127.0.0.1:9" }],
  ["api-status", { kind: "http", call: "checks", status: 503 }],
];

/** Every state fixture of Required behavior 6, keyed by path. */
export function createFixtureRoutes(options: FixtureOptions): Map<string, ProtectedRoute> {
  const routes: ProtectedRoute[] = [
    getRoute("/__test/states/empty", () =>
      page(
        200,
        "Empty",
        emptyState({
          title: "Nothing here yet",
          text: "Add the first item.",
          action: { href: "/", label: "Go to the overview" },
        }),
      ),
    ),
    busyRoute(options),
    getRoute("/__test/states/already-submitted", () =>
      page(409, "Already submitted", alreadySubmittedState({ reopenHref: "/" })),
    ),
    ...API_FAILURES.map(([name, failure]) =>
      getRoute(`/__test/states/${name}`, () =>
        page(200, "Overview", apiUnavailableState(failure, `/__test/states/${name}`)),
      ),
    ),
    getRoute("/__test/states/token-rejected", () =>
      page(200, "Overview", paragraph("Summary hidden."), tokenRejectedBanner()),
    ),
    {
      ...getRoute("/__test/states/forbidden", () =>
        page(200, "Admin page", paragraph("Only admins see this.")),
      ),
      requiredRole: "admin",
    },
    getRoute("/__test/states/session-expired", () =>
      page(200, "Session page", paragraph("You are signed in.")),
    ),
    getRoute("/__test/states/not-found", () => page(404, "Page not found", notFoundState())),
    conflictRoute(409),
    conflictRoute(412),
    editRoute("/__test/states/invalid-422", "Edit", invalidAnswer),
    editRoute("/__test/states/read-only-503", "Edit", (request) =>
      page(503, "Edit", `${readOnlyState()}${editForm(request)}`),
    ),
  ];
  return new Map(routes.map((route) => [route.path, route]));
}
