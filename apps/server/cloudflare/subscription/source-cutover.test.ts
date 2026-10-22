import { Effect, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { isolatedTestDatabases } from "../d1-test-fixture";
import {
  documentedSqlBlock,
  precedingSchema,
  schemaDefinition,
  schemaObjectName,
  schemaStatements,
} from "../schema-cutover.test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const wait = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const identity = (kind: number, index: number): string =>
  `${kind}4490000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const replaced = ["users", "billing_attempts", "refund_attempts"];

it.each(["valid", "unknown-environment", "changed-method", "interrupted"] as const)(
  "extracts populated Subscription sources or rolls back %s history",
  (history) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* wait(() => databases.acquire());
        const original = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              originalDefinitions: Schema.Array(Schema.String),
              introducedNames: Schema.Array(Schema.String),
            })
          )
        )(
          yield* wait(() =>
            Bun.file(new URL("./source-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const standingHistory = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              originalDefinitions: Schema.Array(Schema.String),
              introducedNames: Schema.Array(Schema.String),
            })
          )
        )(
          yield* wait(() =>
            Bun.file(new URL("./standing-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const source = precedingSchema({
          current: precedingSchema({
            current: schemaStatements(
              yield* wait(() =>
                Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
              )
            ),
            history: yield* Schema.decodeEffect(
              Schema.fromJsonString(
                Schema.Struct({
                  originalDefinitions: Schema.Array(Schema.String),
                  introducedNames: Schema.Array(Schema.String),
                })
              )
            )(
              yield* wait(() =>
                Bun.file(
                  new URL("./cancellation-cutover.test-fixture.json", import.meta.url)
                ).text()
              )
            ),
          }),
          history: standingHistory,
        });
        const guide = yield* wait(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const old = new Map(
          original.originalDefinitions.map((sql) => [schemaObjectName(sql), sql])
        );
        const names = new Set(source.map(schemaObjectName));
        const missing = original.originalDefinitions.filter(
          (sql) => !names.has(schemaObjectName(sql))
        );
        const initial = missing.filter((sql) => /^CREATE (TABLE|VIEW)/u.test(sql));
        const rest = missing.filter((sql) => !initial.includes(sql));
        const legacy = [
          ...initial,
          ...source
            .filter((sql) => !original.introducedNames.includes(schemaObjectName(sql)))
            .map((sql) => old.get(schemaObjectName(sql)) ?? sql),
          ...rest,
        ];
        yield* wait(() => db.batch(legacy.map((sql) => db.prepare(sql))));
        for (const index of [1, 2]) {
          yield* wait(() =>
            db.batch([
              db
                .prepare(
                  "INSERT INTO users(rowid,id,service_market,locale,time_zone,created_at_ms,subscription_id) VALUES(?,?,'CO','es-CO','America/Bogota',1,?)"
                )
                .bind(10 + index, identity(1, index), index === 1 ? identity(6, index) : null),
              db
                .prepare(`INSERT INTO card_enrollments(rowid,id,user_id,price_id,billing_email,status,payment_source_mode,contracts_json,disclosure_json,prepared_at_ms,expires_at_ms,accepted_at_ms,payment_request_id,wompi_candidate_source_id,method,wompi_environment)
          VALUES(?,?,?,'22700000-0000-4000-8000-000000000001','payer@example.test','creating','create','{"revision":"original"}','{"accepted":"exact"}',100,900100,200,?,?,'card',?)`)
                .bind(
                  20 + index,
                  identity(2, index),
                  identity(1, index),
                  identity(5, index),
                  index,
                  index === 2 && history === "unknown-environment" ? null : "sandbox"
                ),
              db
                .prepare(
                  "UPDATE card_enrollments SET payment_source_id=?,source_wompi_id=?,source_billing_email=billing_email,source_created_at_ms=300,source_method='card' WHERE id=?"
                )
                .bind(identity(3, index), index, identity(2, index)),
              db
                .prepare("UPDATE card_enrollments SET status='available' WHERE id=?")
                .bind(identity(2, index)),
            ])
          );
        }
        yield* wait(() =>
          db
            .prepare(`INSERT INTO billing_attempts(rowid,id,user_id,enrollment_id,payment_request_id,payment_source_id,price_id,amount,currency,billing_period,service_market,tax_treatment,time_zone,wompi_environment,wompi_reference,created_at_ms)
        VALUES(51,?,?,?,?,?,'22700000-0000-4000-8000-000000000001','9900','COP','weekly','CO','not-taxable','America/Bogota','sandbox','historical-reference',400)`)
            .bind(identity(4, 1), identity(1, 1), identity(2, 1), identity(5, 1), identity(3, 1))
            .run()
        );
        // A source may be verified before a first charge. It still needs its recorded environment.
        if (history === "changed-method") {
          yield* wait(() =>
            db.batch([
              db.prepare("DROP TRIGGER card_source_immutable"),
              db
                .prepare("UPDATE card_enrollments SET source_method='nequi' WHERE id=?")
                .bind(identity(2, 2)),
              db.prepare(old.get("card_source_immutable") ?? ""),
            ])
          );
        }
        const state = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch(
            [
              "SELECT rowid,* FROM users ORDER BY id",
              "SELECT rowid,* FROM card_enrollments ORDER BY id",
              "SELECT rowid,* FROM billing_attempts",
              "SELECT * FROM refund_attempts",
              "SELECT * FROM erasure_archives",
              "SELECT * FROM sqlite_schema ORDER BY name",
            ].map((sql) => db.prepare(sql))
          );
        const before = (yield* wait(state)).map((result) => result.results);
        const schema = yield* wait(() =>
          db
            .prepare(
              "SELECT type,name FROM sqlite_schema WHERE type IN('trigger','view','index') AND name NOT LIKE 'sqlite_%'"
            )
            .all<{ type: string; name: string }>()
        );
        const shadows = replaced.map((target) =>
          schemaDefinition({ source, target }).replace(
            new RegExp(`CREATE TABLE "?${target}"?`, "u"),
            `CREATE TABLE ${target}_1449`
          )
        );
        // The runbook requires an explicit common-column manifest, excluding generated helpers.
        const copies: string[] = [];
        const checks: string[] = [];
        for (const target of replaced) {
          const info = yield* wait(() =>
            db.prepare(`PRAGMA table_xinfo(${target})`).all<{ name: string; hidden: number }>()
          );
          const columns = info.results
            .filter(
              (column) =>
                column.hidden === 0 && !(target === "users" && column.name === "subscription_id")
            )
            .map((column) => `"${column.name}"`)
            .join(",");
          copies.push(
            `INSERT INTO ${target}_1449(rowid,${columns}) SELECT rowid,${columns} FROM ${target}`
          );
          checks.push(
            `INSERT INTO sql_assertions(scope,accepted) SELECT 'subscription_source_cutover',CASE WHEN NOT EXISTS(SELECT rowid,${columns} FROM ${target} EXCEPT SELECT rowid,${columns} FROM ${target}_1449) AND NOT EXISTS(SELECT rowid,${columns} FROM ${target}_1449 EXCEPT SELECT rowid,${columns} FROM ${target}) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted`
          );
        }
        const plan = [
          ...documentedSqlBlock({ guide, marker: "subscription-source-preflight" }),
          ...["subscriptions", "payment_enrollments", "payment_sources"].map((target) =>
            schemaDefinition({ source, target })
          ),
          ...shadows,
          ...documentedSqlBlock({ guide, marker: "subscription-source-copy" }),
          ...copies,
          ...documentedSqlBlock({ guide, marker: "subscription-source-copy-check" }),
          ...checks,
          ...schema.results.map((object) => `DROP ${object.type.toUpperCase()} "${object.name}"`),
          ...["card_enrollments", ...replaced].map((target) => `DROP TABLE ${target}`),
          ...(history === "interrupted"
            ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('interrupted',0)"]
            : []),
          ...replaced.map((target) => `ALTER TABLE ${target}_1449 RENAME TO ${target}`),
          ...source.filter((sql) => /^CREATE (?:UNIQUE )?(?:VIEW|TRIGGER|INDEX) /u.test(sql)),
          ...documentedSqlBlock({ guide, marker: "subscription-source-verify" }),
        ];
        const apply = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch(plan.map((sql) => db.prepare(sql)));
        if (history !== "valid") {
          yield* wait(() => expect(apply()).rejects.toThrow());
          expect((yield* wait(state)).map((result) => result.results)).toEqual(before);
          return;
        }
        yield* wait(apply);
        expect(
          (yield* wait(() => db.prepare("SELECT rowid,* FROM billing_attempts").all())).results
        ).toEqual(before[2]);

        expect(
          yield* wait(() =>
            db
              .prepare("SELECT id,user_id,rowid FROM subscriptions WHERE user_id=?")
              .bind(identity(1, 1))
              .first()
          )
        ).toEqual({ id: identity(6, 1), user_id: identity(1, 1), rowid: 11 });
        expect(
          (yield* wait(() =>
            db
              .prepare(
                "SELECT id,origin_enrollment_id,wompi_environment,wompi_source_id,verified_at_ms,retired_at_ms,archive_row_ref FROM payment_sources ORDER BY id"
              )
              .all()
          )).results
        ).toEqual(
          [1, 2].map((index) => ({
            id: identity(3, index),
            origin_enrollment_id: identity(2, index),
            wompi_environment: "sandbox",
            wompi_source_id: index,
            verified_at_ms: 300,
            retired_at_ms: null,
            archive_row_ref: `source:${identity(3, index)}`,
          }))
        );
        expect((yield* wait(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
          []
        );
        yield* wait(() =>
          expect(
            db
              .prepare("UPDATE payment_enrollments SET payment_source_id=? WHERE id=?")
              .bind(identity(3, 2), identity(2, 1))
              .run()
          ).rejects.toThrow()
        );
      })
    )
);
