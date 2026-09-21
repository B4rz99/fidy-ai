/**
 * Hard upper bounds on one hosted Turn: its iteration count, its tool calls, and the wall-clock
 * bound on each model round. A future private Worker/Workflow adapter must derive its deadline
 * from the same maxima, so the Turn budget and platform safety net cannot drift apart silently.
 */
export const maximumHostedTurnIterations = 32;
export const maximumModelRoundMillis = 120_000;
export const maximumToolCallsPerTurn = 64;
