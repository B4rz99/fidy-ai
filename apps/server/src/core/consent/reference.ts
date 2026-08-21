import { Schema } from "effect";

/** Stable identity of one append-only ConsentRecord. */
export const ConsentRecordId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("ConsentRecordId"))
  .annotate({ identifier: "ConsentRecordId" });
export type ConsentRecordId = typeof ConsentRecordId.Type;

/** Immutable source-control identifier of one full policy version. */
export const PolicyRevision = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u)
)
  .pipe(Schema.brand("PolicyRevision"))
  .annotate({ identifier: "PolicyRevision" });
export type PolicyRevision = typeof PolicyRevision.Type;

/** Immutable identifier of the shorter disclosure presented in chat. */
export const DisclosureRevision = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u)
)
  .pipe(Schema.brand("DisclosureRevision"))
  .annotate({ identifier: "DisclosureRevision" });
export type DisclosureRevision = typeof DisclosureRevision.Type;

/** Lowercase SHA-256 digest that pins exact source-controlled content bytes. */
export const Sha256Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
  .pipe(Schema.brand("Sha256Digest"))
  .annotate({ identifier: "Sha256Digest" });
export type Sha256Digest = typeof Sha256Digest.Type;
