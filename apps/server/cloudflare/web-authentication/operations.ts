import { EmailAuthenticationGroup } from "../../src/shell/email-authentication/contract";
import { currentUser, logoutBrowser } from "@fidy/server/web-session-runtime";
import { Effect } from "effect";
import { redeemBrowserPairing, startBrowserPairing } from "../browser-login/operations";
import {
  completeBrowserPairingEmail,
  completeEmailReplacement,
  requestEmailReplacement,
  startBrowserPairingEmail,
} from "../email-authentication/operations";
import { rotateBackupRecoveryCode } from "../recovery/operations";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

const emailReplacementOperations = {
  request: EmailAuthenticationGroup.endpoints.requestEmailReplacement,
  complete: EmailAuthenticationGroup.endpoints.completeEmailReplacement,
};

type BrowserExecution = Readonly<{
  request: Request;
  db: D1Database;
  publish: (owner: "browserPairing" | "emailReplacement", id: string) => void;
}>;
type BrowserHandler = Readonly<{
  path: string;
  method: string;
  handle: () => Promise<Response>;
}>;

const browserHandlers = ({
  request,
  db,
  publish,
}: BrowserExecution): ReadonlyArray<BrowserHandler> => [
  { path: "/web/pairings", method: "POST", handle: () => startBrowserPairing(db) },
  {
    path: "/web/pairings/redeem",
    method: "POST",
    handle: () => redeemBrowserPairing({ request, db }),
  },
  { path: "/web/session/logout", method: "POST", handle: () => logoutBrowser({ request, db }) },
  {
    path: "/recovery/backup-code/rotate",
    method: "POST",
    handle: () => rotateBackupRecoveryCode({ request, db }),
  },
  {
    path: "/web/email/authentication/start",
    method: "POST",
    handle: () =>
      startBrowserPairingEmail({ request, db, onAccepted: (id) => publish("browserPairing", id) }),
  },
  {
    path: "/web/email/authentication/complete",
    method: "POST",
    handle: () => completeBrowserPairingEmail({ request, db }),
  },
  {
    path: emailReplacementOperations.request.path,
    method: emailReplacementOperations.request.method,
    handle: () =>
      requestEmailReplacement({ request, db, onAccepted: (id) => publish("emailReplacement", id) }),
  },
  {
    path: emailReplacementOperations.complete.path,
    method: emailReplacementOperations.complete.method,
    handle: () => completeEmailReplacement({ request, db }),
  },
  { path: "/user", method: "GET", handle: () => currentUser({ request, db }) },
];

/**
 * Execute the browser authentication protocol through its owners. Proof validation, subject
 * resolution, and atomic state changes remain with each owner; this coordinator owns no gateway.
 * Publication offers follow acceptance and never establish authority. Unknown paths or wrong
 * methods cannot run an owner operation. Owner rejection becomes the existing closed unavailable
 * response, without exposing a credential, database failure, or provider payload.
 */
export const handleWebAuthentication = (input: BrowserExecution): Effect.Effect<Response> => {
  const path = new URL(input.request.url).pathname;
  const route = browserHandlers(input).find((candidate) => candidate.path === path);
  if (route === undefined || input.request.method !== route.method) {
    return Effect.succeed(
      new Response('{"status":"method_not_allowed"}', {
        headers: { ...jsonHeaders, allow: "GET" },
        status: 405,
      })
    );
  }
  const work = Effect.tryPromise({ try: route.handle, catch: () => undefined }).pipe(
    Effect.orElseSucceed(
      () =>
        new Response('{"status":"unavailable"}', {
          headers: jsonHeaders,
          status: 503,
        })
    )
  );
  return path === emailReplacementOperations.request.path ||
    path === emailReplacementOperations.complete.path
    ? work.pipe(Effect.withSpan("emailReplacement.browser"))
    : work;
};
