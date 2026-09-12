import { Data } from "effect";

/**
 * Sentinel a migration fixture raises after its assertions so the enclosing transaction rolls back.
 * Migrations are exercised against the real schema without leaving applied state behind.
 */
export class RollbackMigrationFixture extends Data.TaggedError("RollbackMigrationFixture")<{}> {}
