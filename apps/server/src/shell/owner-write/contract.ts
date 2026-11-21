import type { Effect } from "effect";

export type OwnedStatement = Readonly<{
  sql: string;
  params: ReadonlyArray<string | number | Uint8Array>;
}>;

export type PreparedRead<A, E> = Readonly<{
  statement: OwnedStatement;
  decode: (rows: unknown) => Effect.Effect<A, E>;
}>;
