import { Option, Schema } from "effect";
import { NextOperations } from "~/shell/public-http/contract";
import {
  checkpointSuggestedOperations,
  freePatCaller,
  suggestOperation,
} from "~/shell/_shared/suggested-operations";

/** An authorized, typed canonical continuation for the next bounded Transaction history page. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const nextTransactionPage = (
  cursor: string,
  filters: Readonly<Record<string, string>>,
  operation:
    | "transactions.listTransactions"
    | "transactions.searchTransactions" = "transactions.listTransactions"
): typeof NextOperations.Encoded =>
  Schema.encodeSync(NextOperations)(
    checkpointSuggestedOperations({
      candidates: [
        suggestOperation({
          tool: operation,
          hint: "Continue browsing the next page of your FinancialRecord.",
          args: Option.some({ query: { ...filters, cursor } }),
        }),
      ],
      caller: freePatCaller(["read"]),
    })
  );
