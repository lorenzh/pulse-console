import { linkDigest, linkPathLabel } from "./account-links.ts";
import type { NewSessionOptions } from "./account-store.ts";
import { checkName, passwordText } from "./forms.ts";
import {
  anonBinding,
  type Ctx,
  ensureCsrf,
  readPostForm,
  redirect,
  sendHtml,
} from "./http-context.ts";
import { alreadySubmittedPage, messagePage } from "./pages.ts";
import { formExpiredResendNotice } from "./states.ts";
import { acceptInvitePage, linkNotValidPage } from "./team-pages.ts";
import type { LiveInvite } from "./team-store.ts";
import { isSecondFactorRequired, signInStage } from "./two-factor-policy.ts";

/** Starts a session after a committed acceptance, rotating the request's session cookie. */
export type StartSession = (ctx: Ctx, userId: number, options: NewSessionOptions) => void;

const ACCEPT_FIELDS = ["name", "password", "password_confirm", "form_token"] as const;

type AcceptView = {
  csrf: string;
  invite: LiveInvite;
  name?: string | undefined;
  errors?: Partial<Record<"name" | "password", string | undefined>> | undefined;
  notice?: string | undefined;
};

/** A fresh form token bound to the anonymous CSRF value and the raw link path; HEAD stores none. */
function issueToken(ctx: Ctx, csrf: string): string {
  return ctx.req.method === "HEAD" ? "" : ctx.state.formTokens.issue(anonBinding(csrf), ctx.path);
}

function acceptPage(ctx: Ctx, view: AcceptView): string {
  return acceptInvitePage({
    action: ctx.path,
    csrf: view.csrf,
    formToken: issueToken(ctx, view.csrf),
    email: view.invite.email,
    role: view.invite.role,
    name: view.name,
    errors: view.errors,
    notice: view.notice,
  });
}

function liveInviteOf(ctx: Ctx, token: string): LiveInvite | undefined {
  return ctx.deps.teamStore.liveInvite(linkDigest(token), ctx.deps.now());
}

/**
 * `GET /invite/<token>`: the accept form of a live invite, else the invalid-link page. Only a
 * valid link sets the anonymous CSRF cookie and issues a form token.
 */
export function sendInviteForm(ctx: Ctx, token: string): void {
  const invite = liveInviteOf(ctx, token);
  if (invite === undefined) {
    sendHtml(ctx, 404, linkNotValidPage());
    return;
  }
  sendHtml(ctx, 200, acceptPage(ctx, { csrf: ensureCsrf(ctx), invite }));
}

/** The form-token step; the link lookup ran before it, so a used link never reaches it. */
function isTokenAccepted(ctx: Ctx, view: AcceptView, token: string | undefined): boolean {
  const result = ctx.state.formTokens.consume(token ?? "", anonBinding(view.csrf), ctx.path);
  if (result === "accepted") return true;
  ctx.deps.log.info("form token refused", { reason: result, path: linkPathLabel("invite") });
  const page =
    result === "replayed"
      ? alreadySubmittedPage("/sign-in")
      : acceptPage(ctx, { ...view, notice: formExpiredResendNotice });
  sendHtml(ctx, 409, page);
  return false;
}

/**
 * `POST /invite/<token>`: the POST order with the anonymous CSRF cookie, the link lookup, the
 * fields, the form token, the password hash, then one transaction. A session starts only after
 * the commit.
 */
export async function postInvite(
  ctx: Ctx,
  token: string,
  startSession: StartSession,
): Promise<void> {
  const fields = await readPostForm(ctx, ACCEPT_FIELDS);
  if (fields === undefined) return;
  const invite = liveInviteOf(ctx, token);
  if (invite === undefined) {
    sendHtml(ctx, 404, linkNotValidPage());
    return;
  }
  const view: AcceptView = { csrf: fields.csrf ?? "", invite, name: fields.name };
  const name = checkName(fields.name);
  const password = fields.password ?? "";
  const passwordError = passwordText(password, fields.password_confirm ?? "");
  if (!name.isOk || passwordError !== undefined) {
    const errors = { name: name.isOk ? undefined : name.text, password: passwordError };
    sendHtml(ctx, 422, acceptPage(ctx, { ...view, errors }));
    return;
  }
  if (!isTokenAccepted(ctx, view, fields.form_token)) return;
  await commitAcceptance(ctx, token, { view, name: name.name, password }, startSession);
}

async function commitAcceptance(
  ctx: Ctx,
  token: string,
  input: { view: AcceptView; name: string; password: string },
  startSession: StartSession,
): Promise<void> {
  const { deps } = ctx;
  const passwordHash = await deps.hashPassword(input.password);
  let result: ReturnType<typeof deps.teamStore.acceptInvite>;
  try {
    result = deps.teamStore.acceptInvite({
      tokenDigest: linkDigest(token),
      name: input.name,
      passwordHash,
      now: deps.now(),
    });
  } catch (err) {
    deps.log.error("team change could not be saved", {
      error: err instanceof Error ? err.name : "unknown",
    });
    sendHtml(ctx, 500, messagePage("Not saved", "The change could not be saved."));
    return;
  }
  if (!result.ok) {
    if (result.reason === "invalid") sendHtml(ctx, 404, linkNotValidPage());
    else {
      const notice = "An account with this email exists.";
      sendHtml(ctx, 409, acceptPage(ctx, { ...input.view, notice }));
    }
    return;
  }
  deps.log.info("team change", {
    action: "invite.accept",
    actorId: result.userId,
    targetId: result.userId,
  });
  const organisation = {
    isRequiredForAll: deps.store.instance()?.isTwoFactorRequiredForAll === true,
  };
  const stage = signInStage({
    isRequired: isSecondFactorRequired({ role: result.role }, organisation),
    hasAuthenticator: false,
  });
  startSession(ctx, result.userId, { stage });
  redirect(ctx, stage === "enrol" ? "/account/authenticator" : "/");
}
