import { Effect, Schema } from "effect";
import { AuthoritativeSqliteStore } from "./runtime";
import { readSnapshotArtifact } from "../sqlite-snapshot/operations";
import { advanceSqliteImport } from "./operations";
import type { SqliteStoreEnvironment } from "./contract";
import { RecoveryClosedSourceEvidence, RecoveryTarget } from "../recovery-activation/contract";

type Environment = SqliteStoreEnvironment &
  Readonly<{
    ARTIFACTS: R2Bucket;
    STORE: DurableObjectNamespace<ImportStoreProof>;
    REFUSAL_STORE: DurableObjectNamespace<BootstrapRefusalProof>;
  }>;
const digestCharacters = 64;
const acceptedStatus = 200;
const unavailableStatus = 503;
const Command = Schema.Struct({
  artifactDigest: Schema.String,
  evidence: RecoveryClosedSourceEvidence,
});
/** Native fixture only: production serving code has no configure/import RPC. */
export class ImportStoreProof extends AuthoritativeSqliteStore {
  private readonly nativeState: DurableObjectState;
  private readonly fixtureEnvironment: Environment;
  constructor(state: DurableObjectState, environment: Environment) {
    super(state, environment);
    this.nativeState = state;
    this.fixtureEnvironment = environment;
  }
  identity(): RecoveryTarget {
    return Schema.decodeUnknownSync(RecoveryTarget)({
      namespaceId: this.fixtureEnvironment.SQLITE_STORE_NAMESPACE_ID,
      objectId: this.nativeState.id.toString(),
      manifest: this.fixtureEnvironment.SQLITE_STORE_MANIFEST,
      epoch: this.fixtureEnvironment.SQLITE_STORE_EPOCH,
    });
  }
  step(candidate: unknown): Promise<unknown> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const command = yield* Schema.decodeUnknownEffect(Command)(candidate);
        return yield* advanceSqliteImport({
          state: this.nativeState,
          environment: {
            ...this.fixtureEnvironment,
            SQLITE_STORE_ARTIFACT_DIGEST: command.artifactDigest,
          },
          readArtifact: (digest) =>
            readSnapshotArtifact({
              artifacts: this.fixtureEnvironment.ARTIFACTS,
              activationId: command.evidence.activationId,
              digest,
            }),
          authorization: {
            phase: "BootstrapAuthorized",
            target: this.identity(),
            artifactDigest: command.artifactDigest,
            evidence: command.evidence,
          },
        });
      })
    );
  }
  activateFixture(): Promise<void> {
    this.nativeState.storage.kv.put("store-seal", {
      manifest: this.fixtureEnvironment.SQLITE_STORE_MANIFEST,
      epoch: this.fixtureEnvironment.SQLITE_STORE_EPOCH,
      status: "verified",
    });
    this.nativeState.storage.kv.put("store-admission", {
      phase: "Open",
      epoch: this.fixtureEnvironment.SQLITE_STORE_EPOCH,
    });
    return Promise.resolve();
  }
  facts(): Promise<unknown> {
    const sql = this.nativeState.storage.sql;
    return Promise.resolve({
      rows: sql.exec("SELECT CAST(sequence AS TEXT) AS sequence FROM audit_entries").toArray(),
      money: sql.exec("SELECT amount FROM transactions").toArray(),
      foreignKeys: sql.exec("PRAGMA foreign_keys").toArray(),
      generation: sql
        .exec("SELECT generation FROM erasure_control WHERE kind='published'")
        .toArray(),
      sequence: sql
        .exec("SELECT CAST(seq AS TEXT) AS value FROM sqlite_sequence WHERE name='audit_entries'")
        .toArray(),
      credential: sql.exec("SELECT lower(hex(token_digest)) AS digest FROM web_sessions").toArray(),
      admission: this.nativeState.storage.kv.get("store-admission"),
      seal: this.nativeState.storage.kv.get("store-seal") ?? null,
    });
  }
}
/** Exercises the real configured constructor/alarm while the independent production accessor refuses. */
export class BootstrapRefusalProof extends AuthoritativeSqliteStore {
  private readonly nativeState: DurableObjectState;
  constructor(state: DurableObjectState, environment: Environment) {
    super(state, {
      ...environment,
      SQLITE_STORE_ACTIVATION_ID: "18460000-0000-4000-8000-000000000002",
      SQLITE_STORE_ARTIFACT_DIGEST: "f".repeat(digestCharacters),
      SQLITE_STORE_ARTIFACTS: environment.ARTIFACTS,
      ERASURE_BUCKET: environment.ARTIFACTS,
    });
    this.nativeState = state;
  }
  attempt(): Promise<Readonly<{ status: number; sealed: boolean; tables: number }>> {
    return super.alarm().then(
      () => this.observation(acceptedStatus),
      () => this.observation(unavailableStatus)
    );
  }
  private observation(
    status: number
  ): Readonly<{ status: number; sealed: boolean; tables: number }> {
    const rows = this.nativeState.storage.sql
      .exec("SELECT name FROM sqlite_schema WHERE name NOT GLOB '__cf_*' AND name NOT GLOB '_cf_*'")
      .toArray();
    return {
      status,
      sealed: this.nativeState.storage.kv.get("store-seal") !== undefined,
      tables: rows.length,
    };
  }
}
export default {
  fetch(request: Request, environment: Environment): Promise<Response> {
    const store = environment.STORE.getByName("authoritative-v1");
    const path = new URL(request.url).pathname;
    if (path === "/bootstrap-refusal") {
      return environment.REFUSAL_STORE.getByName("authoritative-v1")
        .attempt()
        .then((value) => Response.json(value));
    }
    if (path === "/activate-fixture") {
      return store.activateFixture().then(() => new Response(null, { status: 204 }));
    }
    if (path === "/identity") return store.identity().then((value) => Response.json(value));
    if (path === "/facts") {
      return Promise.resolve(store.facts()).then((value) => Response.json(value));
    }
    return request
      .json()
      .then((body) => store.step(body))
      .then((value) =>
        request.headers.has("x-fixture-drop-import-reply")
          ? new Response(null, { status: unavailableStatus })
          : Response.json(value)
      )
      .catch(() => new Response(null, { status: 503 }));
  },
};
