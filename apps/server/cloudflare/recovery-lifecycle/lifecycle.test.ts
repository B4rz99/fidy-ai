import { it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { expect } from "vitest";
import { nativeRecoveryAdmission } from "../recovery-activation/native.test-fixture";
import { runRecoveryOperation } from "./operations";
import type { RecoveryAdmissionBinding } from "../recovery-activation/contract";
import { runRecoveryFetch } from "./runtime";

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
    expect(new TextDecoder().decode((yield* Effect.tryPromise(() => first)).value)).toBe(
      "first permitted event"
    );
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
