import { applyBetaUserCommand } from "./internal/user";

/** Private address on the registered User, including the native capacity and erasure boundaries. */
export const runBetaUserCommand: typeof applyBetaUserCommand = (...args) =>
  applyBetaUserCommand(...args);
