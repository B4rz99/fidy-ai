/** One live-authority gate over the `pats` table: its table, predicate, and bindings. */
export type PATAuthority = Readonly<{
  table: "pats";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;
