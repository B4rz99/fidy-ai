const noStore = { "cache-control": "no-store" } as const;

const invalid = (): Response =>
  Response.json({ status: "validation_failed" }, { status: 400, headers: noStore });

export const invalidHostedTurn = invalid;
