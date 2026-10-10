import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterAll, expect } from "vitest";
import { observeBrowserCost } from "./browser-cost.test-fixture";
import { isolatedTestDatabases } from "./d1-test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const wait = <A>(work: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(work).pipe(Effect.orDie);

it.live("counts native D1 results once across direct reads, sessions and bound batches", () =>
  Effect.gen(function* () {
    const native = yield* wait(() => databases.acquire());
    yield* wait(() =>
      native.prepare("CREATE TABLE measured (id INTEGER PRIMARY KEY, value TEXT)").run()
    );
    const observed = observeBrowserCost(native);
    const session = observed.database.withSession("first-primary");
    const inserted = yield* wait(() =>
      session.batch([
        session.prepare("INSERT INTO measured VALUES (?, ?)").bind(1, "synthetic"),
        session.prepare("INSERT INTO measured VALUES (?, ?)").bind(2, "other"),
      ])
    );
    expect(observed.cost()).toEqual({
      rowsRead: inserted.reduce((sum, result) => sum + result.meta.rows_read, 0),
      rowsWritten: inserted.reduce((sum, result) => sum + result.meta.rows_written, 0),
    });
    const before = observed.cost();
    const expected = yield* wait(() =>
      native.prepare("SELECT value FROM measured WHERE id = 1").all()
    );
    expect(
      yield* wait(() => session.prepare("SELECT value FROM measured WHERE id = 1").first("value"))
    ).toBe("synthetic");
    const direct = yield* wait(() => observed.database.prepare("SELECT * FROM measured").all());
    expect(observed.cost()).toEqual({
      rowsRead: before.rowsRead + expected.meta.rows_read + direct.meta.rows_read,
      rowsWritten: before.rowsWritten,
    });
    expect(session.getBookmark()).toEqual(expect.any(String));
  })
);
