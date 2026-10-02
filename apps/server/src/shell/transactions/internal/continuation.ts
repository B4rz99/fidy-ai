import { Option, Schema } from "effect";
import { NextOperations } from "~/shell/public-http/contract";
import {
  checkpointSuggestedOperations,
  freePatCaller,
  suggestOperation,
} from "~/shell/canonical-operations/operations";

/** An authorized, typed canonical continuation for the next bounded Transaction history page. */
export const nextTransactionPage = ({
  cursor,
  filters,
  operation,
}: Readonly<{
  cursor: string;
  filters: Readonly<Record<string, string>>;
  operation: "transactions.listTransactions" | "transactions.searchTransactions";
}>): typeof NextOperations.Encoded =>
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
