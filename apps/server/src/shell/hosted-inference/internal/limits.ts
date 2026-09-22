/** Server-owned production output allowance included in complete capacity decisions. @internal */
export const hostedOutputTokenReserve = 16_000;

/** One initial provider attempt plus one explicit caller retry. */
export const maximumHostedProviderAttempts = 2;

/** Server-owned provider-token maximum for one active hosted User request. @internal */
export const maximumActiveRequestTokens = 16_000;
