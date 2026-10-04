import { Option, Schema } from "effect";
import { type CanonicalToolResultEntry } from "../../../src/core/agent/contract";
import { Transaction, TransactionPresentation } from "../../../src/core/transactions/contract";
import { DashboardView } from "../../../src/shell/dashboard/contract";

const list = Schema.toCodecJson(Schema.Struct({ data: Schema.Array(Transaction) }));
const single = Schema.toCodecJson(Schema.Struct({ data: TransactionPresentation }));
const dashboard = Schema.toCodecJson(Schema.Struct({ data: DashboardView }));
const rows = Schema.Struct({ transactions: Schema.Array(Schema.Unknown) });
const containsTransactions = (node: DashboardView["layout"]): boolean => {
  if (node.kind === "split") return node.children.some((child) => containsTransactions(child.node));
  if (node.widget.widget.type !== "transaction-list") return false;
  return Option.exists(
    Schema.decodeUnknownOption(rows)(node.widget.result),
    (result) => result.transactions.length > 0
  );
};

/** Only newly loaded saved Transaction rows count. Creation, aggregates, empty/failed reads, and prior conversation do not. */
export const loadsSavedHistory = (entry: CanonicalToolResultEntry): boolean => {
  if (entry.outcome._tag !== "Succeeded") return false;
  switch (entry.operation) {
    case "transactions.getTransaction":
      return Option.isSome(Schema.decodeOption(single)(entry.outcome.output));
    case "transactions.listTransactions":
    case "transactions.searchTransactions":
      return Option.exists(
        Schema.decodeOption(list)(entry.outcome.output),
        (result) => result.data.length > 0
      );
    case "dashboard.getDashboardView":
      return Option.exists(Schema.decodeOption(dashboard)(entry.outcome.output), (result) =>
        containsTransactions(result.data.layout)
      );
    default:
      return false;
  }
};
