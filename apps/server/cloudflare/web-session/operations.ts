import { bindingResponse } from "./internal/binding";
import { type Effect, Option, Schema } from "effect";
import { WebSessionId } from "../../src/core/web-session/contract";
import { browserSessionBindingHeader } from "../../src/shell/web-session/contract";
import type {
  FreshSessionSubject,
  WebSessionAuthority,
} from "../../src/shell/web-session/contract";
import { completePairing, logout } from "./internal/lifecycle";
import { currentUser } from "./internal/current-user";
import type {
  AuthenticatedWebSession,
  BoundWebSessionLookup,
  WebSessionAuthentication,
  WebSessionEstablishment,
  WebSessionRequest,
} from "./contract";
import { authenticate, decodeSessionLookup, prepareSessionLookup } from "./internal/authentication";

/** Prepare exact cookie, mounted identity, expiry and Consent proof for one atomic admission batch. */
export const prepareBoundCanonicalWebSession = (
  input: Readonly<{ request: Request; current: number }>
): Promise<Option.Option<BoundWebSessionLookup>> => {
  const binding = Schema.decodeUnknownOption(WebSessionId)(
    input.request.headers.get(browserSessionBindingHeader)
  );
  return Option.isNone(binding)
    ? Promise.resolve(Option.none())
    : prepareSessionLookup({ ...input, binding, freshness: "live", requireConsent: true });
};

/** Decode only the row returned by the exact prepared lookup; later work must recheck authority. */
export const resolveBoundCanonicalWebSession = (
  input: Readonly<{ lookup: BoundWebSessionLookup; row: unknown }>
): Option.Option<AuthenticatedWebSession> => decodeSessionLookup(input);

/** Compose the exact mounted credential and Consent lookup into its caller's single native read. */
export const boundCanonicalWebSessionAuthority = (
  lookup: BoundWebSessionLookup
): WebSessionAuthority => lookup.authority;

/**
 * Authenticate one browser cookie against authoritative expiry, revocation and optional freshness.
 * Duplicate or malformed credentials fail closed. Resolution neither renews the session nor grants
 * reusable authority; protected work must recheck the returned proof in its own atomic unit.
 */
export const authenticateWebSession = (
  input: WebSessionAuthentication
): Promise<Option.Option<AuthenticatedWebSession>> =>
  authenticate({ ...input, requireConsent: false });

/**
 * Revoke only the presented credential at the caller's Clock and expire its browser cookie;
 * absence is indistinguishable. Cancellation waits for an already-started revocation to settle.
 */
export const logoutWebSession = (input: WebSessionRequest): Effect.Effect<Response, void> =>
  logout(input);

/**
 * Consume one approved, unexpired BrowserLoginPairing and issue a fresh independent bearer once.
 * The BrowserLogin owner supplies exact-proof consumption and its bound User projection. Those
 * operations and issuance commit together; replay cannot reissue credentials or change ownership.
 */
export const establishWebSession = (
  input: WebSessionEstablishment
): Effect.Effect<Response, void> => completePairing(input);

/**
 * Renew live browser use within immutable hard expiry at the caller's Clock and return the
 * canonical User projection. Cancellation settles a started renewal or Audit but stops later work.
 */
export const currentWebSessionUser = (input: WebSessionRequest): Effect.Effect<Response> =>
  currentUser(input);

/** Resolve one live or fresh browser session for account-security composition. */
export const browserSession = (
  input: WebSessionRequest & Readonly<{ input: Readonly<{ current: number; fresh: boolean }> }>
): Promise<Option.Option<FreshSessionSubject>> =>
  authenticate({ ...inputWithFreshness(input), requireConsent: false }).then((session) =>
    Option.map(session, (subject) => ({ id: subject.id, user_id: subject.userId }))
  );

const inputWithFreshness = (
  input: WebSessionRequest & Readonly<{ input: Readonly<{ current: number; fresh: boolean }> }>
): WebSessionAuthentication => ({
  request: input.request,
  db: input.db,
  current: input.input.current,
  freshness: input.input.fresh ? "fresh" : "live",
});

/** Recheck browser freshness at account-security admission; commit-time guards remain required. */
export const freshBrowserSession = (
  input: WebSessionRequest & Readonly<{ current: number }>
): Promise<Option.Option<FreshSessionSubject>> =>
  browserSession({ ...input, input: { current: input.current, fresh: true } });

/** Resolve canonical browser authority while observing current Consent in the same read. */
export const authenticateCanonicalWebSession = (
  input: WebSessionRequest & Readonly<{ current: number }>
): Promise<Option.Option<AuthenticatedWebSession>> =>
  authenticate({ ...input, freshness: "live", requireConsent: true });

/** Check browser lifetime binding at private HTTP ingress; correlation never replaces the cookie. */
export const browserSessionBindingResponse = (
  input: WebSessionRequest
): Effect.Effect<Option.Option<Response>> => bindingResponse(input);
