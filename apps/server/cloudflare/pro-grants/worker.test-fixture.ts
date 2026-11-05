import { Effect, Schema } from "effect";
import { AuthoritativeSqliteStore } from "../sqlite-store/runtime";
import { type SqliteStoreEnvironment, SqliteStoreRequest } from "../sqlite-store/contract";
import type { ProGrantOperatorBinding } from "./contract";

import type { RecoveryAdmissionBinding } from "../recovery-activation/contract";

export { ProGrantService } from "./runtime";
export { RecoveryAdmissionGate } from "../recovery-activation/runtime";

/** Native setup only; production Store bootstrap/open never uses these fixture seeds. */
export class ProStoreProof extends AuthoritativeSqliteStore {
  constructor(state: DurableObjectState, environment: SqliteStoreEnvironment) {
    super(state, environment);
    if (state.storage.kv.get("store-admission") !== undefined) return;
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
}
type Environment = Readonly<{
  PRO: ProGrantOperatorBinding;
  STORE_SETUP: DurableObjectNamespace<ProStoreProof>;
  RECOVERY_ADMISSION: Readonly<{ getByName: (name: string) => RecoveryAdmissionBinding }>;
}>;
export default {
  fetch(request: Request, environment: Environment): Promise<Response> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const path = new URL(request.url).pathname;
        const gate = environment.RECOVERY_ADMISSION.getByName("source-admission-v1");
        if (path === "/gate") return Response.json(yield* Effect.tryPromise(() => gate.inspect()));
        if (path === "/gate-close") {
          return Response.json(
            yield* Effect.tryPromise(() =>
              gate.close({
                activationId: "18460000-0000-4000-8000-000000000009",
                epoch: "pro-source",
              })
            )
          );
        }
        if (path === "/store-close") {
          return Response.json(
            yield* Effect.tryPromise(() =>
              Promise.resolve(
                environment.STORE_SETUP.getByName("authoritative-v1").close({
                  activationId: "18460000-0000-4000-8000-000000000009",
                  epoch: "fixture",
                })
              )
            )
          );
        }
        if (path === "/query") {
          const input = yield* Schema.decodeUnknownEffect(SqliteStoreRequest)(
            yield* Effect.tryPromise(() => request.json())
          );
          return Response.json(
            yield* Effect.tryPromise(() =>
              Promise.resolve(environment.STORE_SETUP.getByName("authoritative-v1").query(input))
            )
          );
        }
        const candidate = yield* Effect.tryPromise(() => request.json());
        return Response.json(
          yield* Effect.tryPromise(() => Promise.resolve(environment.PRO.execute(candidate)))
        );
      })
    );
  },
};
