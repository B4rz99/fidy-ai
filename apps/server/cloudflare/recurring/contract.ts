import { Data, type Option, Schema } from "effect";
import { UserId } from "../../src/core/identity/contract";

export const RecurringWork = Schema.Struct({ userId: UserId });

export class RecurringUnavailable extends Data.TaggedError("RecurringUnavailable")<{
  readonly cause: Option.Option<unknown>;
}> {}

export const recurringDiscoveryIntervalMs = 3_600_000;
