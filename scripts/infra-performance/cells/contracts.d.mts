export type Cost = { rowsRead: number; rowsWritten: number };
export type Call = Cost & { key: string; child?: string; calls?: Call[] };
export type Bounds = { maximum: Cost; statements: Record<string, Cost> };
export type Limits = Record<string, Bounds>;
export type Frame = {
  route: string;
  zeroOnly: boolean;
  training: boolean;
  closed: boolean;
  inflight: number;
  plan: Bounds;
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
  getBookmark(): ReturnType<D1DatabaseSession["getBookmark"]>;
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
  USER_TRANSACTION_COORDINATOR: Namespace;
  ERASURE_REGISTRY_COORDINATOR: Namespace;
};
export type IngressEnvironment = {
  EXPERIMENT_DEADLINE: string;
  EXPERIMENT_KEY: string;
  CF_VERSION_METADATA: { id: string };
};
export type MeterConfig = { training: boolean; limits: Limits; mutationSubject?: string };
export type PinnedCore = {
  fetch(request: Request, env: CoreEnvironment, execution: unknown): Promise<Response>;
};
export type PinnedCoordinator = new (
  state: unknown,
  env: CoreEnvironment
) => { fetch(request: Request): Promise<Response> };
export type PinnedIngress = {
  fetch(request: Request, env: IngressEnvironment): Promise<Response>;
};
