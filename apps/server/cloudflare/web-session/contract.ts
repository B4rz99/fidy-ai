import type { BrowserPairingClaim } from "../browser-login/contract";
import type { WebSessionAuthority, WebSessionSubject } from "../../src/shell/web-session/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";

export type WebSessionAuthentication = Readonly<{
  request: Request;
  db: D1Database;
  current: number;
  freshness: "live" | "fresh";
}>;

export type AuthenticatedWebSession = WebSessionSubject;

export type BoundWebSessionLookup = Readonly<{
  statement: OwnedStatement;
  digest: Uint8Array;
  authority: WebSessionAuthority;
}>;

export type WebSessionRequest = Readonly<{ request: Request; db: D1Database }>;

export type WebSessionEstablishment = Readonly<{ db: D1Database; claim: BrowserPairingClaim }>;
