import { Effect, Schema } from "effect";
import { registryCutover } from "./internal/registry-cutover";
import { makeErasureRegistryOwner, withErasureRecovery } from "./runtime";
import type { ErasureRegistryNamespace } from "./contract";

const Command = Schema.Literals([
  "migrate",
  "claim-loss",
  "lose",
  "refuse-publication",
  "allow-publication",
  "read",
  "advance",
]);
type Environment = Readonly<{ DB: D1Database; ERASURE_BUCKET: R2Bucket }>;

export { DeployedRegistryFixture, DeployedTransportFixture } from "../core-worker.test-fixture";

/** Fault injection stays at real native storage boundaries, inside this fixture only. */
export class RegistryCutoverFixture {
  private readonly state: DurableObjectState;
  private readonly environment: Environment;
  constructor(state: DurableObjectState, environment: Environment) {
    this.state = state;
    this.environment = environment;
  }

  fetch(request: Request): Promise<Response> {
    return request
      .json()
      .then((value: unknown) => Schema.decodeUnknownSync(Command)(value))
      .then((command) => this.execute(command))
      .catch(() => new Response(null, { status: 503 }));
  }

  private execute(command: typeof Command.Type): Promise<Response> {
    if (command === "lose") {
      return this.state.storage.deleteAll().then(() => Response.json(null));
    }
    const bucket = this.environment.ERASURE_BUCKET;
    const controller = registryCutover({
      storage: this.state.storage,
      db: this.environment.DB,
      bucket: {
        get: bucket.get.bind(bucket),
        head: bucket.head.bind(bucket),
        delete: bucket.delete.bind(bucket),
        list: bucket.list.bind(bucket),
        put: (key, value, options) =>
          bucket.put(key, value, options).then((written) => {
            if (command === "claim-loss") throw new Error("fixture_acknowledgement_lost");
            return written;
          }),
      },
    });
    switch (command) {
      case "refuse-publication":
        this.state.storage.sql.exec(
          "CREATE TRIGGER refuse_registry_update BEFORE UPDATE ON erasure_registry BEGIN SELECT RAISE(ABORT,'fixture_refusal'); END"
        );
        return this.state.storage.sync().then(() => Response.json(null));
      case "allow-publication":
        this.state.storage.sql.exec("DROP TRIGGER refuse_registry_update");
        return this.state.storage.sync().then(() => Response.json(null));
      case "read": {
        return controller.registry
          .get("recovery/generation")
          .then((object) =>
            object === null
              ? Response.json(null)
              : object.text().then((value) => Response.json(value))
          );
      }
      case "advance":
        return controller.registry
          .put("recovery/generation", "12740000-0000-4000-8000-000000000088")
          .then(() => Response.json(null));
      case "migrate":
      case "claim-loss":
        return Effect.runPromise(controller.migrate).then((value) => Response.json(value));
    }
  }
}

type OwnerEnvironment = Environment &
  Readonly<{
    ERASURE_REGISTRY_COORDINATOR: ErasureRegistryNamespace;
    CALLBACK: ErasureRegistryNamespace;
  }>;
export class RegistryOwnerFixture {
  private readonly delegate: Pick<Fetcher, "fetch">;
  constructor(state: DurableObjectState, environment: OwnerEnvironment) {
    this.delegate = makeErasureRegistryOwner({
      state,
      environment: { ...environment, RELEASE_GIT_SHA: "native-fixture" },
      read: (request, bound) =>
        new URL(request.url).pathname === "/callback"
          ? bound.CALLBACK.getByName("user").fetch("https://callback.internal")
          : withErasureRecovery(bound)
              .DB.prepare("SELECT 1 AS accepted")
              .first()
              .then((row) => Response.json(row)),
    });
  }
  fetch(request: Request): Promise<Response> {
    return this.delegate.fetch(request).catch(() => new Response(null, { status: 503 }));
  }
}

export class RegistryCallbackFixture {
  private readonly environment: OwnerEnvironment;
  constructor(_state: DurableObjectState, environment: OwnerEnvironment) {
    this.environment = environment;
  }
  fetch(): Promise<Response> {
    return withErasureRecovery(this.environment)
      .DB.prepare("SELECT 1 AS accepted")
      .first()
      .then((row) => Response.json(row))
      .catch(() => new Response(null, { status: 503 }));
  }
}
