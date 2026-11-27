import { Clock, Effect } from "effect";
import { Directory as NativeDirectory, UserStore as NativeUserStore } from "../core-worker";
import { OwnerWorkRecovery } from "./work-recovery";
import { Maintenance as NativeMaintenance } from "./runtime";

export * from "../core-worker";

export { default } from "../core-worker";

type Environment = ConstructorParameters<typeof NativeMaintenance>[1];

type Peer = Environment["DIRECTORY"];

type Probe = { name: string; at: number; elapsedMs: number; status: number };

const observationUrl = "https://fixture.invalid/fleet-observations";

export class Maintenance extends NativeMaintenance {
  private readonly sample;

  constructor(state: DurableObjectState, env: Environment) {
    const clock = Effect.runSync(Clock.Clock);
    const sample = { active: 0, peak: 0, probes: new Array<Probe>() };

    const observe = (peer: Peer): Peer =>
      peer && {
        getByName: (name) => ({
          fetch: (input, init) => {
            const probe: Probe = {
              name,
              at: clock.currentTimeMillisUnsafe(),
              elapsedMs: 0,
              status: 0,
            };

            sample.probes.push(probe);
            sample.peak = Math.max(sample.peak, ++sample.active);

            return peer
              .getByName(name)
              .fetch(input, init)
              .then((response) => {
                probe.status = response.status;

                return response;
              })
              .finally(() => {
                probe.elapsedMs = clock.currentTimeMillisUnsafe() - probe.at;
                sample.active--;
              });
          },
        }),
      };

    super(state, {
      ...env,
      USER_STORE: observe(env.USER_STORE),
      PRICING: observe(env.PRICING),
      ERASURE: observe(env.ERASURE),
      DIRECTORY: observe(env.DIRECTORY),
    });
    this.sample = sample;
  }

  override fetch(request: Request): Promise<Response> {
    if (request.url !== observationUrl) return super.fetch(request);
    const snapshot = Response.json(this.sample);
    this.sample.probes.length = 0;
    this.sample.peak = this.sample.active;

    return Promise.resolve(snapshot);
  }
}

const digestLength = 64;

export class UserStore extends NativeUserStore {
  override fetch(request: Request): Promise<Response> {
    if (request.url !== "https://fixture.invalid/commit-then-crash") return super.fetch(request);

    const recovery = new OwnerWorkRecovery(this.ctx, this.env.MAINTENANCE);

    return Effect.runPromise(
      recovery.run(
        () =>
          Effect.runPromise(
            Effect.gen({ self: this }, function* () {
              this.ctx.storage.sql.exec(
                "INSERT INTO canonical_request_receipts VALUES (?,?,'transactions.createTransaction',?,0,200,NULL)",
                this.ctx.id.name ?? "",
                "a".repeat(digestLength),
                "b".repeat(digestLength)
              );

              yield* Effect.tryPromise(() => this.ctx.storage.sync());
              this.ctx.abort("fixture crash after commit before alarm");
            }).pipe(Effect.as(new Response(null, { status: 204 })))
          ),
        () => true
      )
    );
  }
}

export class Directory extends NativeDirectory {
  override fetch(request: Request): Promise<Response> {
    if (request.url !== "https://fixture.invalid/remove-directory-alarm") {
      return super.fetch(request);
    }

    return this.ctx.storage.deleteAlarm().then(() => new Response(null, { status: 204 }));
  }
}
