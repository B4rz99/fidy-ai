import { CreateTransactionInput } from "@fidy/server/transactions-runtime";
import { CanonicalCapability } from "@fidy/server/canonical-runtime";
import { Effect, Option, Schema } from "effect";
import { createManualTransaction, unavailableTransaction } from "./transactions";

const digestBytes = 32;
const Credentials = {
  userId: Schema.String.check(Schema.isUUID()),
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  input: Schema.toCodecJson(CreateTransactionInput),
} as const;
const Command = Schema.Union([
  Schema.TaggedStruct("WebSession", {
    ...Credentials,
    sessionId: Schema.String.check(Schema.isUUID()),
  }),
  Schema.TaggedStruct("PAT", {
    ...Credentials,
    patId: Schema.String.check(Schema.isUUID()),
    requiredScope: Schema.NullOr(CanonicalCapability),
  }),
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
            command.value._tag === "PAT"
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
          return yield* Effect.tryPromise({
            try: () => createManualTransaction({ db, subject, input: command.value.input }),
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
