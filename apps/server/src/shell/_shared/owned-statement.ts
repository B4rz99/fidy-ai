/** Parameterized owner write; the Cloudflare adapter binds and commits it without inspecting SQL. */
export type OwnedStatement = Readonly<{
  sql: string;
  params: ReadonlyArray<string | number | Uint8Array>;
}>;
