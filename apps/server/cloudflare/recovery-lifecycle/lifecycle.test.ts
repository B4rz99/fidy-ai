import { it } from "@effect/vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import { expect } from "vitest";
import { nativeRecoveryAdmission } from "../recovery-activation/native.test-fixture";
import { runRecoveryJob, runRecoveryOperation, runRecoveryQueue } from "./operations";
import type { RecoveryAdmissionBinding } from "../recovery-activation/contract";
import { runRecoveryFetch, trackRecoveryNative } from "./runtime";

it.effect("withholds a held operation after closing admission and denies new work", () =>
  Effect.gen(function* () {
    const gate = yield* nativeRecoveryAdmission;
    const environment = {
      RECOVERY_SOURCE_EPOCH: "source-epoch",
      RECOVERY_ADMISSION: { getByName: (): RecoveryAdmissionBinding => gate },
    };
    const entered = Promise.withResolvers<void>();
    const provider = Promise.withResolvers<string>();
    const pending = runRecoveryOperation({
      environment,
      work: () => {
        entered.resolve();
        return provider.promise;
      },
    });
    const outcome = pending.then(
      () => "released",
      () => "withheld"
    );
    yield* Effect.tryPromise(() => entered.promise);
    expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({ leases: 1 });
    yield* Effect.tryPromise(() => gate.close({ epoch: "source-epoch", activationId: "cutover" }));
    provider.resolve("financial content");
    expect(yield* Effect.tryPromise(() => outcome)).toBe("withheld");
    let executed = false;
    yield* Effect.tryPromise(() =>
      expect(
        runRecoveryOperation({
          environment,
          work: () => {
            executed = true;
            return Promise.resolve();
          },
        })
      ).rejects.toThrow()
    );
    expect(executed).toBe(false);
    expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({
      closed: true,
      leases: 0,
    });
  }).pipe(Effect.scoped)
);

it.effect("denies stale and missing durable-job epochs before any owner work", () =>
  Effect.gen(function* () {
    const gate = yield* nativeRecoveryAdmission;
    const environment = {
      RECOVERY_SOURCE_EPOCH: "source-epoch",
      RECOVERY_ADMISSION: { getByName: (): RecoveryAdmissionBinding => gate },
    };
    let executions = 0;
    const work = (): Promise<void> => {
      executions++;
      return Promise.resolve();
    };
    yield* Effect.tryPromise(() =>
      expect(
        runRecoveryJob({ environment, payload: { recoveryEpoch: "old-epoch" }, work })
      ).rejects.toThrow()
    );
    yield* Effect.tryPromise(() =>
      expect(runRecoveryJob({ environment, payload: {}, work })).rejects.toThrow()
    );
    expect(executions).toBe(0);
    expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({ leases: 0 });
    yield* Effect.tryPromise(() =>
      runRecoveryJob({
        environment,
        payload: { recoveryEpoch: "source-epoch", id: "known-job" },
        work,
      })
    );
    expect(executions).toBe(1);
  }).pipe(Effect.scoped)
);

it.live("keeps a streaming response leased and refuses later chunks after admission closes", () =>
  Effect.gen(function* () {
    const gate = yield* nativeRecoveryAdmission;
    const environment = {
      RECOVERY_SOURCE_EPOCH: "source-epoch",
      RECOVERY_ADMISSION: { getByName: (): RecoveryAdmissionBinding => gate },
    };
    const controls = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const body = new ReadableStream<Uint8Array>({
      start: (controller): void => controls.resolve(controller),
    });
    const controller = yield* Effect.tryPromise(() => controls.promise);
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.close()));
    const response = yield* Effect.tryPromise(() =>
      runRecoveryFetch({
        environment,
        context: Option.none(),
        work: () =>
          Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } })),
      })
    ).pipe(Effect.timeout("1 second"));
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Missing stream");
    const first = reader.read();
    controller.enqueue(new TextEncoder().encode("first permitted event"));
    const firstBytes = yield* Schema.decodeUnknownEffect(Schema.Uint8Array)(
      (yield* Effect.tryPromise(() => first)).value
    );
    expect(new TextDecoder().decode(firstBytes)).toBe("first permitted event");
    expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({ leases: 1 });
    yield* Effect.tryPromise(() => gate.close({ epoch: "source-epoch", activationId: "cutover" }));
    const next = reader.read();
    controller.enqueue(new TextEncoder().encode("withheld financial event"));
    yield* Effect.tryPromise(() => expect(next).rejects.toThrow());
    expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({
      closed: true,
      leases: 1,
    });
  }).pipe(Effect.scoped)
);

it.effect("retains a fetch through waitUntil and withholds its financial result after close", () =>
  Effect.gen(function* () {
    const gate = yield* nativeRecoveryAdmission;
    const environment = {
      RECOVERY_SOURCE_EPOCH: "source-epoch",
      RECOVERY_ADMISSION: { getByName: (): RecoveryAdmissionBinding => gate },
    };
    const invoked = Promise.withResolvers<void>();
    const publication = Promise.withResolvers<void>();
    const pending = runRecoveryFetch({
      environment,
      work: (context) => {
        Option.map(context, (lifetime) => lifetime.waitUntil(publication.promise));
        invoked.resolve();
        return Promise.resolve(new Response("private financial content"));
      },
      context: Option.some({ waitUntil: () => undefined }),
    });
    yield* Effect.tryPromise(() => invoked.promise);
    expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({ leases: 1 });
    yield* Effect.tryPromise(() => gate.close({ epoch: "source-epoch", activationId: "cutover" }));
    publication.resolve();
    const response = yield* Effect.tryPromise(() => pending);
    expect(response.status).toBe(503);
    expect(yield* Effect.tryPromise(() => response.text())).not.toContain(
      "private financial content"
    );
    expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({
      closed: true,
      leases: 0,
    });
  }).pipe(Effect.scoped)
);

it.effect("refuses late native work before invocation after its root has settled", () =>
  Effect.gen(function* () {
    const gate = yield* nativeRecoveryAdmission;
    const environment = {
      RECOVERY_SOURCE_EPOCH: "source-epoch",
      RECOVERY_ADMISSION: { getByName: (): RecoveryAdmissionBinding => gate },
    };
    const later = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<string>();
    let invoked = false;
    yield* Effect.tryPromise(() =>
      runRecoveryOperation({
        environment,
        work: () => {
          later.promise
            .then(() =>
              trackRecoveryNative({
                environment,
                work: () => {
                  invoked = true;
                  return Promise.resolve();
                },
              })
            )
            .then(
              () => completed.resolve("escaped"),
              () => completed.resolve("denied")
            );
          return Promise.resolve();
        },
      })
    );
    later.resolve();
    expect(yield* Effect.tryPromise(() => completed.promise)).toBe("denied");
    expect(invoked).toBe(false);
    expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({ leases: 0 });
  }).pipe(Effect.scoped)
);

it.effect("drains a queued continuation after pause without admitting a new publisher", () =>
  Effect.gen(function* () {
    const gate = yield* nativeRecoveryAdmission;
    const environment = {
      RECOVERY_SOURCE_EPOCH: "source-epoch",
      RECOVERY_ADMISSION: { getByName: (): RecoveryAdmissionBinding => gate },
    };
    const published = { recoveryEpoch: "source-epoch", id: "admitted-before-pause" };
    yield* Effect.tryPromise(() => gate.pause({ epoch: "source-epoch", activationId: "cutover" }));
    let publishedAgain = false;
    yield* Effect.tryPromise(() =>
      expect(
        runRecoveryOperation({
          environment,
          work: () => {
            publishedAgain = true;
            return Promise.resolve();
          },
        })
      ).rejects.toThrow()
    );
    let processed = false;
    yield* Effect.tryPromise(() =>
      runRecoveryJob({
        environment,
        payload: published,
        work: () => {
          processed = true;
          return Promise.resolve();
        },
      })
    );
    expect(publishedAgain).toBe(false);
    expect(processed).toBe(true);
    expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({
      paused: true,
      leases: 0,
    });
    yield* Effect.tryPromise(() => gate.close({ epoch: "source-epoch", activationId: "cutover" }));
    yield* Effect.tryPromise(() =>
      expect(
        runRecoveryJob({
          environment,
          payload: published,
          work: () => Promise.resolve(),
        })
      ).rejects.toThrow()
    );
  }).pipe(Effect.scoped)
);

it.effect("refused native Queue work is never acknowledged or passed to an owner", () =>
  Effect.gen(function* () {
    const gate = yield* nativeRecoveryAdmission;
    const environment = {
      RECOVERY_SOURCE_EPOCH: "source-epoch",
      RECOVERY_ADMISSION: { getByName: (): RecoveryAdmissionBinding => gate },
    };
    let acknowledgements = 0;
    let executions = 0;
    const batch: MessageBatch<unknown> = {
      queue: "retained-source-work",
      metadata: {
        metrics: {
          backlogCount: 1,
          backlogBytes: 1,
          oldestMessageTimestamp: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
        },
      },
      messages: [
        {
          id: "native-message",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
          attempts: 1,
          body: { recoveryEpoch: "old-epoch" },
          ack: () => {
            acknowledgements++;
          },
          retry: () => undefined,
        },
      ],
      ackAll: () => {
        acknowledgements++;
      },
      retryAll: () => undefined,
    };
    yield* Effect.tryPromise(() =>
      expect(
        runRecoveryQueue({
          environment,
          batch,
          work: () => {
            executions++;
            batch.ackAll();
            return Promise.resolve();
          },
        })
      ).rejects.toThrow()
    );
    expect(acknowledgements).toBe(0);
    expect(executions).toBe(0);
    expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({ leases: 0 });
  }).pipe(Effect.scoped)
);
