import { Effect, Option, Schema } from "effect";
import { RecoveryCase } from "./recovery-case";
import { type ErasureScope, ErasureUnavailable } from "../../erasure-store/contract";
import type { ErasureRecoveryConfiguration } from "../contract";

const maximumCaseBytes = 32768;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
/** Persist independent evidence of the native drain before deleting source rows. An older D1's pending work must not be mistaken for a new provider instruction after recovery. */
export const sealRecoveryCase = (
  input: Readonly<{ configuration: ErasureRecoveryConfiguration; scope: ErasureScope }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const bucket = input.configuration.bucket;
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    const approved = yield* io(() =>
      input.configuration.db
        .prepare(`SELECT count(*) AS approved FROM erasure_requests WHERE id=? AND user_id=?
   AND state='Sealing' AND coordinator_cleared=1`)
        .bind(input.scope.reference, input.scope.userId)
        .first<number>("approved")
    );
    if (approved !== 1) return yield* new ErasureUnavailable();
    const key = `recovery/cases/${input.scope.reference}`;
    const object = yield* io(() => bucket.value.get(key));
    if (object === null) return yield* new ErasureUnavailable();
    if (object.size > maximumCaseBytes) {
      yield* io(() => object.body.cancel());
      return yield* new ErasureUnavailable();
    }
    const record = yield* Schema.decodeEffect(Schema.fromJsonString(RecoveryCase))(
      yield* io(() => object.text())
    );
    if (!matchesScope(record, input.scope)) {
      return yield* new ErasureUnavailable();
    }
    if (record.sealed) return;
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(RecoveryCase))({
      ...record,
      sealed: true,
    });
    const written = yield* io(() =>
      bucket.value.put(key, encoded, { onlyIf: { etagMatches: object.etag } })
    );
    if (written === null) return yield* new ErasureUnavailable();
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const matchesScope = (record: typeof RecoveryCase.Type, scope: ErasureScope): boolean =>
  record.decision.userId === scope.userId && record.decision.reference === scope.reference;
