/** Fail-closed schema decoding used at every untrusted observability boundary. */
export const strictDecoding = { errors: "all", onExcessProperty: "error" } as const;
