import { Data, Schema } from "effect";

export class RecoveryOperationUnavailable extends Data.TaggedError(
  "RecoveryOperationUnavailable"
) {}

export type RecoveryOperationLease = Readonly<{
  assertOpen: () => Promise<void>;
  complete: () => Promise<void>;
}>;

const maximumEpochLength = 128;
export const RecoveryWorkEnvelope = Schema.Struct({
  recoveryEpoch: Schema.String.check(Schema.isBetweenLength(1, maximumEpochLength)),
  work: Schema.Unknown,
});
