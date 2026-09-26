/** Apply a checked-in statement test migration to local D1 in statement order. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const applyStatementTestMigration = (db: D1Database, name: string): Promise<void> =>
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
