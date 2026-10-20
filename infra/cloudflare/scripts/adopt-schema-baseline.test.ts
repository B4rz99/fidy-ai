import { Database } from "bun:sqlite";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { AppliedMigration } from "./migration-history";
import { adoptSchemaBaseline } from "./adopt-schema-baseline";

const source = "CREATE TABLE users(id TEXT PRIMARY KEY); CREATE INDEX user_lookup ON users(id);";
const target = { name: "0001_schema.sql", hash: "b".repeat(64) };
const withDatabase = (work: (database: Database) => void): void => {
  const database = new Database(":memory:");
  try {
    database.exec(source);
    database.exec("INSERT INTO users VALUES('retained')");
    database.exec(
      "CREATE TABLE __alchemy_migrations(id INTEGER PRIMARY KEY,hash TEXT,created_at NUMERIC,name TEXT,applied_at TEXT)"
    );
    database
      .query("INSERT INTO __alchemy_migrations(hash,name)VALUES(?,?)")
      .run("a".repeat(64), "0162_budget_occurrences.sql");
    work(database);
  } finally {
    database.close();
  }
};
const ledger = (database: Database): ReadonlyArray<AppliedMigration> =>
  Schema.decodeUnknownSync(Schema.Array(AppliedMigration))(
    database.query("SELECT name,hash FROM __alchemy_migrations ORDER BY id").all()
  );
const adopt = (
  database: Database,
  query: (sql: string) => string
): ReadonlyArray<AppliedMigration> =>
  adoptSchemaBaseline({
    sources: [{ name: target.name, source }],
    checkedIn: [target],
    applied: ledger(database),
    query,
    ledger: () => ledger(database),
  });
const execute = (database: Database, sql: string): string =>
  JSON.stringify([{ success: true, results: database.query(sql).all() }]);

it("refuses schema drift before changing the migration ledger or User data", () => {
  withDatabase((database) => {
    const before = ledger(database);
    database.exec("DROP INDEX user_lookup");
    expect(() => adopt(database, (sql) => execute(database, sql))).toThrow("schema differs");
    expect(ledger(database)).toEqual(before);
    expect(database.query("SELECT * FROM users").all()).toEqual([{ id: "retained" }]);
  });
});

it("resumes an interrupted ledger replacement without replaying DDL or changing User data", () => {
  withDatabase((database) => {
    expect(() =>
      adopt(database, (sql) => {
        if (sql.startsWith("DELETE FROM __alchemy_migrations")) throw Error("interrupted");
        return execute(database, sql);
      })
    ).toThrow("interrupted");
    expect(ledger(database)).toHaveLength(2);
    expect(adopt(database, (sql) => execute(database, sql))).toEqual([target]);
    expect(adopt(database, (sql) => execute(database, sql))).toEqual([target]);
    expect(database.query("SELECT * FROM users").all()).toEqual([{ id: "retained" }]);
  });
});

it("adopts matching schema despite formatting differences in stored DDL", () => {
  withDatabase((database) => {
    expect(
      adopt(database, (sql) =>
        execute(database, sql).replaceAll("CREATE TABLE users", "CREATE  TABLE users")
      )
    ).toEqual([target]);
    expect(database.query("SELECT * FROM users").all()).toEqual([{ id: "retained" }]);
  });
});
