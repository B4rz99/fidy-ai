import { Array as Arr, Option, Predicate, Schema } from "effect";
import { OAuthNativeReview } from "../contract";

export const disclosureRevision = "oauth-native-1564-v1";

export const reviewLifetimeMilliseconds = 300000;

export const maximumInputBytes = 16384;

const AcceptedResponse = Schema.Struct({
  action: Schema.Literal("accept"),
  content: Schema.Struct({ confirm: Schema.Literal(true) }),
});

export const canonicalJson = (value: Schema.Json): Schema.Json => {
  if (
    Predicate.isNull(value) ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return value;
  }

  if (Arr.isArray<Schema.JsonArray | Schema.JsonObject>(value)) {
    return value.map(canonicalJson);
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key] ?? null)])
  );
};

export const acceptedNativeResponse = (input: Schema.Json): boolean =>
  Option.isSome(Schema.decodeUnknownOption(AcceptedResponse, { onExcessProperty: "error" })(input));

export const oauthReviewResponse = (review: OAuthNativeReview): Response =>
  Response.json(Schema.encodeSync(OAuthNativeReview)(review), {
    status: 409,
    headers: { "cache-control": "no-store", "fidy-oauth-review": "1" },
  });
