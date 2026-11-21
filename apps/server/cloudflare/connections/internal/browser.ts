import { Clock, DateTime, Effect, Option, Schema } from "effect";
import {
  ConnectionAuthorizationHandoff,
  ConnectionContinuationReview,
} from "../../../src/shell/connections/contract";
import { Connection } from "../../../src/core/connections/contract";
import { transactionNoStore } from "../../canonical-work/operations";

const missingStatus = 404;

const ContinuationRow = Schema.Struct({
  ...Connection.fields,
  expiresAtMilliseconds: Schema.Int,
  phase: Schema.Literals(["ready", "preparing", "prepared", "failed"]),
  handoffUrl: Schema.NullOr(Schema.String),
  handoffExpiresAt: Schema.NullOr(Schema.Int),
});

export const continuationFailure = (status: number): Response =>
  Response.json(
    { error: { code: "continuation_unavailable" } },
    { status, headers: transactionNoStore }
  );

export const present = (candidate: unknown): Effect.Effect<Response, Schema.SchemaError> =>
  Effect.gen(function* () {
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ContinuationRow))(candidate);
    const row = Option.fromUndefinedOr(rows[0]);

    if (Option.isNone(row)) return continuationFailure(missingStatus);
    const now = yield* Clock.currentTimeMillis;
    const expired = row.value.handoffExpiresAt !== null && row.value.handoffExpiresAt <= now;

    const fields = {
      connection: {
        id: row.value.id,
        institutionId: row.value.institutionId,
        state: row.value.state,
      },
      institutionName: "Bancolombia",
      expiresAt: DateTime.makeUnsafe(row.value.expiresAtMilliseconds),
      phase: expired ? "failed" : row.value.phase,
    };

    const handoff =
      !expired && row.value.handoffUrl !== null && row.value.handoffExpiresAt !== null
        ? Option.some(
            yield* Schema.decodeEffect(ConnectionAuthorizationHandoff)({
              url: row.value.handoffUrl,
              expiresAt: DateTime.formatIso(DateTime.makeUnsafe(row.value.handoffExpiresAt)),
            })
          )
        : Option.none();

    const review = yield* Schema.decodeUnknownEffect(Schema.toType(ConnectionContinuationReview))(
      Option.match(handoff, {
        onNone: () => fields,
        onSome: (authorization) => ({ ...fields, authorization }),
      })
    );

    const body = yield* Schema.encodeEffect(Schema.toCodecJson(ConnectionContinuationReview))(
      review
    );

    return Response.json(body, { headers: transactionNoStore });
  });
