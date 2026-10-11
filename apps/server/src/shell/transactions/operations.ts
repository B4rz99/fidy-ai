import { Option, Schema } from "effect";
import { NextOperations } from "~/shell/public-http/contract";
import {
  checkpointSuggestedOperations,
  freePatCaller,
  getCanonicalOperationInput,
  suggestOperation,
} from "~/shell/canonical-operations/operations";

/** A bounded Transaction history continuation that preserves valid URL filters and rejects undeclared inputs. */
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
          args: Option.some(
            Schema.decodeSync(getCanonicalOperationInput(operation), { onExcessProperty: "error" })(
              {
                query: { ...filters, cursor },
              }
            )
          ),
        }),
      ],
      caller: freePatCaller(["read"]),
    })
  );
