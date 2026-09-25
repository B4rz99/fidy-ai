import {
  CreateTransactionInput,
  TransactionPairInput,
  UpdateTransactionInput,
} from "@fidy/server/transactions-runtime";
import { correctTransaction } from "./transaction-corrections";
import { linkTransactions, unlinkTransactions } from "./transaction-reconciliation";
import { CanonicalCapability, maximumAtomicBatchCalls } from "@fidy/server/canonical-runtime";
import { Effect, Option, Schema } from "effect";
import { createManualTransaction, unavailableTransaction } from "./transactions";
import { executeTransactionBatch } from "./transaction-mutations";
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
/**
 * The bounded raw child list a batch command carries. Each entry stays `Unknown` here because the
 * Transaction batch adapter decodes it against the published catalog call union, where a malformed
 * child can still be attributed and audited as the child it named.
 */
export const BatchCalls = Schema.NonEmptyArray(Schema.Unknown).check(
  Schema.isMaxLength(maximumAtomicBatchCalls)
);
export type BatchCalls = typeof BatchCalls.Type;
const Batch = { calls: BatchCalls } as const;
/** The same bounded pair envelope every Reconciliation command carries. */
const Pair = { pair: Schema.toCodecJson(TransactionPairInput) } as const;
/** The atomic batch request envelope: the bounded raw child list the adapter decodes per child. */
export const BatchInput = Schema.Struct(Batch);
export type BatchInput = typeof BatchInput.Type;
/** Every coordinator command: the live subject authority plus the exact work it admitted. */
export const TransactionCommand = Schema.Union([
  Schema.TaggedStruct("WebSessionCapture", { ...WebSession, ...Capture }),
  Schema.TaggedStruct("WebSessionCorrection", { ...WebSession, ...Correction }),
  Schema.TaggedStruct("WebSessionBatch", { ...WebSession, ...Batch }),
  Schema.TaggedStruct("WebSessionLink", { ...WebSession, ...Pair }),
  Schema.TaggedStruct("WebSessionUnlink", { ...WebSession, ...Pair }),
  Schema.TaggedStruct("PATCapture", { ...PAT, ...Capture }),
  Schema.TaggedStruct("PATCorrection", { ...PAT, ...Correction }),
  Schema.TaggedStruct("PATBatch", { ...PAT, ...Batch }),
  Schema.TaggedStruct("PATLink", { ...PAT, ...Pair }),
  Schema.TaggedStruct("PATUnlink", { ...PAT, ...Pair }),
]);
export type TransactionCommand = typeof TransactionCommand.Type;

/** Rebuild the exact live subject the admitted command was issued for. */
const commandSubject = (command: TransactionCommand): TransactionCaller =>
  command._tag === "PATCapture" ||
  command._tag === "PATCorrection" ||
  command._tag === "PATBatch" ||
  command._tag === "PATLink" ||
  command._tag === "PATUnlink"
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

type PairCommand = Extract<
  TransactionCommand,
  { _tag: "WebSessionLink" | "PATLink" | "WebSessionUnlink" | "PATUnlink" }
>;

/** Whether one admitted command is a Reconciliation pair mutation. */
const isPairCommand = (command: TransactionCommand): command is PairCommand =>
  command._tag === "WebSessionLink" ||
  command._tag === "PATLink" ||
  command._tag === "WebSessionUnlink" ||
  command._tag === "PATUnlink";

/** Execute one Reconciliation pair command through the shared Transaction mutation unit. */
const executePairCommand = (
  command: PairCommand,
  work: Readonly<{ db: D1Database; subject: TransactionCaller }>
): Effect.Effect<Response, Response> => {
  const linking = command._tag === "WebSessionLink" || command._tag === "PATLink";
  return Effect.tryPromise({
    try: () =>
      linking
        ? linkTransactions({ ...work, input: command.pair })
        : unlinkTransactions({ ...work, input: command.pair }),
    catch: () => unavailableTransaction(),
  });
};

/** Dispatch one admitted command to the shared Transaction mutation implementation. */
const executeCommand = ({
  db,
  command,
}: Readonly<{ db: D1Database; command: TransactionCommand }>): Effect.Effect<Response, Response> =>
  Effect.gen(function* () {
    const subject = commandSubject(command);
    if (isPairCommand(command)) {
      return yield* executePairCommand(command, { db, subject });
    }
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
      case "PATBatch":
        return yield* Effect.tryPromise({
          try: () =>
            executeTransactionBatch({
              db,
              subject,
              calls: command.calls,
              current: transactionNow(),
            }),
          catch: () => unavailableTransaction(),
        });
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
          const command = Schema.decodeUnknownOption(TransactionCommand)(candidate);
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
