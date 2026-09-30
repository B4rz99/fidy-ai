import { EmailVerificationCode } from "@fidy/server/client";
import { Crypto, Effect, Option, Schema } from "effect";
import { RequestBodyPolicy, readBoundedRequestBody } from "../http/request-body";
import { completeOnboarding } from "./operations";

const Payload = Schema.Struct({ combinedCode: EmailVerificationCode });
const PayloadJson = Schema.fromJsonString(Payload);
const workerCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.tryPromise({
      try: () =>
        crypto.subtle
          .digest(algorithm, new Uint8Array(data))
          .then((buffer) => new Uint8Array(buffer)),
      catch: () => undefined,
    }).pipe(Effect.orDie),
});
const maximumBodyBytes = 512;
const requestBodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: maximumBodyBytes,
  deadlineMilliseconds: 2_000,
});
const invalid = (): Response =>
  Response.json(
    {
      error: {
        code: "verification_invalid",
        message: "El código no es válido. Revisa el correo o solicita uno nuevo.",
      },
    },
    { status: 400, headers: { "cache-control": "no-store" } }
  );

const readCode = (request: Request): Effect.Effect<Option.Option<EmailVerificationCode>> =>
  Effect.gen(function* () {
    if (
      request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" ||
      Number(request.headers.get("content-length")) > maximumBodyBytes
    ) {
      return Option.none();
    }
    const bytes = yield* readBoundedRequestBody(request, requestBodyPolicy);
    return yield* Effect.try({
      try: () => {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return Option.map(Schema.decodeOption(PayloadJson)(text), (value) => value.combinedCode);
      },
      catch: () => undefined,
    });
  }).pipe(Effect.catchCause(() => Effect.succeedNone));

/**
 * Admit only bounded JSON mailbox proofs. Verification creates no session; callers must independently
 * exchange established proof for a browser-held pairing. Every response forbids caching Secrets.
 */
export const verifyOnboarding = ({
  request,
  db,
}: {
  readonly request: Request;
  readonly db: D1Database;
}): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const code = yield* readCode(request);
      if (Option.isNone(code)) return invalid();
      const result = yield* completeOnboarding({ db, combinedCode: code.value });
      switch (result._tag) {
        case "Invalid":
          return invalid();
        case "Unavailable":
          return Response.json(
            { status: "unavailable" },
            { status: 503, headers: { "cache-control": "no-store" } }
          );
        case "Created":
          return Response.json(
            { status: "created", backupRecoveryCode: result.backupRecoveryCode },
            { headers: { "cache-control": "no-store" } }
          );
      }
    }).pipe(Effect.provideService(Crypto.Crypto, workerCrypto))
  ).catch(() => invalid());
