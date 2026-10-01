import { Option } from "effect";
import type { CanonicalCapability } from "~/core/canonical-operations/contract";

/** The stable User and exact scope whose held PAT must still authorize work at commit time. */
export type PATSubject = Readonly<{
  patId: string;
  userId: string;
  digest: Uint8Array;
  requiredScope: Option.Option<CanonicalCapability>;
}>;
/** One live-authority gate over the `pats` table: its table, predicate, and bindings. */
export type PATAuthority = Readonly<{
  table: "pats";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;
const liveCredentialPredicate = `id = ? AND user_id = ? AND bearer_digest = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
  AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = pats.user_id)`;

/** The live bearer, lifetime, and Consent decision without a scope clause; classification only. */
export const livePATCredential = ({
  subject,
  current,
}: Readonly<{ subject: PATSubject; current: number }>): PATAuthority => ({
  table: "pats",
  predicate: liveCredentialPredicate,
  bindings: [subject.patId, subject.userId, subject.digest, current],
});

/** Guard protected D1 work with the exact live bearer, Consent, and scope decision. */
export const livePATAuthority = ({
  subject,
  current,
}: Readonly<{ subject: PATSubject; current: number }>): PATAuthority => ({
  table: "pats",
  predicate: `${liveCredentialPredicate}
    AND ${Option.isSome(subject.requiredScope) ? "EXISTS (SELECT 1 FROM json_each(pats.scopes_json) WHERE value = ?)" : "0"}`,
  bindings: [
    subject.patId,
    subject.userId,
    subject.digest,
    current,
    ...Option.toArray(subject.requiredScope),
  ],
});
