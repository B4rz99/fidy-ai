import {
  chargeProvider,
  reserveSharedProvider,
  sharedProviderRequest,
} from "./internal/provider-allowance";

export const chargeLocalProvider: typeof chargeProvider = (...input) => chargeProvider(...input);

export const reserveSharedProviderSpend: typeof reserveSharedProvider = (...input) =>
  reserveSharedProvider(...input);

export const admitSharedProvider: typeof sharedProviderRequest = (request) =>
  sharedProviderRequest(request);
