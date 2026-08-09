import { Effect, Schema } from "effect";
import { SentryOperatorEvidence } from "./account-policy";
import { strictDecoding } from "./decoding";

/** Bounded evidence-input failure that cannot retain rejected account values. */
export class SentryEvidenceReadError extends Schema.TaggedErrorClass<SentryEvidenceReadError>()(
  "SentryEvidenceReadError",
  { reason: Schema.Literals(["unreadable", "invalid", "too-large"]) }
) {}

const EvidenceJson = Schema.fromJsonString(SentryOperatorEvidence);
const maximumEvidenceBytes = 65_536;

/** Decodes private operator evidence while replacing all schema diagnostics with a fixed error. */
export const decodeSentryOperatorEvidence = (
  json: string
): Effect.Effect<SentryOperatorEvidence, SentryEvidenceReadError> =>
  Schema.decodeUnknownEffect(EvidenceJson, { ...strictDecoding, errors: "all" })(json).pipe(
    Effect.mapError(() => SentryEvidenceReadError.make({ reason: "invalid" }))
  );

/** Reads a bounded private evidence blob and returns only decoded policy evidence or fixed errors. */
export const readSentryOperatorEvidence = (
  file: Blob
): Effect.Effect<SentryOperatorEvidence, SentryEvidenceReadError> => {
  if (file.size > maximumEvidenceBytes) {
    return Effect.fail(SentryEvidenceReadError.make({ reason: "too-large" }));
  }
  return Effect.tryPromise({
    try: () => file.text(),
    catch: () => SentryEvidenceReadError.make({ reason: "unreadable" }),
  }).pipe(Effect.flatMap(decodeSentryOperatorEvidence));
};
