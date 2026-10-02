import type { UserId } from "@fidy/server/identity-reference";
import { Data, type Option } from "effect";
import type { OwnedStatement } from "../../../src/shell/_shared/owned-statement";

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
