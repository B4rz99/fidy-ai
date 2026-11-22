import {
  claimRegisteredSend as claimRegisteredSendOwned,
  recordRegisteredSend as recordRegisteredSendOwned,
} from "./internal/registered-send";

export const claimRegisteredSend: typeof claimRegisteredSendOwned = (...args) =>
  claimRegisteredSendOwned(...args);

export const recordRegisteredSend: typeof recordRegisteredSendOwned = (...args) =>
  recordRegisteredSendOwned(...args);
