import { Data, Effect, Predicate, Schema } from "effect";
import { type ProviderRead, readProviderList } from "./native-provider-list";

export class RecoveryPinUnavailable extends Data.TaggedError("RecoveryPinUnavailable")<{
  reason: "missing" | "name matches another type" | "ambiguous" | "invalid ID";
}> {}

export const isRecoveryPinUnavailable = (value: unknown): value is RecoveryPinUnavailable =>
  Predicate.isTagged(value, "RecoveryPinUnavailable");

const loginMethod = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String,
  type: Schema.NonEmptyString,
});

const validId = Schema.is(Schema.String.check(Schema.isUUID()));

export const readRecoveryPin = Effect.fn(function* (read: ProviderRead, account: string) {
  const methods = yield* readProviderList(read, account + "access/identity_providers", loginMethod);
  const pins = methods.filter((method) => method.type === "onetimepin");
  const [pin] = pins;

  if (pin === undefined) {
    const nameMatches = methods.some((method) => method.name === "Fidy native recovery email PIN");

    return yield* new RecoveryPinUnavailable({
      reason: nameMatches ? "name matches another type" : "missing",
    });
  }

  if (pins.length !== 1) return yield* new RecoveryPinUnavailable({ reason: "ambiguous" });

  if (!validId(pin.id)) return yield* new RecoveryPinUnavailable({ reason: "invalid ID" });

  return pin.id;
});
