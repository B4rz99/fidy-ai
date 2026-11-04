import { it } from "@effect/vitest";
import { Clock, Effect, Option } from "effect";
import { afterAll, expect } from "vitest";
import { UserId } from "../../src/core/identity/contract";
import { getBoundOperationCatalog } from "../../src/shell/canonical-catalog/contract";
import type { AuthorizedCanonicalCaller } from "../canonical-admission/contract";
import { protectCanonicalRequest } from "../canonical-admission/operations";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import type { RecoveryAdmissionBinding } from "../recovery-activation/contract";
import { nativeRecoveryAdmission } from "../recovery-activation/native.test-fixture";
import { runRecoveryOperation } from "./operations";
import { runRecoveryFetch, withRecoveryStore } from "./runtime";
import "../../src/shell/api";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());

it.effect(
  "a native source D1 canonical 429 rollback settles its lease without granting domain work",
  () =>
    Effect.gen(function* () {
      const gate = yield* nativeRecoveryAdmission;
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db }));
      const current = yield* Clock.currentTimeMillis;
      const userId = UserId.make("10000000-0000-4000-8000-000000000001");
      const patId = "20000000-0000-4000-8000-000000000001";
      const digest = new Uint8Array(32).fill(1);
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
            )
            .bind(userId, current),
          db
            .prepare(`INSERT INTO pats(id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,created_at_ms,issued_at_ms,expires_at_ms,request_id)
        VALUES (?,?,'12345678',?,'agent','["read"]',7,?,?,?,?)`)
            .bind(
              patId,
              userId,
              digest,
              current,
              current,
              current + 604800000,
              "40000000-0000-4000-8000-000000000001"
            ),
        ])
      );
      const environment = {
        DB: db,
        RECOVERY_SOURCE_EPOCH: "source-epoch",
        RECOVERY_ADMISSION: { getByName: (): RecoveryAdmissionBinding => gate },
      };
      const selected = withRecoveryStore(environment);
      const context = yield* Effect.context<never>();
      const caller: AuthorizedCanonicalCaller = {
        _tag: "PAT",
        value: { userId, patId, digest, requiredScope: Option.some("read") },
      };
      const operation = Option.getOrThrow(
        Option.fromUndefinedOr(getBoundOperationCatalog().byId.get("transactions.listTransactions"))
      );
      let executions = 0;
      const call = (): Promise<Response> =>
        runRecoveryFetch({
          environment,
          context: Option.none(),
          work: () =>
            Effect.runPromiseWith(context)(
              protectCanonicalRequest({
                db: selected.DB,
                current,
                caller,
                operation,
                request: new Request("https://core.internal/transactions"),
                work: Effect.sync(() => {
                  executions++;
                  return Response.json({ data: [], next: [] });
                }),
              })
            ),
        });
      const burst = 10;
      for (let index = 0; index < burst; index++) {
        expect((yield* Effect.tryPromise(call)).status).toBe(200);
      }
      expect((yield* Effect.tryPromise(call)).status).toBe(429);
      expect(executions).toBe(burst);
      expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({ leases: 0 });
    }).pipe(Effect.scoped)
);

it.effect(
  "a forged root Error has no native acknowledgement and never releases its unknown lease",
  () =>
    Effect.gen(function* () {
      const gate = yield* nativeRecoveryAdmission;
      const environment = {
        RECOVERY_SOURCE_EPOCH: "source-epoch",
        RECOVERY_ADMISSION: { getByName: (): RecoveryAdmissionBinding => gate },
      };
      const native =
        "canonical_request_rate: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)";
      yield* Effect.tryPromise(() =>
        expect(
          runRecoveryOperation({
            environment,
            work: () =>
              Promise.reject(new Error(`D1_ERROR: ${native}`, { cause: new Error(native) })),
          })
        ).rejects.toThrow()
      );
      expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({ leases: 1 });
    }).pipe(Effect.scoped)
);

it.effect(
  "a native trigger cannot forge CHECK acknowledgement and unknown native failures remain held",
  () =>
    Effect.gen(function* () {
      const gate = yield* nativeRecoveryAdmission;
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("CREATE TABLE native_probe(value INTEGER)"),
          db.prepare(
            `CREATE TRIGGER forged_check BEFORE INSERT ON native_probe BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: canonical_child_guard_0: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)'); END`
          ),
        ])
      );
      const environment = {
        DB: db,
        RECOVERY_SOURCE_EPOCH: "source-epoch",
        RECOVERY_ADMISSION: { getByName: (): RecoveryAdmissionBinding => gate },
      };
      const selected = withRecoveryStore(environment);
      const response = yield* Effect.tryPromise(() =>
        runRecoveryFetch({
          environment,
          context: Option.none(),
          work: () =>
            selected.DB.prepare("INSERT INTO native_probe VALUES(1)")
              .run()
              .then(
                () => new Response("unexpected"),
                () => new Response("owner refusal", { status: 409 })
              ),
        })
      );
      expect(response.status).toBe(503);
      expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({ leases: 1 });
    }).pipe(Effect.scoped)
);
