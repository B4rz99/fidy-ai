import { TransactionListFeature } from "@/features/transactions/feature";
import { AsyncResult, type Atom } from "effect/reactivity";
import { Option } from "effect";
import type { BrowserSessionObservation } from "@/transport/session-binding";
import type { FidyClient, ProcessingConsentStatus, WebAuthClient } from "@/transport/client";
import { workspaceMetadataInitialValue } from "@/transport/workspace-query";
import { initialConsentObservation, initialTransactionConsent } from "./transaction-entry";

/** Hydrate the canonical nodes once in the new authentication registry; later refreshes use HTTP. */
export const initialApplicationValues = ({
  apiClient,
  webAuthClient,
  initial,
}: Readonly<{
  apiClient: FidyClient;
  webAuthClient: WebAuthClient;
  initial: BrowserSessionObservation;
}>): ReadonlyArray<readonly [Atom.Atom<unknown>, unknown]> => {
  if (Option.isNone(initial.initial)) return [];
  const context = initial.initial.value;
  const values: Array<readonly [Atom.Atom<unknown>, unknown]> = [];
  if (context.status === "Granted") {
    values.push(workspaceMetadataInitialValue(apiClient, context.profile, initial.receivedAt));
    if (Option.isSome(context.transactions)) {
      const page = context.transactions.value;
      values.push(TransactionListFeature.initialValue(apiClient, page, initial.receivedAt));
    }
  }
  {
    const status: ProcessingConsentStatus =
      context.status === "Granted" ? { status: "Granted", withdrawal: null } : context;
    values.push([
      initialConsentObservation(webAuthClient),
      Option.some(AsyncResult.success(status, { timestamp: initial.receivedAt })),
    ]);
    values.push([initialTransactionConsent, Option.some(initial.receivedAt)]);
  }
  return values;
};
