import { Data, Schema } from "effect";
import { UserId } from "../../src/core/identity/contract";

export const RecurringWork = Schema.Struct({ userId: UserId });

export class RecurringUnavailable extends Data.TaggedError("RecurringUnavailable") {}

export const recurringDiscoveryIntervalMs = 3_600_000;
