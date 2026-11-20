import { applyBetaUserCommand } from "./internal/user";

export const runBetaUserCommand: typeof applyBetaUserCommand = (...args) =>
  applyBetaUserCommand(...args);
