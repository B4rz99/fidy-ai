import { BunServices } from "@effect/platform-bun";
import { Clock, Crypto, Effect, FileSystem, Schema } from "effect";
import { playwright } from "./playwright-runtime";

const { expect } = playwright;
const maximumReceiptBytes = 8192;
const Receipt = Schema.Struct({
  case: Schema.Struct({ revision: Schema.Int, delivery: Schema.Struct({ status: Schema.String }) }),
  authority: Schema.Literal("manual-record-only"),
  deletion: Schema.Literal("not-performed"),
});
const runCaseRegister = Effect.fn(function* (
  input: Readonly<{ directory: string; request: unknown }>
) {
  const encoded = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
    input.request
  );
  const result = yield* Effect.sync(() =>
    Bun.spawnSync(
      [
        process.execPath,
        new URL("../../../scripts/titular-requests/main.ts", import.meta.url).pathname,
        input.directory,
      ],
      { stdin: new TextEncoder().encode(encoded), stdout: "pipe", stderr: "pipe", timeout: 10000 }
    )
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr.byteLength).toBe(0);
  expect(result.stdout.byteLength).toBeLessThan(maximumReceiptBytes);
  return yield* Schema.decodeEffect(Schema.fromJsonString(Receipt))(
    new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)
  );
});

const reference = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  return yield* crypto.randomUUIDv4();
});

const observeDelivery = Effect.fn(function* (
  input: Readonly<{ root: string; observedRef: string; ownerResultRef: string }>
) {
  const fs = yield* FileSystem.FileSystem;
  const observed = Schema.Struct({
    ownerResultRef: Schema.String.check(Schema.isUUID()),
    visiblyDelivered: Schema.Literal(true),
  });
  yield* fs.writeFileString(
    `${input.root}/${input.observedRef}.json`,
    yield* Schema.encodeEffect(Schema.fromJsonString(observed))({
      ownerResultRef: input.ownerResultRef,
      visiblyDelivered: true,
    }),
    { mode: 0o600, flag: "wx" }
  );
});

/** A disposable native case exercises the actual register after a real Core owner result was visibly delivered. */
export const exerciseTitularCase = (ownerResultRef: string): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fidy-titular-browser-" });
      const root = yield* fs.realPath(directory);
      const caseId = yield* reference;
      const observedRef = yield* reference;
      yield* observeDelivery({ root, observedRef, ownerResultRef });
      let receipt = yield* runCaseRegister({
        directory: root,
        request: {
          operation: "Apply",
          command: {
            action: "Receive",
            commandId: yield* reference,
            caseId,
            ownerRef: yield* reference,
            requestRef: yield* reference,
            scopeRef: yield* reference,
            requester: "User",
            kind: "Access",
            receivedAtMs: yield* Clock.currentTimeMillis,
          },
        },
      });
      const actions = [
        { action: "RecordVerification", evidenceRef: ownerResultRef },
        { action: "RecordOwnerResult", evidenceRef: ownerResultRef },
        { action: "PrepareResponse", evidenceRef: observedRef },
        { action: "DeliveryFailed", evidenceRef: yield* reference },
        { action: "DeliveryUncertain", evidenceRef: yield* reference },
        { action: "RecordResponse", evidenceRef: observedRef },
      ] as const;
      for (const command of actions) {
        const input = {
          operation: "Apply",
          command: {
            ...command,
            commandId: yield* reference,
            caseId,
            revision: receipt.case.revision,
          },
        };
        receipt = yield* runCaseRegister({ directory: root, request: input });
        expect(yield* runCaseRegister({ directory: root, request: input })).toEqual(receipt);
        if (command.action === "DeliveryFailed" || command.action === "DeliveryUncertain") {
          expect(receipt.case.delivery.status).not.toBe("Confirmed");
        }
      }
      expect(receipt.case.delivery.status).toBe("Confirmed");
      expect(receipt.authority).toBe("manual-record-only");
      expect(receipt.deletion).toBe("not-performed");
    }).pipe(Effect.provide(BunServices.layer), Effect.scoped)
  );
