import { Option } from "effect";
import { protectConsentAuthority } from "~/shell/consent/operations";
import type { CanonicalCapability } from "~/core/canonical-operations/contract";
import type { PATAuthority } from "./contract";

export type { PATAuthority } from "./contract";

/** The stable User and exact scope whose held PAT must still authorize work at commit time. */
export type PATSubject = Readonly<{
  patId: string;
  userId: string;
  digest: Uint8Array;
  requiredScope: Option.Option<CanonicalCapability>;
}>;
const liveCredentialPredicate = `id = ? AND user_id = ? AND bearer_digest = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?`;

/** The live bearer, lifetime, and Consent decision without a scope clause; classification only. */
export const livePATCredential = ({
  subject,
  current,
}: Readonly<{ subject: PATSubject; current: number }>): PATAuthority =>
  protectConsentAuthority({
    authority: {
      table: "pats",
      predicate: liveCredentialPredicate,
      bindings: [subject.patId, subject.userId, subject.digest, current],
    },
    subject: { _tag: "Owner", column: "pats.user_id" },
    requirement: "unrevoked",
  });

/** Guard protected D1 work with the exact live bearer, Consent, and scope decision. */
export const livePATAuthority = ({
  subject,
  current,
}: Readonly<{ subject: PATSubject; current: number }>): PATAuthority => {
  const credential = livePATCredential({ subject, current });
  return {
    ...credential,
    predicate: `${credential.predicate}
      AND ${Option.isSome(subject.requiredScope) ? "EXISTS (SELECT 1 FROM json_each(pats.scopes_json) WHERE value = ?)" : "0"}`,
    bindings: [...credential.bindings, ...Option.toArray(subject.requiredScope)],
  };
};
