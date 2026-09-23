import { CreateTransactionInput } from "@fidy/server/transactions-runtime";
import { Option, Schema } from "effect";
import { createManualTransaction, unavailableTransaction } from "./transactions";

const digestBytes = 32;
const Command = Schema.Struct({
  sessionId: Schema.String.check(Schema.isUUID()),
  userId: Schema.String.check(Schema.isUUID()),
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  input: Schema.toCodecJson(CreateTransactionInput),
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
    // @effect-diagnostics-next-line asyncFunction:off
    const work = this.pending.then(async () => {
      try {
        const candidate: unknown = await request.json();
        const command = Schema.decodeUnknownOption(Command)(candidate);
        if (
          Option.isNone(command) ||
          command.value.digest.length !== digestBytes ||
          command.value.userId !== this.state.id.name
        ) {
          return unavailableTransaction();
        }
        return await createManualTransaction(
          this.env.DB,
          {
            id: command.value.sessionId,
            userId: command.value.userId,
            digest: new Uint8Array(command.value.digest),
          },
          command.value.input
        );
      } catch {
        return unavailableTransaction();
      }
    });
    this.pending = work.then(
      () => undefined,
      () => undefined
    );
    return work;
  }
}
