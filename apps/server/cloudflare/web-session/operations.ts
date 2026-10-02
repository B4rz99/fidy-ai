import { Effect, Option } from "effect";
import type { FreshSessionSubject } from "@fidy/server/web-session-contract";
import { completePairing, logout } from "./internal/lifecycle";
import { currentUser } from "./internal/current-user";
import type {
  AuthenticatedWebSession,
  WebSessionAuthentication,
  WebSessionEstablishment,
  WebSessionRequest,
} from "./contract";
import { authenticate } from "./internal/authentication";

/**
 * Authenticate one browser cookie against authoritative expiry, revocation and optional freshness.
 * Duplicate or malformed credentials fail closed. Resolution neither renews the session nor grants
 * reusable authority; protected work must recheck the returned proof in its own atomic unit.
 */
export const authenticateWebSession = (
  input: WebSessionAuthentication
): Promise<Option.Option<AuthenticatedWebSession>> =>
  authenticate({ ...input, requireConsent: false });

/** Revoke only the presented credential and expire its browser cookie; absence is indistinguishable. */
export const logoutWebSession = (input: WebSessionRequest): Promise<Response> => logout(input);

/**
 * Consume one approved, unexpired BrowserLoginPairing and issue a fresh independent bearer once.
 * The BrowserLogin owner supplies exact-proof consumption and its bound User projection. Those
 * operations and issuance commit together; replay cannot reissue credentials or change ownership.
 */
export const establishWebSession = (input: WebSessionEstablishment): Promise<Response> =>
  Effect.runPromise(completePairing(input));

/** Renew live browser use within immutable hard expiry and return the canonical User projection. */
export const currentWebSessionUser = (input: WebSessionRequest): Promise<Response> =>
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
