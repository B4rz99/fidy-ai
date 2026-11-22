import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { Base64Url, Hex } from "effect/encoding";
import { type AcceptanceProviderEnvironment, acceptancePaymentToken } from "../contract";

import { acceptanceSubject } from "../../release-isolation/operations";
import { digestBytes } from "../../secret-material/operations";

const digestLength = 64,
  sourceDigestLength = 12,
  providerIdLength = 32,
  hexRadix = 16;

const bad = 400,
  missing = 404,
  conflicting = 409;

const origin = "https://sandbox.wompi.co";

const freeOfCache = { "cache-control": "no-store" };

const answer = (data: unknown, status = 200): Response =>
  Response.json({ data }, { status, headers: freeOfCache });

const source = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literals(["CARD", "NEQUI"]),
  status: Schema.Literal("AVAILABLE"),
  customer_email: Schema.String,
});

const payment = Schema.Struct({
  id: Schema.String,
  reference: Schema.String,
  amount_in_cents: Schema.Int,
  payment_source_id: Schema.Int,
  currency: Schema.Literal("COP"),
  status: Schema.Literal("APPROVED"),
  finalized_at: Schema.String,
});

const incoming = Schema.Struct({
  amount_in_cents: Schema.Int.check(Schema.isGreaterThan(0)),
  payment_source_id: Schema.Int,
  currency: Schema.Literal("COP"),
  reference: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/u)),
});

const offer = Schema.Struct({
  type: source.fields.type,
  token: Schema.NonEmptyString,
  customer_email: Schema.NonEmptyString,
});

const objectKey = (env: AcceptanceProviderEnvironment, kind: string, id: string): string =>
  `_release-smoke/${env.RELEASE_GIT_SHA}/acceptance/wompi/${kind}/${id}`;

const get = Effect.fn(function* <A>(
  env: AcceptanceProviderEnvironment,
  key: string,
  schema: Schema.Codec<A>
) {
  const saved = yield* Effect.tryPromise(() => env.SMOKE_BUCKET.get(key));

  if (saved === null) return Option.none<A>();

  return Option.some(
    yield* Schema.decodeUnknownEffect(schema)(yield* Effect.tryPromise(() => saved.json()))
  );
});

const json = Schema.fromJsonString(Schema.Unknown);

const store = Effect.fn(function* (
  env: AcceptanceProviderEnvironment,
  key: string,
  value: unknown
) {
  const body = yield* Schema.encodeEffect(json)(value);

  return yield* Effect.tryPromise(() =>
    env.SMOKE_BUCKET.put(key, body, { onlyIf: { etagDoesNotMatch: "*" } })
  );
});

const merchantTerms = Effect.fn(function* (name: string) {
  const permalink = "https://acceptance.invalid/wompi/" + name + ".pdf";

  const material = yield* Schema.encodeEffect(json)({
    permalink,
    file_hash: "a".repeat(digestLength),
  });

  return {
    permalink,
    acceptance_token:
      "header." + Base64Url.encode(new TextEncoder().encode(material)) + ".signature",
  };
});

const acceptedMailbox = (env: AcceptanceProviderEnvironment, mailbox: string): boolean => {
  const suffix = "@example.test";

  return (
    mailbox.endsWith(suffix) &&
    acceptanceSubject({
      revision: env.RELEASE_GIT_SHA,
      issuer: "https://accounts.google.com",
      subject: mailbox.slice(0, -suffix.length),
    })
  );
};

const createSource = Effect.fn(function* (request: Request, env: AcceptanceProviderEnvironment) {
  const input = yield* Schema.decodeUnknownEffect(offer)(
    yield* Effect.tryPromise(() => request.json())
  );

  if (
    !acceptedMailbox(env, input.customer_email) ||
    input.token !==
      acceptancePaymentToken({
        kind: input.type,
        subject: input.customer_email.split("@")[0] ?? "",
      })
  ) {
    return answer({}, bad);
  }

  const digest = Hex.encode(
    yield* digestBytes(new TextEncoder().encode(input.customer_email + "/" + input.token))
  );

  const id = parseInt(digest.slice(0, sourceDigestLength), hexRadix),
    value = { id, type: input.type, status: "AVAILABLE", customer_email: input.customer_email };

  const key = objectKey(env, "source", String(id));
  yield* store(env, key, value);
  const retained = yield* get(env, key, source);

  return Option.isSome(retained) && retained.value.customer_email === input.customer_email
    ? answer(retained.value)
    : answer({}, conflicting);
});

const transact = Effect.fn(function* (request: Request, env: AcceptanceProviderEnvironment) {
  const input = yield* Schema.decodeUnknownEffect(incoming)(
    yield* Effect.tryPromise(() => request.json())
  );

  const known = yield* get(env, objectKey(env, "source", String(input.payment_source_id)), source);

  if (Option.isNone(known)) return answer({}, missing);

  const id =
    "fidy-" +
    Hex.encode(yield* digestBytes(new TextEncoder().encode(input.reference))).slice(
      0,
      providerIdLength
    );

  const key = objectKey(env, "transaction", id),
    now = yield* Clock.currentTimeMillis;

  yield* store(env, key, {
    ...input,
    id,
    status: "APPROVED",
    finalized_at: DateTime.formatIso(DateTime.makeUnsafe(now)),
  });
  const retained = yield* get(env, key, payment);

  if (
    Option.isNone(retained) ||
    retained.value.payment_source_id !== input.payment_source_id ||
    retained.value.amount_in_cents !== input.amount_in_cents
  ) {
    return answer({}, conflicting);
  }

  yield* store(env, objectKey(env, "first-charge", known.value.customer_email), {
    id,
    reference: input.reference,
    finalizedAt: retained.value.finalized_at,
  });

  return new Response(null, { status: 503 });
});

const providerRead = Effect.fn(function* (path: string, env: AcceptanceProviderEnvironment) {
  if (path === "/v1/merchants/pub_test_fidy_native_release") {
    return answer({
      presigned_acceptance: yield* merchantTerms("terms"),
      presigned_personal_data_auth: yield* merchantTerms("personal"),
    });
  }

  if (/^\/v1\/tokens\/nequi\/nequi_test_fidy_acceptance_[1-9][0-9]{0,3}$/u.test(path)) {
    return answer({ id: path.split("/").at(-1), status: "APPROVED" });
  }

  const id = path.split("/").at(-1) ?? "";

  if (/^\/v1\/payment_sources\/\d+$/u.test(path)) {
    const value = yield* get(env, objectKey(env, "source", id), source);

    return Option.isSome(value) ? answer(value.value) : answer({}, missing);
  }

  if (/^\/v1\/transactions\/fidy-[a-f0-9]{32}$/u.test(path)) {
    const value = yield* get(env, objectKey(env, "transaction", id), payment);

    return Option.isSome(value) ? answer(value.value) : answer({}, missing);
  }

  return answer({}, missing);
});

export const answerFixturePayment = Effect.fn(function* (
  request: Request,
  env: AcceptanceProviderEnvironment
) {
  const url = new URL(request.url);

  if (url.origin !== origin || url.search !== "") return new Response(null, { status: missing });

  if (request.method === "GET") return yield* providerRead(url.pathname, env);

  if (request.method === "POST" && url.pathname === "/v1/payment_sources") {
    return yield* createSource(request, env);
  }

  if (request.method === "POST" && url.pathname === "/v1/transactions") {
    return yield* transact(request, env);
  }

  return new Response(null, { status: missing });
});
