export type CapturedHistory = Readonly<{
  data: ReadonlyArray<Readonly<{ id: string; counterparty?: string | null; revision: number }>>;
}>;

export function proveScopedCorrection(
  before: CapturedHistory,
  send: (method: "GET" | "PUT" | "POST", path: string, body?: unknown) => Promise<Response>
): Promise<
  Readonly<{
    before: string;
    committed: string;
    afterRollback: string;
    failedCallIndex: number;
    committedCorrections: number;
  }>
>;
