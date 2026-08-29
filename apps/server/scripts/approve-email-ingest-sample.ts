#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Schema } from "effect";
import { IngestSampleId } from "~/core/ingestion/reference";
import { MigrationSqlClient } from "~/shell/db/client";
import {
  ApprovedOperatorId,
  ForwardedEmailSampleApproval,
} from "~/shell/ingestion/email-anonymization-approval";

const argument = (name: string): Option.Option<string> => {
  const index = process.argv.indexOf(name);
  return index < 0 ? Option.none() : Option.fromUndefinedOr(process.argv[index + 1]);
};

const program = Effect.gen(function* () {
  const sampleId = yield* Schema.decodeUnknownEffect(IngestSampleId)(
    Option.getOrUndefined(argument("--sample-id"))
  );
  const approvedBy = yield* Schema.decodeUnknownEffect(ApprovedOperatorId)(
    Option.getOrUndefined(argument("--operator"))
  );
  const approval = yield* ForwardedEmailSampleApproval;
  const approved = yield* approval.approve({ sampleId, approvedBy });
  if (!approved) {
    return yield* Effect.die(new Error("No unexpired raw IngestSample exists for that id."));
  }
  yield* Effect.logInfo("Approved anonymized email IngestSample", { sampleId });
});

const MainLive = Layer.effectDiscard(program).pipe(
  Layer.provide(ForwardedEmailSampleApproval.layer),
  Layer.provide(MigrationSqlClient.layer),
  Layer.provide(BunServices.layer)
);

BunRuntime.runMain(Effect.scoped(Layer.build(MainLive)));
