import type { ProcessingConsentStatus } from "@/transport/client";

export type PreviewDataset = "demo" | "granted" | "missing" | "revoked";

export const fixtureConsent = ({
  status,
  dataset,
}: Readonly<{
  status: ProcessingConsentStatus;
  dataset: PreviewDataset;
}>): ProcessingConsentStatus => {
  switch (dataset) {
    case "granted":
      return { status: "Granted", withdrawal: null };
    case "missing":
      return { status: "Missing", withdrawal: null };
    case "revoked":
      return {
        status: "Revoked",
        withdrawal: {
          reference: "88000000-0000-4000-8000-000000000001",
          occurredAtMs: 1764000000000,
        },
      };
    case "demo":
      return status;
  }
};
