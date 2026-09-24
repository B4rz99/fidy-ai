import { Data, Effect } from "effect";
import { Miniflare } from "miniflare";

class FixtureFailure extends Data.TaggedError("FixtureFailure") {}
const fromPromise = <A>(tryPromise: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise({ try: tryPromise, catch: () => new FixtureFailure() }).pipe(Effect.orDie);

/** Isolated D1 fixture with the production CardEnrollment migration and caller-owned auth tables. */
export const makeCardEnrollmentD1 = Effect.fnUntraced(function* (
  name: string,
  authSchema: ReadonlyArray<string>
) {
  const instance = new Miniflare({
    workers: [
      {
        config: {
          compatibilityDate: "2026-09-08",
          env: { DB: { id: name, type: "d1" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                contents: "export default {fetch() {return new Response('ok')}}",
                type: "esm",
              },
            },
          },
          name,
          type: "worker",
        },
      },
    ],
  });
  yield* fromPromise(() => instance.ready);
  const db = yield* fromPromise(() => instance.getD1Database("DB"));
  yield* fromPromise(() => db.batch(authSchema.map((statement) => db.prepare(statement))));
  const migration = yield* fromPromise(() =>
    Bun.file(new URL("../migrations/0009_card_enrollment.sql", import.meta.url)).text()
  );
  for (const statement of migration
    .replace(/^--.*$/gmu, "")
    .trim()
    .split(/;\s*\n(?=CREATE |$)/u)) {
    yield* fromPromise(() => db.prepare(statement).run());
  }
  return { db, instance };
});
