/**
 * Hard upper bounds on one hosted Turn: its iteration count, its tool calls, and the wall-clock
 * bound on each model round. The private Cluster transport deadline derives from the model-round
 * maxima, so the Turn's bounded budget and the transport's safety net cannot drift apart silently.
 */
export const maximumHostedTurnIterations = 32;
export const maximumModelRoundMillis = 120_000;
export const maximumToolCallsPerTurn = 64;
