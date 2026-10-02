import type { BrowserPairingClaim } from "../browser-login/contract";
import type { WebSessionSubject } from "@fidy/server/web-session-contract";

/** Browser credentials are resolved at use; a returned subject is never a cached authorization. */
export type WebSessionAuthentication = Readonly<{
  request: Request;
  db: D1Database;
  current: number;
  freshness: "live" | "fresh";
}>;

/** The exact credential proof to recheck inside protected work, never an HTTP response body. */
export type AuthenticatedWebSession = WebSessionSubject;

/** One incoming browser request at the private Core Worker boundary. */
export type WebSessionRequest = Readonly<{ request: Request; db: D1Database }>;

/** Pairing owner work committed with its one-time WebSession issuance. */
export type WebSessionEstablishment = Readonly<{ db: D1Database; claim: BrowserPairingClaim }>;
