import { CreateTransactionInput, UpdateTransactionInput } from "@fidy/server/transactions-runtime";
import { correctTransaction } from "./transaction-corrections";
import { CanonicalCapability, maximumAtomicBatchCalls } from "@fidy/server/canonical-runtime";
import { Effect, Option, Schema } from "effect";
import { createManualTransaction, unavailableTransaction } from "./transactions";
import { type TransactionBatchCall, executeTransactionBatch } from "./transaction-mutations";
import { type TransactionCaller, transactionNow } from "./transaction-boundary";

const digestBytes = 32;
const Credentials = {
  userId: Schema.String.check(Schema.isUUID()),
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
} as const;
const WebSession = { ...Credentials, sessionId: Schema.String.check(Schema.isUUID()) } as const;
const PAT = {
  ...Credentials,
  patId: Schema.String.check(Schema.isUUID()),
  requiredScope: Schema.NullOr(CanonicalCapability),
} as const;
const Capture = { input: Schema.toCodecJson(CreateTransactionInput) } as const;
const Correction = {
  correction: Schema.Struct({
    id: Schema.String,
    input: Schema.toCodecJson(UpdateTransactionInput),
  }),
} as const;
const BatchCall = Schema.Struct({
  callId: Schema.String.check(Schema.isUUID()),
  operation: Schema.String,
  input: Schema.Unknown,
});
const Batch = {
  calls: Schema.NonEmptyArray(BatchCall).check(Schema.isMaxLength(maximumAtomicBatchCalls)),
} as const;
const Command = Schema.Union([
  Schema.TaggedStruct("WebSessionCapture", { ...WebSession, ...Capture }),
  Schema.TaggedStruct("WebSessionCorrection", { ...WebSession, ...Correction }),
  Schema.TaggedStruct("WebSessionBatch", { ...WebSession, ...Batch }),
  Schema.TaggedStruct("PATCapture", { ...PAT, ...Capture }),
  Schema.TaggedStruct("PATCorrection", { ...PAT, ...Correction }),
  Schema.TaggedStruct("PATBatch", { ...PAT, ...Batch }),
]);
type Command = typeof Command.Type;

/** Rebuild the exact live subject the admitted command was issued for. */
const commandSubject = (command: Command): TransactionCaller =>
  command._tag === "PATCapture" || command._tag === "PATCorrection" || command._tag === "PATBatch"
    ? {
        patId: command.patId,
        userId: command.userId,
        digest: new Uint8Array(command.digest),
        requiredScope: Option.fromNullishOr(command.requiredScope),
      }
    : {
        id: command.sessionId,
        userId: command.userId,
        digest: new Uint8Array(command.digest),
      };

/** Dispatch one admitted command to the shared Transaction mutation implementation. */
const executeCommand = ({
  db,
  command,
}: Readonly<{ db: D1Database; command: Command }>): Effect.Effect<Response, Response> =>
  Effect.gen(function* () {
    const subject = commandSubject(command);
    switch (command._tag) {
      case "WebSessionCorrection":
      case "PATCorrection": {
        const { correction } = command;
        return yield* Effect.tryPromise({
          try: () =>
            correctTransaction({ db, subject, id: correction.id, input: correction.input }),
          catch: () => unavailableTransaction(),
        });
      }
      case "WebSessionBatch":
      case "PATBatch": {
        const calls: ReadonlyArray<TransactionBatchCall> = command.calls;
        return yield* Effect.tryPromise({
          try: () => executeTransactionBatch({ db, subject, calls, current: transactionNow() }),
          catch: () => unavailableTransaction(),
        });
      }
      case "WebSessionCapture":
      case "PATCapture":
        return yield* Effect.tryPromise({
          try: () => createManualTransaction({ db, subject, input: command.input }),
          catch: () => unavailableTransaction(),
        });
    }
  });

/** One instance per stable User coordinates mutations; D1 alone owns the FinancialRecord. */
export class UserTransactionCoordinator {
  private pending: Promise<void> = Promise.resolve();
  private readonly state: Readonly<{ id: Readonly<{ name: string }> }>;
  private readonly env: { DB: D1Database };
  constructor(state: Readonly<{ id: Readonly<{ name: string }> }>, env: { DB: D1Database }) {
    this.state = state;
    this.env = env;
  }

  fetch(request: Request): Promise<Response> {
    const db = this.env.DB;
    const userId = this.state.id.name;
    const work = this.pending.then(() =>
      Effect.runPromise(
        Effect.gen(function* () {
          const candidate = yield* Effect.tryPromise({
            try: () => request.json(),
            catch: () => unavailableTransaction(),
          });
          const command = Schema.decodeUnknownOption(Command)(candidate);
          if (
            Option.isNone(command) ||
            command.value.digest.length !== digestBytes ||
            command.value.userId !== userId
          ) {
            return unavailableTransaction();
          }
          return yield* executeCommand({ db, command: command.value });
        }).pipe(Effect.catch((response) => Effect.succeed(response)))
      )
    );
    this.pending = work.then(
      () => undefined,
      () => undefined
    );
    return work;
  }
}
