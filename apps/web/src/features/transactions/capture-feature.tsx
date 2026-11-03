import { useRouter } from "@tanstack/react-router";
import type { JSX } from "react";
import { TransactionCapture } from "./capture";

export const TransactionCaptureFeature = (
  props: Omit<Parameters<typeof TransactionCapture>[0], "apiClient">
): JSX.Element => {
  const { apiClient } = useRouter().options.context;
  return <TransactionCapture {...props} apiClient={apiClient} />;
};
