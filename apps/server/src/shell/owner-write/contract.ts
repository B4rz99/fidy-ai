export type OwnedStatement = Readonly<{
  sql: string;
  params: ReadonlyArray<string | number | Uint8Array>;
}>;
