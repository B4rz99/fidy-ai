import { afterAll, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { installTestSchema, isolatedTestDatabases, isolatedTestStorage } from "./d1-test-fixture";

const databases = isolatedTestDatabases();
const storage = isolatedTestStorage();
afterAll(() => Promise.all([databases.dispose(), storage.dispose()]));
const wait = <A>(work: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(work).pipe(Effect.orDie);

it.live("does not carry rows, altered schema, triggers, or indexes into the next database", () =>
  Effect.gen(function* () {
    const first = yield* wait(() => databases.acquire());
    yield* wait(() =>
      first.batch([
        first.prepare("CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT)"),
        first.prepare("CREATE INDEX changed_index ON records(value)"),
        first.prepare(
          "CREATE TRIGGER changed_trigger BEFORE INSERT ON records WHEN NEW.id = 'blocked' BEGIN SELECT RAISE(ABORT, 'blocked'); END"
        ),
        first.prepare("INSERT INTO records VALUES ('retained', 'first database')"),
        first.prepare("ALTER TABLE records ADD COLUMN extra TEXT"),
      ])
    );
    const second = yield* wait(() => databases.acquire());
    const schema = yield* wait(() =>
      second
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('records', 'changed_index', 'changed_trigger')"
        )
        .all()
    );
    expect(schema.results).toEqual([]);
    yield* wait(() => second.prepare("CREATE TABLE records (id TEXT PRIMARY KEY)").run());
    yield* wait(() => second.prepare("INSERT INTO records VALUES ('blocked')").run());
    const retained = yield* wait(() => first.prepare("SELECT id FROM records").all());
    expect(retained.results).toEqual([{ id: "retained" }]);
  })
);

it.live(
  "does not expose another test's R2 bytes, metadata, or deletion through the same object key",
  () =>
    Effect.gen(function* () {
      const first = yield* wait(() => storage.acquire());
      yield* wait(() =>
        first.bucket.put("same-key", "first", { customMetadata: { owner: "first" } })
      );
      const second = yield* wait(() => storage.acquire());
      expect(yield* wait(() => second.bucket.get("same-key"))).toBeNull();
      yield* wait(() => second.bucket.put("same-key", "second"));
      yield* wait(() => second.bucket.delete("same-key"));
      const retained = yield* wait(() => first.bucket.get("same-key"));
      expect(retained?.customMetadata).toEqual({ owner: "first" });
      expect(yield* wait(() => retained?.text() ?? Promise.resolve("missing"))).toBe("first");
    })
);

it.live("keeps allocating isolated bindings after filling one Worker process", () =>
  Effect.gen(function* () {
    for (let index = 0; index < 17; index += 1) {
      const db = yield* wait(() => databases.acquire());
      yield* wait(() => db.prepare("CREATE TABLE repeated_name (id TEXT)").run());
      expect(
        yield* wait(() => db.prepare("SELECT COUNT(*) AS count FROM repeated_name").first())
      ).toEqual({ count: 0 });
    }
  })
);

it.live("applies cached baseline seeds independently and retains real foreign-key rejection", () =>
  Effect.gen(function* () {
    for (let index = 0; index < 2; index += 1) {
      const db = yield* wait(() => databases.acquire());
      yield* wait(() =>
        installTestSchema({
          db: index === 0 ? db : new Proxy(db, {}),
          sources: [
            new URL("./migrations/0001_categories.sql", import.meta.url),
            new URL("./migrations/0002_resource_admission.sql", import.meta.url),
          ],
        })
      );
      expect(
        yield* wait(() => db.prepare("SELECT COUNT(*) AS count FROM categories").first())
      ).toEqual({ count: 16 });
      yield* wait(() =>
        expect(
          db.prepare("INSERT INTO resource_admission_grants VALUES ('missing-claim', 0, 1)").run()
        ).rejects.toThrow()
      );
      expect(
        yield* wait(() =>
          db.prepare("SELECT COUNT(*) AS count FROM resource_admission_grants").first()
        )
      ).toEqual({ count: 0 });
      yield* wait(() =>
        db.prepare("CREATE TABLE selected_category (id TEXT REFERENCES categories(id))").run()
      );
      yield* wait(() =>
        expect(
          db.prepare("INSERT INTO selected_category VALUES ('unknown')").run()
        ).rejects.toThrow()
      );
      yield* wait(() =>
        db
          .prepare("INSERT INTO selected_category VALUES ('10000000-0000-4000-8000-000000000016')")
          .run()
      );
    }
  })
);

it.live("rolls back the entire fixture schema when a later migration fails", () =>
  Effect.gen(function* () {
    const db = yield* wait(() => databases.acquire());
    const source = new URL("./migrations/0001_categories.sql", import.meta.url);
    const failing = new URL("./migrations/0057_recurring_offer_replacement.sql", import.meta.url);
    // Exercise Worker-local bootstrap and the fallback for independently wrapped bindings.
    for (const binding of [db, new Proxy(db, {})]) {
      yield* wait(() =>
        expect(
          installTestSchema({ db: binding, sources: [source, source, failing] })
        ).rejects.toThrow()
      );
      expect(
        yield* wait(() =>
          db.prepare("SELECT name FROM sqlite_master WHERE name = 'categories'").all()
        )
      ).toMatchObject({ results: [] });
    }
  })
);
