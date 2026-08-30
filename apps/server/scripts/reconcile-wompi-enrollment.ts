#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { FetchHttpClient } from "effect/unstable/http";
import { Config, Console, Data, DateTime, Effect, Layer, Redacted, Schema } from "effect";
import { UserId } from "~/core/identity/reference";
import { CardEnrollmentId, WompiSourceId } from "~/core/subscription/enrollment-model";
import { PgLive, RuntimeAuthorityLive } from "~/shell/db/client";
import { reconcileCardEnrollment } from "~/shell/subscription/card-enrollment";
import { WompiEnrollmentClient } from "~/shell/subscription/wompi-client";

const ReconciliationOutcome = Schema.Literals(["available", "refused"]);
const ProviderSourceId = Schema.FiniteFromString.pipe(Schema.decodeTo(WompiSourceId));
class InvalidProviderSourceId extends Data.TaggedError("InvalidProviderSourceId")<{}> {}

const reconcile = Effect.gen(function* () {
  const userId = yield* Config.schema(UserId, "WOMPI_RECONCILIATION_USER_ID");
  const enrollmentId = yield* Config.schema(CardEnrollmentId, "WOMPI_RECONCILIATION_ENROLLMENT_ID");
  const outcome = yield* Config.schema(ReconciliationOutcome, "WOMPI_RECONCILIATION_OUTCOME");
  const reconciliation =
    outcome === "refused"
      ? ({ _tag: "Refused" } as const)
      : ({
          _tag: "Available",
          sourceId: yield* Schema.decodeOption(ProviderSourceId)(
            Redacted.value(yield* Config.redacted("WOMPI_RECONCILIATION_SOURCE_ID"))
          ).pipe(Effect.fromOption(() => new InvalidProviderSourceId())),
        } as const);
  yield* reconcileCardEnrollment({
    userId,
    enrollmentId,
    outcome: reconciliation,
    reconciledAt: yield* DateTime.now,
  });
  yield* Console.log("Wompi enrollment reconciliation completed.");
});

const ReconcileLive = Layer.effectDiscard(reconcile).pipe(
  Layer.provide(RuntimeAuthorityLive),
  Layer.provide(PgLive),
  Layer.provide(
    WompiEnrollmentClient.layer.pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(BunServices.layer)
    )
  ),
  Layer.provide(BunServices.layer)
);

BunRuntime.runMain(Effect.scoped(Layer.build(ReconcileLive)));
