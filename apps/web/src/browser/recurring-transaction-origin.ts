import { useRouter, useRouterState, useSearch } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import { RecurringMonth, TransactionId } from "@/transport/client";

const HistoryState = Schema.Struct({
  recurringTransactionOrigin: Schema.Struct({
    binding: Schema.String,
    month: RecurringMonth,
    transactionId: TransactionId,
  }),
});

export const useRecurringTransactionMonth = (): Option.Option<string> => {
  const router = useRouter();
  const state = useRouterState({ select: (value) => value.location.state });
  const { transaction } = useSearch({ from: "/independent-application/app/transactions" });

  return Schema.decodeUnknownOption(HistoryState)(state).pipe(
    Option.map(({ recurringTransactionOrigin }) => recurringTransactionOrigin),
    Option.filter(
      (origin) =>
        origin.binding === router.options.context.sessionBinding &&
        origin.transactionId === transaction
    ),
    Option.map((origin) => origin.month)
  );
};
