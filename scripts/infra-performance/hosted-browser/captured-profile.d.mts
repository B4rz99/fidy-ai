type Forward = (request: Request) => Promise<Response>;
type BrowserOptions = Readonly<{
  forwardWeb: Forward;
  network: "ordinary";
  observations: number;
  turn: (index: number, action: () => Promise<void>) => Promise<void>;
  afterRequest: (
    route: string,
    response: Response,
    event: Readonly<Record<string, unknown>>
  ) => Promise<void>;
}>;

export function runBrowser(
  config: Readonly<{
    origins: Readonly<{ api: string; browser: string }>;
    cookie: string;
    expected: unknown;
    workspace: Readonly<{ profile: unknown; review: unknown }>;
    forward: Forward;
  }> &
    Partial<BrowserOptions>
): Promise<void>;
