import { Option, Schema } from "effect";
import {
  type RecoveryLifecycleEnvironment,
  RecoveryOperationUnavailable,
  RecoveryWorkMetadata,
} from "../contract";

/** Job authority follows the selected immutable target; legacy unqualified fixtures have no epoch. */
export const epoch = (environment: RecoveryLifecycleEnvironment): Option.Option<string> => {
  const source = Option.fromUndefinedOr(environment.RECOVERY_SOURCE_EPOCH);
  const store = Option.fromUndefinedOr(environment.SQLITE_STORE_EPOCH);
  if (Option.isSome(source) && Option.isSome(store) && source.value !== store.value) {
    throw new RecoveryOperationUnavailable();
  }
  const epoch = Option.orElse(source, () => store);
  return Option.map(
    epoch,
    (value) => Schema.decodeSync(RecoveryWorkMetadata)({ recoveryEpoch: value }).recoveryEpoch
  );
};

const WorkMetadataPresence = Schema.Struct({ recoveryEpoch: Schema.Unknown });
/** Stale or unstamped durable work is refused before a store or provider can be reached. */
export const check = ({
  environment,
  payload,
}: Readonly<{
  environment: RecoveryLifecycleEnvironment;
  payload: unknown;
}>): void => {
  const expected = epoch(environment);
  const metadata = Schema.decodeUnknownOption(RecoveryWorkMetadata)(payload);
  if (Option.isNone(expected)) {
    if (Option.isSome(Schema.decodeUnknownOption(WorkMetadataPresence)(payload))) {
      throw new RecoveryOperationUnavailable();
    }
    return;
  }
  if (Option.isNone(metadata) || metadata.value.recoveryEpoch !== expected.value) {
    throw new RecoveryOperationUnavailable();
  }
};
