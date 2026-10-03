import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { db, firstCardSourceId, firstCardUserId, sourceId } from "./browser-acceptance-seed";

export const providerPublicKey = `pub_test_${"f1d7c0de".repeat(3)}`;
export const providerPrivateKey = `prv_test_${"f1d7c0de".repeat(3)}`;
// Reviewed synthetic fixture coordinates only; never real provider configuration or CORS evidence.
export const syntheticDaviplataSendUrl = "https://sandbox.wompi.co/fidy-synthetic-daviplata/send";
export const syntheticDaviplataConfirmUrl =
  "https://sandbox.wompi.co/fidy-synthetic-daviplata/confirm";
const syntheticDaviplataToken = "daviplata_devtest_acceptance";
const daviplataApprovalResponse = (request: Request): Response => {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  if (new URL(request.url).pathname !== `/v1/tokens/daviplata/${syntheticDaviplataToken}`) {
    return new Response(null, { status: 404 });
  }
  return Response.json({ data: { id: syntheticDaviplataToken, status: "APPROVED" } });
};
const signedAcceptance = (permalink: string, hash: string): string =>
  `header.${btoa(JSON.stringify({ permalink, file_hash: hash }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")}.signature`;
const contractHashLength = 64;
const merchantBody = {
  data: {
    presigned_acceptance: {
      acceptance_token: signedAcceptance(
        "https://wompi.example/end.pdf",
        "2".repeat(contractHashLength)
      ),
      permalink: "https://wompi.example/end.pdf",
    },
    presigned_personal_data_auth: {
      acceptance_token: signedAcceptance(
        "https://wompi.example/data.pdf",
        "3".repeat(contractHashLength)
      ),
      permalink: "https://wompi.example/data.pdf",
    },
  },
};
const WompiCharge = Schema.Struct({
  reference: Schema.String,
  amount_in_cents: Schema.Finite,
  payment_source_id: Schema.Finite,
  currency: Schema.String,
  customer_email: Schema.String,
  payment_method: Schema.optionalKey(Schema.Struct({ installments: Schema.Literal(1) })),
});
const monthlyChargeCents = 2_890_000;
const transactionPrefix = "acceptance-transaction-";
const ProviderAttempt = Schema.Struct({
  id: Schema.String,
  wompi_reference: Schema.String,
  amount: Schema.String,
  wompi_source_id: Schema.Finite,
  billing_email: Schema.String,
  method: Schema.Literals(["card", "nequi", "daviplata"]),
});
type ProviderAttempt = typeof ProviderAttempt.Type;
const matchesMethod = (charge: typeof WompiCharge.Type, attempt: ProviderAttempt): boolean =>
  attempt.method !== "daviplata" || charge.payment_method === undefined;
const matchesCharge = (charge: typeof WompiCharge.Type, attempt: ProviderAttempt): boolean =>
  charge.amount_in_cents === monthlyChargeCents &&
  charge.currency === "COP" &&
  charge.payment_source_id ===
    (attempt.billing_email === "tarjeta@example.com" ? firstCardSourceId : sourceId) &&
  charge.customer_email === attempt.billing_email &&
  attempt.amount === "28900";
const decodeCharge = (request: Request): Promise<Option.Option<typeof WompiCharge.Type>> =>
  request.method !== "POST"
    ? Promise.resolve(Option.none())
    : request.json().then((body: unknown) => Schema.decodeUnknownOption(WompiCharge)(body));
const providerKey = (
  request: Request,
  charge: Option.Option<typeof WompiCharge.Type>
): Option.Option<string> =>
  request.method === "POST"
    ? Option.map(charge, (decoded) => decoded.reference)
    : Option.fromNullishOr(
        new URL(request.url).pathname.split("/v1/transactions/")[1]?.replace(transactionPrefix, "")
      );
const transactionResponse = (request: Request): Promise<Response> =>
  decodeCharge(request).then((charge) => {
    const isCreate = request.method === "POST";
    const key = providerKey(request, charge);
    if (Option.isNone(key)) return new Response(null, { status: 400 });
    const column = isCreate ? "a.wompi_reference" : "a.id";
    return db
      .prepare(`SELECT a.id, a.wompi_reference, a.amount, s.wompi_source_id,
    s.billing_email, s.method FROM billing_attempts AS a JOIN card_payment_sources AS s ON s.user_id = a.user_id
    WHERE ${column} = ?`)
      .bind(key.value)
      .first()
      .then((row) => {
        const decoded = Schema.decodeUnknownOption(ProviderAttempt)(row);
        if (Option.isNone(decoded)) return new Response(null, { status: 404 });
        const attempt = decoded.value;
        if (isCreate) {
          const creation = Option.getOrThrow(charge);
          if (!matchesCharge(creation, attempt) || !matchesMethod(creation, attempt)) {
            return new Response(null, { status: 400 });
          }
        }
        return Response.json({
          data: {
            id: `${transactionPrefix}${attempt.id}`,
            reference: attempt.wompi_reference,
            status: "APPROVED",
            amount_in_cents: monthlyChargeCents,
            currency: "COP",
            payment_source_id: attempt.wompi_source_id,
            finalized_at: DateTime.formatIso(
              DateTime.makeUnsafe(Effect.runSync(Clock.currentTimeMillis))
            ),
          },
        });
      });
  });
const SourceCreation = Schema.Struct({
  type: Schema.Literals(["CARD", "DAVIPLATA"]),
  token: Schema.String,
  customer_email: Schema.String,
  acceptance_token: Schema.String,
  accept_personal_auth: Schema.String,
});
const createSourceResponse = (request: Request): Promise<Response> => {
  if (request.method !== "POST") return Promise.resolve(new Response(null, { status: 405 }));
  return request.json().then((body: unknown) => {
    const source = Schema.decodeUnknownOption(SourceCreation)(body);
    if (Option.isNone(source)) return new Response(null, { status: 400 });
    const expected = merchantBody.data;
    const expectedToken =
      source.value.type === "DAVIPLATA" ? syntheticDaviplataToken : "tok_acceptance_first_card";
    if (
      source.value.token !== expectedToken ||
      source.value.customer_email !== "tarjeta@example.com" ||
      source.value.acceptance_token !== expected.presigned_acceptance.acceptance_token ||
      source.value.accept_personal_auth !== expected.presigned_personal_data_auth.acceptance_token
    ) {
      return new Response(null, { status: 400 });
    }
    return Response.json({ data: { id: firstCardSourceId, status: "PENDING" } }, { status: 201 });
  });
};
const DaviplataCandidate = Schema.Struct({ method: Schema.Literal("daviplata") });
const candidateSourceResponse = (): Promise<Response> =>
  db
    .prepare(`SELECT method FROM card_enrollments WHERE user_id = ? AND wompi_candidate_source_id = ?
    AND status IN ('creating', 'verifying', 'available')`)
    .bind(firstCardUserId, firstCardSourceId)
    .first()
    .then((row) =>
      Response.json({
        data: {
          id: firstCardSourceId,
          type: Option.isSome(Schema.decodeUnknownOption(DaviplataCandidate)(row))
            ? "DAVIPLATA"
            : "CARD",
          status: "AVAILABLE",
          customer_email: "tarjeta@example.com",
        },
      })
    );
export const providerResponse = (request: Request): Promise<Response> => {
  const requestUrl = request.url;
  if (requestUrl.includes("/v1/transactions")) return transactionResponse(request);
  if (requestUrl.includes("/v1/merchants/")) return Promise.resolve(Response.json(merchantBody));
  if (new URL(requestUrl).pathname.startsWith("/v1/tokens/daviplata/")) {
    return Promise.resolve(daviplataApprovalResponse(request));
  }
  if (requestUrl.includes(`/v1/payment_sources/${firstCardSourceId}`)) {
    return candidateSourceResponse();
  }
  if (requestUrl.endsWith("/v1/payment_sources")) return createSourceResponse(request);
  if (requestUrl.includes(`/v1/payment_sources/${sourceId}`)) {
    return Promise.resolve(
      Response.json({
        data: {
          id: sourceId,
          type: "CARD",
          status: "AVAILABLE",
          customer_email: "usuario@example.com",
        },
      })
    );
  }
  return Promise.resolve(Response.json({ data: { id: sourceId, status: "PENDING" } }));
};
