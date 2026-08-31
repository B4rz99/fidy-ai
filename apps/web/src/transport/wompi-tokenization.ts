import { UnknownJsonString, jsonStringSchema } from "@/schema-compatibility";
import { Data, Effect, Function, Result, Schema } from "effect";

/** Card fields stay in this browser-owned value only until Wompi answers. */
export type CardFields = Readonly<{
  number: string;
  cvc: string;
  expirationMonth: string;
  expirationYear: string;
  cardholderName: string;
}>;

export class CardTokenizationFailed extends Data.TaggedError("CardTokenizationFailed")<{}> {}

const maximumTokenCharacters = 4096;
const wompiExpirationYearCharacters = 2;
const WompiCardRequest = Schema.Struct({
  number: Schema.String,
  cvc: Schema.String,
  exp_month: Schema.String,
  exp_year: Schema.String,
  card_holder: Schema.String,
});
const encodeCardRequest = Schema.encodeSync(jsonStringSchema(WompiCardRequest));
const WompiTokenResponse = Schema.Struct({
  data: Schema.Struct({
    id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximumTokenCharacters)),
    brand: Schema.Literals(["VISA", "MASTERCARD"]),
  }),
});
const decodeTokenResponse = Schema.decodeUnknownResult(WompiTokenResponse);
const decodeJson = Schema.decodeUnknownResult(UnknownJsonString);
const maximumResponseBytes = 16_384;

const cancelReader = (reader: ReadableStreamDefaultReader<Uint8Array>): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => reader.cancel(),
    catch: () => new CardTokenizationFailed(),
  }).pipe(Effect.ignore);

const readBoundedResponse = (response: Response): Effect.Effect<string, CardTokenizationFailed> =>
  Effect.callback<string, CardTokenizationFailed>((resume) => {
    if (response.body === null) {
      resume(Effect.fail(new CardTokenizationFailed()));
      return;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const readNext = (): void => {
      reader.read().then(
        (next) => {
          if (next.done) {
            const bytes = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            resume(Effect.succeed(new TextDecoder().decode(bytes)));
            return;
          }
          total += next.value.byteLength;
          if (total > maximumResponseBytes) {
            resume(
              cancelReader(reader).pipe(Effect.andThen(Effect.fail(new CardTokenizationFailed())))
            );
            return;
          }
          chunks.push(next.value);
          readNext();
        },
        () => resume(Effect.fail(new CardTokenizationFailed()))
      );
    };
    readNext();
    return cancelReader(reader);
  });

const wompiOrigin = (publicKey: string): Effect.Effect<string, CardTokenizationFailed> => {
  if (publicKey.startsWith("pub_test_")) {
    return Effect.succeed("https://sandbox.wompi.co");
  }
  if (publicKey.startsWith("pub_prod_")) return Effect.succeed("https://production.wompi.co");
  return Effect.fail(new CardTokenizationFailed());
};

export type WompiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Sends card fields directly to Wompi and returns only its short-lived opaque token. */
export const tokenizeCardWithWompi: {
  (
    card: CardFields,
    fetchImplementation: WompiFetch
  ): (publicKey: string) => Effect.Effect<string, CardTokenizationFailed>;
  (
    publicKey: string,
    card: CardFields,
    fetchImplementation: WompiFetch
  ): Effect.Effect<string, CardTokenizationFailed>;
} = Function.dual(3, (publicKey: string, card: CardFields, fetchImplementation: WompiFetch) =>
  Effect.gen(function* () {
    const origin = yield* wompiOrigin(publicKey);
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImplementation(`${origin}/v1/tokens/cards`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${publicKey}`,
            "content-type": "application/json",
          },
          body: encodeCardRequest({
            number: card.number.replaceAll(/\s|-/gu, ""),
            cvc: card.cvc,
            exp_month: card.expirationMonth.padStart(2, "0"),
            exp_year: card.expirationYear.slice(-wompiExpirationYearCharacters),
            card_holder: card.cardholderName,
          }),
        }),
      catch: () => new CardTokenizationFailed(),
    });
    if (!response.ok) return yield* new CardTokenizationFailed();
    const text = yield* readBoundedResponse(response);
    const json = decodeJson(text);
    if (Result.isFailure(json)) return yield* new CardTokenizationFailed();
    const decoded = decodeTokenResponse(json.success);
    if (Result.isFailure(decoded)) return yield* new CardTokenizationFailed();
    return decoded.success.data.id;
  })
);
