import { Config, Effect, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestStorage, observeRetentionCost } from "../d1-test-fixture";
import { maintenancePerformanceDatabase } from "../maintenance-performance.test-fixture";
import { inspectWhatsApp } from "./operations";

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
const measure =
  Effect.runSync(Config.String("INFRA_PERFORMANCE_MEASURE").pipe(Config.withDefault("0"))) === "1";
const now = 1_800_000_000_000;
const subject = "10000000-0000-4000-8000-000000000001";

it(
  "keeps WhatsApp health inspection bounded as successful delivery history grows",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
        yield* Effect.tryPromise(() => installTestSchema({ db }));
        yield* Effect.tryPromise(() => bucket.put("recovery/generation", "initial"));
        const triggers = yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name IN ('hosted_turns_begin_pending','hosted_turn_requires_consent')"
            )
            .all()
        );
        const saved = yield* Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              name: Schema.String,
              sql: Schema.String,
            })
          )
        )(triggers.results);
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',0)"
              )
              .bind(subject),
            db
              .prepare(
                "INSERT INTO hosted_agent_sessions(id,user_id,consent_basis_json,started_at_ms,status) VALUES (?,?,'{}',0,'active')"
              )
              .bind(subject, subject),
            ...saved.map(({ name }) => db.prepare(`DROP TRIGGER ${name}`)),
            db
              .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2000)
          INSERT INTO hosted_turns(id,user_id,hosted_session_id,started_at_ms,terminal_at_ms,status,
            inbound_portfolio_id,inbound_bsuid,inbound_message_id,inbound_business_phone_number_id,inbound_occurred_at_ms,inbound_received_at_ms)
          SELECT 'turn-'||i,?,?,i*86400000,?,'completed','portfolio','subject','message-'||i,'phone',0,0 FROM n`)
              .bind(subject, subject, now - 1000),
            ...saved.map(({ sql }) => db.prepare(sql)),
            db
              .prepare(`INSERT INTO whatsapp_deliveries(kind,user_id,turn_id,text,correlation_token,business_phone_number_id,proposed_at_ms,state,provider_message_id,delivered_at_ms)
          SELECT 'hosted',user_id,id,'synthetic',id,'phone',?,'delivered',id,? FROM hosted_turns`)
              .bind(now - 2000, now - 1000),
          ])
        );
        let registryReads = 0;
        const observedBucket = new Proxy(bucket, {
          get(target, property): unknown {
            if (property === "get") {
              return (...args: Parameters<R2Bucket["get"]>): ReturnType<R2Bucket["get"]> => {
                registryReads++;
                return target.get(...args);
              };
            }
            return Reflect.get(target, property, target);
          },
        });
        const measured = observeRetentionCost(db);
        const guarded = maintenancePerformanceDatabase({
          db: measured.database,
          bucket: observedBucket,
        });
        const requests = measure ? 32 : 1;
        const timings: number[] = [];
        const started = performance.now();
        for (let request = 0; request < requests; request++) {
          const before = performance.now();
          const signal = yield* inspectWhatsApp({ db: guarded, current: now });
          timings.push(performance.now() - before);
          expect(signal).toMatchObject({
            state: "healthy",
            sampledPending: 0,
            sampledFailed: 0,
            overdueCleanup: 0,
          });
        }
        const elapsedMs = performance.now() - started;
        timings.sort((left, right) => left - right);
        if (measure) {
          const encoded = yield* Schema.encodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                requests: Schema.Int,
                rowsRead: Schema.Int,
                rowsWritten: Schema.Int,
                registryReads: Schema.Int,
                elapsedMs: Schema.Finite,
                p50Ms: Schema.Finite,
                p95Ms: Schema.Finite,
                requestsPerSecond: Schema.Finite,
              })
            )
          )({
            requests,
            ...measured.cost(),
            registryReads,
            elapsedMs,
            p50Ms: timings[Math.ceil(requests * 0.5) - 1] ?? 0,
            p95Ms: timings[Math.ceil(requests * 0.95) - 1] ?? 0,
            requestsPerSecond: (requests * 1000) / elapsedMs,
          });
          yield* Effect.sync(() => process.stdout.write(`INFRA_HEALTH ${encoded}\n`));
        }
        expect(measured.cost().rowsRead).toBeLessThan(100 * requests);
        expect(registryReads).toBe(requests);
        yield* Effect.tryPromise(() => db.prepare("ANALYZE").run());
        const beforeAnalyzed = measured.cost().rowsRead;
        expect(yield* inspectWhatsApp({ db: guarded, current: now })).toMatchObject({
          state: "healthy",
          sampledFailed: 0,
        });
        expect(measured.cost().rowsRead - beforeAnalyzed).toBeLessThan(100);
        yield* Effect.tryPromise(() => bucket.put("recovery/generation", "changed"));
        expect(yield* inspectWhatsApp({ db: guarded, current: now })).toEqual({
          component: "async-health",
          operation: "whatsapp",
          state: "unavailable",
        });
      })
    ),
  30_000
);
