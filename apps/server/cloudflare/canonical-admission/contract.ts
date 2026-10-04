import { Data } from "effect";
import type { AuthorizedPAT } from "../tokens/contract";
import type { AuthenticatedWebSession } from "../web-session/contract";

/** Authorization is supplied by the credential owner, never inferred from an allowance or a retry key. */
export type AuthorizedCanonicalCaller = Readonly<
  { _tag: "PAT"; value: AuthorizedPAT } | { _tag: "WebSession"; value: AuthenticatedWebSession }
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
