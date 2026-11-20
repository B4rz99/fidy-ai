import type { CapturedHistory } from "./scoped-correction.mjs";

type Forward = (request: Request) => Promise<Response>;

export function runBrowser(
  config: Readonly<{
    variant: "d1" | "do";
    origins: Readonly<{ api: string; browser: string }>;
    cookie: string;
    expected: CapturedHistory;
    workspace: Readonly<{ profile: unknown; review: unknown }>;
    forward: Forward;
    forwardWeb?: Forward;
    network?: "ordinary";
    observations?: number;
    turn?: (index: number, action: () => Promise<void>) => Promise<void>;
    afterRequest?: (
      route: string,
      response: Response,
      event: Readonly<Record<string, unknown>>
    ) => Promise<void>;
  }>
): Promise<void>;
