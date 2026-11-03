import { lazyRouteComponent } from "@tanstack/react-router";
import { type ComponentProps, type JSX, Suspense } from "react";
import { PendingRead } from "@/ui/components/pending-read";
import { transactionPageInitialValue } from "./query";
import { TransactionWorkspace } from "./workspace-component";
import type { TransactionListFeature as ListFeature } from "./list-feature";

export { TransactionSearch } from "./period";
const List = lazyRouteComponent(() => import("./list-feature"), "TransactionListFeature");
const Capture = lazyRouteComponent(() => import("./capture-feature"), "TransactionCaptureFeature");
const Privacy = lazyRouteComponent(() => import("./privacy-view"), "PrivacyTransactions");

export const TransactionListFeature = (props: ComponentProps<typeof List>): JSX.Element => (
  <List {...props} />
);
TransactionListFeature.initialValue = transactionPageInitialValue;
TransactionListFeature.preloadData = (
  input: Parameters<typeof ListFeature.preloadData>[0]
): Promise<void> =>
  import("./list-feature").then((module) => module.TransactionListFeature.preloadData(input));
TransactionListFeature.preload = (): Promise<void> =>
  Promise.all([List.preload?.(), TransactionWorkspace.preload?.()]).then(() => undefined);

export const TransactionCaptureFeature = (props: ComponentProps<typeof Capture>): JSX.Element => (
  <Suspense fallback={<PendingRead label="Cargando formulario" />}>
    <Capture {...props} />
  </Suspense>
);
TransactionCaptureFeature.preload = (): Promise<void> => Capture.preload?.() ?? Promise.resolve();

export const PrivacyTransactionFeature = (): JSX.Element => (
  <Suspense fallback={<PendingRead label="Cargando transacciones" />}>
    <Privacy />
  </Suspense>
);
PrivacyTransactionFeature.preload = (): Promise<void> => Privacy.preload?.() ?? Promise.resolve();
