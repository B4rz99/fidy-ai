import { createContext, use } from "react";
import { Option } from "effect";
import type { TransactionCorrections } from "./corrections";

export const TransactionCorrectionContext = createContext<Option.Option<TransactionCorrections>>(
  Option.none()
);

export const useTransactionCorrections = (): TransactionCorrections => {
  const corrections = use(TransactionCorrectionContext);

  if (Option.isNone(corrections)) {
    throw new Error("useTransactionCorrections must be used within TransactionCorrectionContext");
  }

  return corrections.value;
};
