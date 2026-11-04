import { unfinishedFinancialDeletion } from "./source-readiness";
import { Effect, Schema } from "effect";
import { ErasureRecoveryDrain } from "../contract";
import { ErasureUnavailable } from "../../erasure-store/contract";

/** Physical deletion readiness is separate from retained ExternalPending custody and native Promise drain. */
export const observe = ({
  db,
}: Readonly<{ db: D1Database }>): Effect.Effect<ErasureRecoveryDrain, ErasureUnavailable> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(`SELECT
      (SELECT count(*) FROM erasure_requests q WHERE ${unfinishedFinancialDeletion}) AS pending,
      (SELECT count(*) FROM erasure_requests WHERE state='ExternalPending') AS externalPending`)
          .first(),
      catch: () => new ErasureUnavailable(),
    });
    return yield* Schema.decodeUnknownEffect(ErasureRecoveryDrain)(row);
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
