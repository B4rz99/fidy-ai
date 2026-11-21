import { foldHostedReceipt } from "./internal/local-channel-receipt";

export const reconcileLocalHostedReceipt: typeof foldHostedReceipt = (...args) =>
  foldHostedReceipt(...args);
