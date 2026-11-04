import { Effect, Schema } from "effect";
import { AuthoritativeSqliteStore } from "../sqlite-store/runtime";
import { makeSqliteBootstrapTarget } from "../sqlite-store/operations";
import { type SqliteStoreEnvironment, SqliteStoreRequest } from "../sqlite-store/contract";
import { RecoveryClosedSourceEvidence, RecoveryTarget } from "../recovery-activation/contract";
import { verifyImportedErasureCheckpoint } from "./operations";

type Environment = SqliteStoreEnvironment &
  Readonly<{
    REGISTRY: R2Bucket;
    STORE: DurableObjectNamespace<ImportedErasureProof>;
  }>;
/** Native-only bootstrap fixture; none of these setup methods belongs to the serving class. */
export class ImportedErasureProof extends AuthoritativeSqliteStore {
  private readonly nativeState: DurableObjectState;
  private readonly fixtureEnvironment: Environment;
  constructor(state: DurableObjectState, environment: Environment) {
    super(state, environment);
    this.nativeState = state;
    this.fixtureEnvironment = environment;
    state.storage.kv.put("store-seal", {
      manifest: environment.SQLITE_STORE_MANIFEST,
      epoch: environment.SQLITE_STORE_EPOCH,
      status: "verified",
    });
    state.storage.kv.put("store-admission", {
      phase: "Open",
      epoch: environment.SQLITE_STORE_EPOCH,
    });
  }
  prepare(evidence: RecoveryClosedSourceEvidence): Promise<void> {
    const storage = this.nativeState.storage;
    storage.kv.delete("store-seal");
    storage.kv.put("store-admission", {
      phase: "Closed",
      activationId: evidence.activationId,
      epoch: this.fixtureEnvironment.SQLITE_STORE_EPOCH,
    });
    storage.kv.put("store-bootstrap", {
      phase: "ErasureVerification",
      activationId: evidence.activationId,
      artifactDigest: this.fixtureEnvironment.SQLITE_STORE_ARTIFACT_DIGEST,
    });
    return Promise.resolve();
  }
  verify(evidence: RecoveryClosedSourceEvidence): Promise<unknown> {
    return this.verifyWithRegistry(evidence, this.fixtureEnvironment.REGISTRY);
  }
  verifyInterrupted(evidence: RecoveryClosedSourceEvidence): Promise<unknown> {
    const registry = this.fixtureEnvironment.REGISTRY;
    const interrupted = new Proxy(registry, {
      get: (bucket, property): unknown => {
        if (property === "put") {
          return (...args: Parameters<R2Bucket["put"]>): ReturnType<R2Bucket["put"]> =>
            bucket
              .put(...args)
              .then(() => Promise.reject(Error("Checkpoint reply lost after native write")));
        }
        const value: unknown = Reflect.get(bucket, property, bucket);
        return typeof value === "function" ? value.bind(bucket) : value;
      },
    });
    return this.verifyWithRegistry(evidence, interrupted);
  }
  private verifyWithRegistry(
    evidence: RecoveryClosedSourceEvidence,
    bucket: R2Bucket
  ): Promise<unknown> {
    const target = makeSqliteBootstrapTarget({
      state: this.nativeState,
      environment: this.fixtureEnvironment,
      activationId: evidence.activationId,
    });
    return Effect.runPromise(verifyImportedErasureCheckpoint({ target, evidence, bucket }));
  }

  identity(): Promise<RecoveryTarget> {
    return Promise.resolve(
      Schema.decodeUnknownSync(RecoveryTarget)({
        namespaceId: this.fixtureEnvironment.SQLITE_STORE_NAMESPACE_ID,
        objectId: this.nativeState.id.toString(),
        manifest: this.fixtureEnvironment.SQLITE_STORE_MANIFEST,
        epoch: this.fixtureEnvironment.SQLITE_STORE_EPOCH,
      })
    );
  }
  custody(): Promise<unknown> {
    return Promise.resolve(
      this.nativeState.storage.sql
        .exec(
          "SELECT custodian,state,current_event_id FROM erasure_custody_records WHERE record_type='current' ORDER BY custodian"
        )
        .toArray()
    );
  }

  marker(): Promise<unknown> {
    return Promise.resolve(
      this.nativeState.storage.sql
        .exec("SELECT generation FROM erasure_control WHERE kind='published'")
        .toArray()
    );
  }
}
const Command = Schema.Struct({
  action: Schema.Literals(["prepare", "verify", "interrupt"]),
  evidence: RecoveryClosedSourceEvidence,
});
export default {
  fetch(request: Request, environment: Environment): Promise<Response> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const store = environment.STORE.getByName("imported-target");
        const path = new URL(request.url).pathname;
        if (path === "/query") {
          const query = yield* Schema.decodeUnknownEffect(SqliteStoreRequest)(
            yield* Effect.tryPromise(() => request.json())
          );
          return Response.json(yield* Effect.tryPromise(() => Promise.resolve(store.query(query))));
        }
        if (path === "/identity") {
          return Response.json(yield* Effect.tryPromise(() => store.identity()));
        }
        if (path === "/custody") {
          return Response.json(yield* Effect.tryPromise(() => store.custody()));
        }
        if (path === "/marker") {
          return Response.json(yield* Effect.tryPromise(() => store.marker()));
        }
        const command = yield* Schema.decodeUnknownEffect(Command)(
          yield* Effect.tryPromise(() => request.json())
        );
        if (command.action === "prepare") {
          yield* Effect.tryPromise(() => store.prepare(command.evidence));
          return new Response(null, { status: 204 });
        }
        if (command.action === "interrupt") {
          return Response.json(
            yield* Effect.tryPromise(() => store.verifyInterrupted(command.evidence))
          );
        }
        return Response.json(yield* Effect.tryPromise(() => store.verify(command.evidence)));
      }).pipe(Effect.orElseSucceed(() => new Response(null, { status: 503 })))
    );
  },
};
