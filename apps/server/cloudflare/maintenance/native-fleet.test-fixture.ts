import { Maintenance as NativeMaintenance } from "./runtime";

export * from "../core-worker";
export { default } from "../core-worker";

type Environment = ConstructorParameters<typeof NativeMaintenance>[1];
type Peer = NonNullable<Environment["DIRECTORY"]>;
type Probe = { name: string; at: number; elapsedMs: number | null; status: number | null };
const observationUrl = "https://fixture.invalid/fleet-observations";

export class Maintenance extends NativeMaintenance {
  private readonly sample;

  constructor(state: DurableObjectState, env: Environment) {
    const sample = { active: 0, peak: 0, probes: new Array<Probe>() };
    const observe = (peer: Peer | undefined): Peer | undefined =>
      peer && {
        getByName: (name) => ({
          fetch: async (input, init) => {
            const probe: Probe = { name, at: Date.now(), elapsedMs: null, status: null };
            sample.probes.push(probe);
            sample.peak = Math.max(sample.peak, ++sample.active);
            try {
              const response = await peer.getByName(name).fetch(input, init);
              probe.status = response.status;
              return response;
            } finally {
              probe.elapsedMs = Date.now() - probe.at;
              sample.active--;
            }
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
