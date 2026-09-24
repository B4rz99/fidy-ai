import { CreateTransactionInput, UpdateTransactionInput } from "@fidy/server/transactions-runtime";
import { correctTransaction } from "./transaction-corrections";
import { CanonicalCapability } from "@fidy/server/canonical-runtime";
import { Effect, Option, Schema } from "effect";
import { createManualTransaction, unavailableTransaction } from "./transactions";

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
const Command = Schema.Union([
  Schema.TaggedStruct("WebSessionCapture", { ...WebSession, ...Capture }),
  Schema.TaggedStruct("WebSessionCorrection", { ...WebSession, ...Correction }),
  Schema.TaggedStruct("PATCapture", { ...PAT, ...Capture }),
  Schema.TaggedStruct("PATCorrection", { ...PAT, ...Correction }),
]);

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
          const subject =
            command.value._tag === "PATCapture" || command.value._tag === "PATCorrection"
              ? {
                  patId: command.value.patId,
                  userId: command.value.userId,
                  digest: new Uint8Array(command.value.digest),
                  requiredScope: Option.fromNullishOr(command.value.requiredScope),
                }
              : {
                  id: command.value.sessionId,
                  userId: command.value.userId,
                  digest: new Uint8Array(command.value.digest),
                };
          const authorized = command.value;
          if ("correction" in authorized) {
            const { correction } = authorized;
            return yield* Effect.tryPromise({
              try: () =>
                correctTransaction({ db, subject, id: correction.id, input: correction.input }),
              catch: () => unavailableTransaction(),
            });
          }
          return yield* Effect.tryPromise({
            try: () => createManualTransaction({ db, subject, input: authorized.input }),
            catch: () => unavailableTransaction(),
          });
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
