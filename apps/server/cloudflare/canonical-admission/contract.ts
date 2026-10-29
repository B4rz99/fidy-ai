import { Data, type Effect } from "effect";
import type { WebSessionAuthority } from "../../src/shell/web-session/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import type { OAuthCaller } from "../../src/shell/oauth-agents/contract";
import type { AuthorizedPAT } from "../tokens/contract";
import type { AuthenticatedWebSession } from "../web-session/contract";

/** An owner-prepared unmetered browser read; presentation follows the complete protected batch.
 * The operation is deliberately closed to the Category listing until other policies are proved.
 */
export type PreparedCanonicalBrowserRead = Readonly<{
  statements: ReadonlyArray<D1PreparedStatement>;
  /** Bounded response encoding only; no storage or provider work after the atomic snapshot. */
  present: (results: ReadonlyArray<D1Result>) => Effect.Effect<Response>;
}>;

export type CanonicalBrowserRead = (
  input: Readonly<{
    db: D1Database;
    authority: WebSessionAuthority;
    /** Admission-owned live credential selection, valid only in this native snapshot. */
    reservation: OwnedStatement;
    current: number;
  }>
) => PreparedCanonicalBrowserRead;

/** Authorization is supplied by the credential owner, never inferred from an allowance or a retry key. */
export type AuthorizedCanonicalCaller = Readonly<
  | { _tag: "PAT"; value: AuthorizedPAT }
  | { _tag: "WebSession"; value: AuthenticatedWebSession }
  | { _tag: "OAuth"; value: OAuthCaller }
>;

/** Private dependency failure without SQL or credential disclosure. */
export class CanonicalAdmissionUnavailable extends Data.TaggedError(
  "CanonicalAdmissionUnavailable"
)<{ readonly cause: unknown }> {}

/** One stable User shares the initial API protection envelope, irrespective of credentials or AccessTier. */
export const canonicalRequestProtection = {
  intervalMs: 1000,
  burst: 10,
  concurrency: 2,
  leaseMs: 90000,
  retryAfterSeconds: 1,
} as const;
