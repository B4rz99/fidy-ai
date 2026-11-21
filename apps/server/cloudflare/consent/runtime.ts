import { localProcessingConsent } from "./internal/local-processing";

export const handleLocalProcessingConsent: typeof localProcessingConsent = (...args) =>
  localProcessingConsent(...args);
