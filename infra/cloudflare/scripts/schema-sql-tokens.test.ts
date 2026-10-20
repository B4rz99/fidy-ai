import { expect, it } from "vitest";
import { schemaSqlTokens } from "./schema-sql-tokens";

it("ignores formatting and comments while preserving quoted SQL contents", () => {
  expect(schemaSqlTokens("CREATE TABLE x (value TEXT DEFAULT 'a b');")).toEqual(
    schemaSqlTokens("CREATE\nTABLE x( /* schema */ value TEXT DEFAULT 'a b' ); -- end")
  );
  expect(schemaSqlTokens(`SELECT 'a -- b', 'it''s', "a b", [a b], \`a b\`;`)).toEqual([
    "SELECT",
    "'a -- b'",
    ",",
    "'it''s'",
    ",",
    '"a b"',
    ",",
    "[a b]",
    ",",
    "`a b`",
    ";",
  ]);
});

it("distinguishes changed literals, identifiers, operators and column order", () => {
  for (const changed of [
    "CREATE TABLE x(a TEXT DEFAULT 'ab',b INTEGER CHECK(b>=1))",
    "CREATE TABLE x(a TEXT DEFAULT 'a b',b INTEGER CHECK(b>1))",
    "CREATE TABLE x(b INTEGER CHECK(b>=1),a TEXT DEFAULT 'a b')",
    "CREATE TABLE x(ab TEXT DEFAULT 'a b',b INTEGER CHECK(b>=1))",
  ]) {
    expect(schemaSqlTokens(changed)).not.toEqual(
      schemaSqlTokens("CREATE TABLE x(a TEXT DEFAULT 'a b',b INTEGER CHECK(b>=1))")
    );
  }
});

it("preserves non-ASCII identifier characters rather than treating them as formatting", () => {
  expect(schemaSqlTokens("CREATE TABLE t(a\u0301 TEXT)")).not.toEqual(
    schemaSqlTokens("CREATE TABLE t(a \u0301 TEXT)")
  );
  expect(schemaSqlTokens("SELECT a\u00a0FROM t")).not.toEqual(schemaSqlTokens("SELECT a FROM t"));
});
