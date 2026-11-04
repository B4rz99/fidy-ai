import { Effect, Schema, type Scope } from "effect";
import { Miniflare } from "miniflare";
import type { RecoveryAdmissionBinding } from "./contract";

const wait = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);

export const nativeRecoveryAdmission: Effect.Effect<RecoveryAdmissionBinding, never, Scope.Scope> =
  Effect.gen(function* () {
    const built = yield* wait(() =>
      Bun.build({
        entrypoints: [new URL("./worker.test-fixture.ts", import.meta.url).pathname],
        target: "browser",
        external: ["cloudflare:workers", "node:*"],
      })
    );
    const output = built.outputs[0];
    if (!built.success || output === undefined) {
      return yield* Effect.die(new Error("Admission fixture failed"));
    }
    const contents = yield* wait(() => output.text());
    const runtime = new Miniflare({
      workers: [
        {
          config: {
            name: "recovery-admission",
            type: "worker",
            compatibilityDate: "2026-09-18",
            exports: { RecoveryAdmissionGate: { type: "durable-object", storage: "sqlite" } },
            env: {
              RECOVERY_SOURCE_EPOCH: { type: "text", value: "source-epoch" },
              GATE: {
                type: "durable-object",
                worker: "recovery-admission",
                exportName: "RecoveryAdmissionGate",
              },
            },
            manifest: {
              mainModule: "index.mjs",
              modules: { "index.mjs": { type: "esm", contents } },
            },
          },
        },
      ],
    });
    yield* Effect.addFinalizer(() => wait(() => runtime.dispose()));
    const worker = yield* wait(() => runtime.getWorker());
    const dispatch = (command: unknown): Promise<unknown> =>
      worker
        .fetch("https://native-gate/", {
          method: "POST",
          body: Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(command),
        })
        .then((response) => response.json());
    return {
      inspect: () => dispatch({ action: "inspect" }),
      pause: (input) => dispatch({ action: "pause", input }),
      enterContinuation: (input) =>
        dispatch({ action: "enterContinuation", input }).then(
          Schema.decodeUnknownSync(Schema.Boolean)
        ),
      enter: (input) =>
        dispatch({ action: "enter", input }).then(Schema.decodeUnknownSync(Schema.Boolean)),
      complete: (input) =>
        dispatch({ action: "complete", input }).then(Schema.decodeUnknownSync(Schema.Boolean)),
      close: (input) => dispatch({ action: "close", input }),
    };
  });
