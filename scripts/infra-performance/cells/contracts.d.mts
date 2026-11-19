export type Cost = { rowsRead: number; rowsWritten: number };
export type Call = Cost & { key: string };
export type Bounds = { maximum: Cost; statements: Record<string, Cost> };
export type Limits = Record<string, Bounds>;
export type Frame = {
  zeroOnly: boolean;
  closed: boolean;
  inflight: number;
  plan: Bounds | undefined;
  used: Cost;
  pending: Cost;
  calls: Call[];
  fault: boolean;
};
export type StatementReply = {
  success: boolean;
  meta: { rows_read: number; rows_written: number };
  results: Array<Record<string, unknown>>;
};
export type Statement = {
  bind(...params: unknown[]): Statement;
  all(): Promise<StatementReply>;
  run(): Promise<StatementReply>;
  first(column?: string): Promise<unknown>;
};
export type Database = {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<StatementReply[]>;
  withSession(...args: string[]): Database;
  getBookmark(): string | null;
};
export type Namespace = {
  idFromName(name: string): unknown;
  getByName(
    name: string,
    options?: unknown
  ): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
};
export type CoreEnvironment = {
  DB: Database;
  USER_TRANSACTION_COORDINATOR?: Namespace;
  ERASURE_REGISTRY_COORDINATOR?: Namespace;
};
export type IngressEnvironment = {
  EXPERIMENT_DEADLINE: string;
  EXPERIMENT_KEY: string;
  CF_VERSION_METADATA: { id: string };
};
