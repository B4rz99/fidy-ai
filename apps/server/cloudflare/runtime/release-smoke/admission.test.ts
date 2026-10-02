import { Database } from "bun:sqlite";
import { BunServices } from "@effect/platform-bun";
import { layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { expect } from "vitest";
import { maxActiveProbes, smokeAdmissionSql, smokeClaimSql } from "./internal/admission";

const migration = new URL("../../migrations/0027_release_smoke.sql", import.meta.url);
const revision = "0123456789abcdef0123456789abcdef01234567";
const now = 1_000_000;
const expires = now + 300_000;
const probeId = (index: number): string => index.toString(16).padStart(32, "0");
const readMigration = (): Promise<string> => Bun.file(migration).text();

const proveAdmission = (file: string, sql: string): void => {
  const first = new Database(file, { create: true });
  const second = new Database(file);
  try {
    first.exec(sql);
    first.exec("PRAGMA busy_timeout = 3000");
    second.exec("PRAGMA busy_timeout = 3000");
    const admit = (db: Database, index: number): void => {
      db.query(smokeAdmissionSql).run(probeId(index), revision, expires, now, maxActiveProbes);
    };
    for (let index = 0; index < maxActiveProbes + 2; index++) {
      admit(index % 2 === 0 ? first : second, index);
    }
    const count = (): unknown =>
      first.query("SELECT COUNT(*) AS total FROM release_smoke_probes").get();
    expect(count()).toEqual({ total: maxActiveProbes });
    first.query(smokeClaimSql).run(probeId(0), now);
    expect(first.query("SELECT changes() AS changed").get()).toEqual({ changed: 1 });
    second.query(smokeClaimSql).run(probeId(0), now);
    expect(second.query("SELECT changes() AS changed").get()).toEqual({ changed: 0 });
    admit(second, 0);
    expect(count()).toEqual({ total: maxActiveProbes });
    first.close();
    const reopened = new Database(file);
    try {
      expect(reopened.query("SELECT COUNT(*) AS total FROM release_smoke_probes").get()).toEqual({
        total: maxActiveProbes,
      });
      expect(
        reopened.query("SELECT status FROM release_smoke_probes WHERE probe_id = ?").get(probeId(0))
      ).toEqual({ status: "queued" });
    } finally {
      reopened.close();
    }
  } finally {
    first.close();
    second.close();
  }
};

const proveSql = (file: string, sql: string): Effect.Effect<void> =>
  Effect.sync(() => proveAdmission(file, sql));

/** SQLite runs the same D1 admission statements against the real migration across connections. */
layer(BunServices.layer)("release smoke admission persistence", (it) => {
  it.effect("caps distinct probes and atomically claims once across connections and reopen", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const directory = yield* fs.makeTempDirectory({ prefix: "fidy-smoke-admission-" });
      yield* Effect.gen(function* () {
        const file = paths.join(directory, "smoke.sqlite");
        const sql = yield* Effect.tryPromise(readMigration);
        yield* proveSql(file, sql);
      }).pipe(
        Effect.ensuring(fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie))
      );
    })
  );
});
