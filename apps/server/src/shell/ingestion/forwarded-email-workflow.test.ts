import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { ClusterError } from "effect/unstable/cluster";
import { RpcClientError } from "effect/unstable/rpc";
import { WorkerError } from "effect/unstable/workers";
import { UserId } from "~/core/identity/reference";
import { ResendReceivedEmailId } from "~/core/ingestion/reference";
import {
  ForwardedEmailWorkflowPayload,
  handoffDefectDisposition,
} from "./forwarded-email-workflow";

it.effect("decodes a revisionless forwarded-email workflow payload as revision one", () =>
  Effect.gen(function* () {
    const payload = yield* Schema.decodeEffect(ForwardedEmailWorkflowPayload)({
      userId: "f1d1a000-0000-4000-8000-000000000101",
      receivedEmailId: "received-workflow-evolution",
    });
    expect(payload).toEqual({
      userId: UserId.make("f1d1a000-0000-4000-8000-000000000101"),
      receivedEmailId: ResendReceivedEmailId.make("received-workflow-evolution"),
      revision: 1,
    });
  })
);

it.effect("retries transient handoff defects and rejects incompatible defects", () =>
  Effect.sync(() => {
    const diagnostic = new Error("provider-diagnostic secret-sentinel");
    expect(
      Option.getOrThrow(
        handoffDefectDisposition(ClusterError.PersistenceError.make({ cause: diagnostic }))
      )
    ).toEqual({ _tag: "Retry", reason: "transient" });
    expect(
      Option.getOrThrow(
        handoffDefectDisposition(ClusterError.MalformedMessage.make({ cause: diagnostic }))
      )
    ).toEqual({ _tag: "Terminal", reason: "payload-rejected" });
    expect(
      Option.getOrThrow(
        handoffDefectDisposition(
          RpcClientError.RpcClientError.make({
            reason: RpcClientError.RpcClientDefect.make({
              message: "incompatible protocol",
              cause: diagnostic,
            }),
          })
        )
      )
    ).toEqual({ _tag: "Terminal", reason: "payload-rejected" });
    expect(
      Option.getOrThrow(
        handoffDefectDisposition(
          RpcClientError.RpcClientError.make({
            reason: WorkerError.WorkerSpawnError.make({ message: "runner unavailable" }),
          })
        )
      )
    ).toEqual({ _tag: "Retry", reason: "transient" });
    expect(handoffDefectDisposition(diagnostic)).toEqual(Option.none());
  })
);
