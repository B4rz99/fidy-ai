import { createContext, use } from "react";
import { Option } from "effect";
import type { TransactionCorrections } from "./corrections";

export const TransactionCorrectionContext = createContext<Option.Option<TransactionCorrections>>(
  Option.none()
);
export const useTransactionCorrections = (): TransactionCorrections =>
  Option.getOrThrow(use(TransactionCorrectionContext));
