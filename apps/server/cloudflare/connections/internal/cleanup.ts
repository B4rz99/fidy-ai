import { Schema } from "effect";

const maximumEnvelopeLength = 100000;

export const Candidate = Schema.Struct({
  attemptId: Schema.String,
  connectionId: Schema.String,
  userId: Schema.String,
  consentId: Schema.String,
  intentJson: Schema.String,
  accessSeen: Schema.Literals([0, 1]),
  refreshSeen: Schema.Literals([0, 1]),
  envelope: Schema.String.check(Schema.isBetweenLength(1, maximumEnvelopeLength)),
});
