import { Function } from "effect";

const applyMigration = (db: D1Database, name: string): Promise<void> =>
  Bun.file(new URL(`../migrations/${name}.sql`, import.meta.url))
    .text()
    .then((sql) =>
      sql
        .replace(/^--.*$/gmu, "")
        .trim()
        .split(/;\s*\n(?=CREATE |ALTER |INSERT |DROP |$)/u)
        .reduce<Promise<void>>(
          (last, statement) => last.then(() => db.prepare(statement).run()).then(() => undefined),
          Promise.resolve()
        )
    );

/** Apply a checked-in statement test migration to local D1 in statement order. */
export const applyStatementTestMigration: {
  (name: string): (db: D1Database) => Promise<void>;
  (db: D1Database, name: string): Promise<void>;
} = Function.dual(2, applyMigration);
