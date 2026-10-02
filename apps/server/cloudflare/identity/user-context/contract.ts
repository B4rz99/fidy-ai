import type { UserId } from "../../../src/core/identity/contract";
import { Data, type Option } from "effect";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";

/** Identity context could not be read or validated; no private row or provider details escape. */
export class UserContextUnavailable extends Data.TaggedError("UserContextUnavailable")<{}> {}

/** One explicit stable User and, when required, the credential owner's guarded subject projection. */
export type UserContextRead = Readonly<{
  db: D1Database;
  userId: UserId;
  authority: Option.Option<OwnedStatement>;
}>;

/** Caller-owned context interpretation or snapshot action; no statement executes during preparation. */
export type UserContextStatement = Readonly<{
  db: D1Database;
  userId: UserId;
  statement: OwnedStatement;
}>;
