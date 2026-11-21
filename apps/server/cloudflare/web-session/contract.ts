import type { WebSessionAuthority, WebSessionSubject } from "../../src/shell/web-session/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";

export type AuthenticatedWebSession = WebSessionSubject;

export type BoundWebSessionLookup = Readonly<{
  statement: OwnedStatement;
  digest: Uint8Array;
  authority: WebSessionAuthority;
}>;
