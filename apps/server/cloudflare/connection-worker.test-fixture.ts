import { DurableObject } from "cloudflare:workers";
import { Effect, Option, Redacted, Schedule } from "effect";
import { UserStore as NativeUser } from "./core-worker";
import {
  type ConnectionAdapters,
  ConnectionAuthorizationUnavailable,
} from "./connections/contract";

export { default } from "./core-worker";

export * from "./core-worker";

const keyCharacters = 43;

const clientId = "10000000-0000-4000-8000-000000000001";

export class ConnectionProviderFixture extends DurableObject {
  private readonly page = Effect.fn({ self: this }, function* () {
    const store = this.ctx.storage;
    const count = yield* Effect.tryPromise(() => store.get<number>("calls"));
    yield* Effect.tryPromise(() => store.put("calls", (count ?? 0) + 1));

    const released = yield* Effect.tryPromise(() => store.get<boolean>("release")).pipe(
      Effect.repeat({
        while: (value) => value !== true,
        schedule: Schedule.spaced("20 millis"),
      }),
      Effect.timeoutOption("20 seconds")
    );

    if (Option.isNone(released)) return new Response(null, { status: 503 });

    return Response.json({
      movements: [
        {
          reference: "movement-one",
          transaction: {
            money: { amount: "42", currency: "COP" },
            direction: "outflow",
            counterparty: "Pago institución",
            occurredAt: "2025-01-01T00:00:00.000Z",
          },
        },
      ],
      nextCursor: null,
      checkpoint: "one",
    });
  });
  private readonly revoke = Effect.fn({ self: this }, function* (request: Request) {
    const store = this.ctx.storage;
    const label = new URL(request.url).searchParams.get("held");

    if (
      label === "failed" &&
      (yield* Effect.tryPromise(() => store.get<boolean>("allow-cleanup"))) !== true
    ) {
      return new Response(null, { status: 503 });
    }

    yield* Effect.tryPromise(() => store.put("last-revoked", label));
    const count = yield* Effect.tryPromise(() => store.get<number>("revocations"));
    yield* Effect.tryPromise(() => store.put("revocations", (count ?? 0) + 1));

    return new Response(null, { status: 204 });
  });
  override fetch(request: Request): Promise<Response> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const path = new URL(request.url).pathname;
        const store = this.ctx.storage;

        if (path === "/prepare") {
          const state = yield* Effect.tryPromise(() => request.text());
          yield* Effect.tryPromise(() => store.put("state", state));

          return new Response(null, { status: 204 });
        }

        if (path === "/page") return yield* this.page();

        if (path === "/allow-cleanup") {
          yield* Effect.tryPromise(() => store.put("allow-cleanup", true));

          return new Response(null, { status: 204 });
        }

        if (path === "/revoke") return yield* this.revoke(request);

        if (path === "/release") yield* Effect.tryPromise(() => store.put("release", true));

        return Response.json({
          lastRevoked: yield* Effect.tryPromise(() => store.get("last-revoked")),
          revocations: (yield* Effect.tryPromise(() => store.get<number>("revocations"))) ?? 0,
          state: yield* Effect.tryPromise(() => store.get("state")),
          calls: (yield* Effect.tryPromise(() => store.get<number>("calls"))) ?? 0,
        });
      })
    );
  }
}

const fixtureRevocation = (gate: Pick<Fetcher, "fetch">): ConnectionAdapters["cleanup"] =>
  Option.some({
    clientId,
    revoke: (input) =>
      Effect.gen(function* () {
        if (
          Option.isNone(input.grant.accessToken) ||
          !["test-grant", "failed-grant"].includes(Redacted.value(input.grant.accessToken.value))
        ) {
          return yield* new ConnectionAuthorizationUnavailable({ cause: undefined });
        }

        if (!input.observedTokens.includes("access_token")) {
          yield* input.recordActive("access_token");
        }

        const label =
          Redacted.value(input.grant.accessToken.value) === "test-grant" ? "active" : "failed";

        const reply = yield* Effect.tryPromise(() =>
          gate.fetch("https://fixture.invalid/revoke?held=" + label)
        );

        if (!reply.ok) return yield* new ConnectionAuthorizationUnavailable({ cause: undefined });
      }).pipe(Effect.mapError((cause) => new ConnectionAuthorizationUnavailable({ cause }))),
  });

export class UserStore extends NativeUser {
  private readonly gate;
  constructor(
    ctx: DurableObjectState,
    env: ConstructorParameters<typeof NativeUser>[1] & {
      CONNECTION_FIXTURE: DurableObjectNamespace;
    }
  ) {
    super(ctx, env);
    this.gate = env.CONNECTION_FIXTURE.getByName("provider");
  }
  override fetch(request: Request): Promise<Response> {
    if (request.url === "https://fixture.invalid/connection-recovery") {
      return super.alarm().then(
        () => new Response(null, { status: 204 }),
        () => new Response(null, { status: 503 })
      );
    }

    return super.fetch(request);
  }
  protected override connectionAdapters(): ConnectionAdapters {
    const gate = this.gate;
    const result = super.connectionAdapters();

    if (Option.isNone(result.preparation)) return result;

    return {
      preparation: Option.some({
        intent: result.preparation.value.intent,
        prepare: (input) =>
          Effect.gen(function* () {
            yield* input.recordConsent("test-consent");
            yield* Effect.tryPromise(() =>
              gate.fetch("https://fixture.invalid/prepare", { method: "POST", body: input.state })
            );

            return {
              url:
                "https://auth1-api-open-finance-sandbox.ambientesbc.com/auth?response_type=code&scope=accounts&client_id=" +
                clientId +
                "&request_uri=urn:ietf:params:oauth:request_uri:test",
              expiresAtMilliseconds: input.expiresAtMilliseconds,
            };
          }).pipe(Effect.mapError((cause) => new ConnectionAuthorizationUnavailable({ cause }))),
      }),
      cleanup: fixtureRevocation(gate),
      activation: Option.some({
        clientId,
        activate: (input) =>
          Effect.gen(function* () {
            const rejected = Redacted.value(input.code) === "reject-held";
            yield* input.retainGrant({
              accessToken: Option.some(Redacted.make(rejected ? "failed-grant" : "test-grant")),
              refreshToken: Option.none(),
              expiresAtMilliseconds: input.expiresAtMilliseconds,
            });

            if (rejected) {
              return yield* new ConnectionAuthorizationUnavailable({ cause: undefined });
            }

            return ["account-one"];
          }),
      }),
      grantKey: Option.some(Redacted.make("A".repeat(keyCharacters))),
      synchronization: Option.some({
        clientId,
        refreshIntervalMs: 3600000,
        page: () =>
          Effect.gen(function* () {
            const reply = yield* Effect.tryPromise(() =>
              gate.fetch("https://fixture.invalid/page")
            );

            if (!reply.ok) {
              return yield* new ConnectionAuthorizationUnavailable({ cause: undefined });
            }

            return yield* Effect.tryPromise(() => reply.json());
          }).pipe(Effect.mapError((cause) => new ConnectionAuthorizationUnavailable({ cause }))),
      }),
    };
  }
}
