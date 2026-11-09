import { type Context, type Effect } from "effect";
import { type AsyncResult, type Atom } from "effect/reactivity";
import type { CanonicalInput, CanonicalSuccess, FidyClient } from "@/transport/client";
import { type Transaction, deriveCurrentMonthPeriod } from "./presentation";
import { transactionMonth } from "./period";

type Client = Context.Service.Shape<FidyClient>;
type Failure = Effect.Error<ReturnType<Client["transactions"]["getTransaction"]>>;
type Result = AsyncResult.AsyncResult<CanonicalSuccess<"transactions.getTransaction">, Failure>;
type TransactionId = CanonicalInput<"transactions.getTransaction">["params"]["id"];
export const transactionDestinationQuery = ({
  client,
  id,
}: Readonly<{ client: FidyClient; id: TransactionId }>): Atom.Atom<Result> =>
  client.query("transactions", "getTransaction", {
    params: { id },
    timeToLive: "400 millis",
    reactivityKeys: ["transaction-detail"],
  });
export const destinationMonth = ({
  transaction,
  timeZone,
}: Readonly<{ transaction: Transaction; timeZone: string }>): string =>
  transactionMonth(deriveCurrentMonthPeriod({ now: transaction.occurredAt, timeZone }));
