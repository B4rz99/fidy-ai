import { Effect, Schema } from "effect";
import { prepareRecoveryDrain as subscription } from "../../subscription/operations";
import { prepareRecoveryDrain as emailAuthentication } from "../../email-authentication/operations";
import { prepareRecoveryDrain as hosted } from "../../agent/operations";
import { prepareRecoveryDrain as whatsapp } from "../../whatsapp/operations";
import { prepareRecoveryDrain as insights } from "../../insights/operations";
import { prepareRecoveryDrain as ingestion } from "../../ingestion/operations";
import { prepareRecoveryDrain as connections } from "../../connections/operations";
import { prepareRecoveryDrain as providerAuthentication } from "../../provider-authentication/operations";
import { prepareRecoveryDrain as consentIngress } from "../../consent/operations";
import { prepareRecoveryDrain as privateObjects } from "../../private-objects/operations";
import { RecoveryDrainObservation, RecoveryDrainUnavailable } from "../contract";

const queries = {
  subscription,
  emailAuthentication,
  hosted,
  whatsapp,
  insights,
  ingestion,
  connections,
  providerAuthentication,
  consentIngress,
  privateObjects,
};

/** The fixed owner projection is metadata only; it cannot manufacture platform completion. */
export const observe = ({
  db,
}: Readonly<{ db: D1Database }>): Effect.Effect<
  typeof RecoveryDrainObservation.Type,
  RecoveryDrainUnavailable
> =>
  Effect.gen(function* () {
    const entries = Object.entries(queries);
    const results = yield* Effect.tryPromise(() =>
      db.batch(entries.map(([, prepare]) => prepare(db)))
    );
    const owners = yield* Schema.decodeUnknownEffect(RecoveryDrainObservation.fields.owners)(
      Object.fromEntries(entries.map(([owner], index) => [owner, results[index]?.results[0]]))
    );
    const observations = Object.values(owners);
    const observation: typeof RecoveryDrainObservation.Type = {
      version: 1,
      coverage: "source-owner-intents-v1",
      pending: observations.reduce((total, owner) => total + owner.pending, 0),
      ambiguous: observations.reduce((total, owner) => total + owner.ambiguous, 0),
      owners,
    };
    return observation;
  }).pipe(Effect.mapError(() => new RecoveryDrainUnavailable()));
