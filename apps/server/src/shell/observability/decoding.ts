/** Fail-closed schema decoding used at every untrusted observability boundary: a value carrying any
 * field its schema does not declare is rejected whole, never trimmed to fit. */
export const strictDecoding = { onExcessProperty: "error" } as const;
