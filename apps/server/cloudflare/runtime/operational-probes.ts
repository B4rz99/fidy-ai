import { Effect, Exit, Schema } from "effect";

const Available = Schema.Struct({ usable: Schema.Literal(1) });
const probeUrl = "https://internal.invalid/operational/probe";
const probeSuccessStatus = 204;
export const coordinatorProbeName = "operational-health-probe";

export type CapabilityProbe = Readonly<{
  component: "capability";
  operation: "d1" | "requiredBindings" | "coordination" | "providerConfig";
  state: "healthy" | "unavailable";
}>;

/** Private readiness evidence; configuration means present, not that an external provider succeeded. */
export const inspectOperationalCapabilities = (
  input: Readonly<{
    d1: Readonly<{ prepare: (sql: string) => { first: () => Promise<unknown> } }>;
    coordinator: Readonly<{
      getByName: (name: string) => { fetch: (request: Request) => Promise<Response> };
    }>;
    requiredBindings: ReadonlyArray<boolean>;
    providerConfigured: boolean;
  }>
): Effect.Effect<ReadonlyArray<CapabilityProbe>> =>
  Effect.gen(function* () {
    const d1 = yield* Effect.exit(
      Effect.tryPromise(() => input.d1.prepare("SELECT 1 AS usable").first()).pipe(
        Effect.timeout("2 seconds"),
        Effect.flatMap(Schema.decodeUnknownEffect(Available))
      )
    );
    const coordination = yield* Effect.exit(
      Effect.tryPromise((signal) =>
        input.coordinator.getByName(coordinatorProbeName).fetch(new Request(probeUrl, { signal }))
      ).pipe(Effect.timeout("2 seconds"))
    );
    const status = (ready: boolean): CapabilityProbe["state"] =>
      ready ? "healthy" : "unavailable";
    return [
      { component: "capability", operation: "d1", state: status(Exit.isSuccess(d1)) },
      {
        component: "capability",
        operation: "requiredBindings",
        state: status(input.requiredBindings.every(Boolean)),
      },
      {
        component: "capability",
        operation: "coordination",
        state: status(
          Exit.isSuccess(coordination) && coordination.value.status === probeSuccessStatus
        ),
      },
      {
        component: "capability",
        operation: "providerConfig",
        state: status(input.providerConfigured),
      },
    ];
  });
