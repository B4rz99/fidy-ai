export function proveScopedCorrection(
  before: unknown,
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
