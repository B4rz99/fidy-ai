import { Maintenance } from "./runtime";
import { ownerCheckResponse, recoveryAlarmHeader } from "./contract";

type Environment = ConstructorParameters<typeof Maintenance>[1] & Readonly<{ MODE: string }>;

type Ledger = { names: string[]; active: number; peak: number; aborted: number; cancelled: number };

const slowReplyMs = 990;

const heldBody = (name: string, mode: string): boolean =>
  (name.endsWith("000000000001") && mode === "held-body") ||
  (name === "directory-v1" && mode === "held-fixed");

const reply = ({
  name,
  mode,
  signal,
  ledger,
}: Readonly<{
  name: string;
  mode: string;
  signal: AbortSignal;
  ledger: Ledger;
}>): Promise<Response> => {
  ledger.names.push(name);
  ledger.active++;
  ledger.peak = Math.max(ledger.peak, ledger.active);

  const transport = (): Promise<Response> => {
    if (mode === "slow-cleanup" || (name.endsWith("000000000001") && mode === "lost")) {
      const lost = Promise.withResolvers<Response>();

      if (mode === "slow-cleanup") {
        scheduler.wait(slowReplyMs).then(() => lost.reject(new Error("reply lost")), lost.reject);
      }

      signal.addEventListener(
        "abort",
        () => {
          ledger.aborted++;

          if (mode === "lost") lost.reject(new Error("reply lost"));
        },
        { once: true }
      );

      return lost.promise;
    }

    if (heldBody(name, mode)) {
      return Promise.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              ledger.cancelled++;

              return Promise.withResolvers<void>().promise;
            },
          }),
          { status: 503 }
        )
      );
    }

    if (name.endsWith("000000000002")) return Promise.resolve(new Response(null, { status: 503 }));

    const response = ownerCheckResponse();

    if (mode === "freshness") {
      response.headers.set(recoveryAlarmHeader, "idle");
      response.headers.set("fidy-schema-version", "1");
      response.headers.set("fidy-schema-release", "22530000-0000-4000-8000-000000000001");
      response.headers.set("fidy-storage-band", "normal");
    }

    return Promise.resolve(response);
  };

  return transport().finally(() => {
    ledger.active--;
  });
};

export class WatchdogFixture extends Maintenance {
  private readonly ledger;
  constructor(state: DurableObjectState, env: Environment) {
    const ledger: Ledger = { names: [], active: 0, peak: 0, aborted: 0, cancelled: 0 };

    const peer = {
      getByName: (name: string): Pick<Fetcher, "fetch"> => ({
        fetch: (input, init) =>
          reply({ name, mode: env.MODE, signal: new Request(input, init).signal, ledger }),
      }),
    };

    super(state, { ...env, DIRECTORY: peer, PRICING: peer, ERASURE: peer, USER_STORE: peer });
    this.ledger = ledger;
  }
  override fetch(request: Request): Promise<Response> {
    if (request.url === "https://fixture.invalid/ledger") {
      return Promise.resolve(Response.json(this.ledger));
    }

    return super.fetch(request);
  }
}
