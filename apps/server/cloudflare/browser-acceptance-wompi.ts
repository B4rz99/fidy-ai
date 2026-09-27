import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { db, firstCardSourceId, sourceId } from "./browser-acceptance-seed";

export const providerPublicKey = `pub_test_${"f1d7c0de".repeat(3)}`;
export const providerPrivateKey = `prv_test_${"f1d7c0de".repeat(3)}`;
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
});
const monthlyChargeCents = 2_890_000;
const transactionPrefix = "acceptance-transaction-";
type ProviderAttempt = Readonly<{
  id: string;
  wompi_reference: string;
  amount: string;
  wompi_source_id: number;
  billing_email: string;
}>;
const matchesCharge = (charge: typeof WompiCharge.Type, attempt: ProviderAttempt): boolean =>
  charge.amount_in_cents === monthlyChargeCents &&
  charge.currency === "COP" &&
  charge.payment_source_id ===
    (attempt.billing_email === "tarjeta@example.com" ? firstCardSourceId : sourceId) &&
  charge.customer_email === attempt.billing_email &&
  attempt.amount === "28900";
// @effect-diagnostics-next-line asyncFunction:off
const decodeCharge = async (request: Request): Promise<Option.Option<typeof WompiCharge.Type>> => {
  if (request.method !== "POST") return Option.none();
  const body: unknown = await request.json();
  return Schema.decodeUnknownOption(WompiCharge)(body);
};
const providerKey = (
  request: Request,
  charge: Option.Option<typeof WompiCharge.Type>
): Option.Option<string> =>
  request.method === "POST"
    ? Option.map(charge, (decoded) => decoded.reference)
    : Option.fromNullishOr(
        new URL(request.url).pathname.split("/v1/transactions/")[1]?.replace(transactionPrefix, "")
      );
// @effect-diagnostics-next-line asyncFunction:off
const transactionResponse = async (request: Request): Promise<Response> => {
  const isCreate = request.method === "POST";
  const charge = await decodeCharge(request);
  const key = providerKey(request, charge);
  if (Option.isNone(key)) return new Response(null, { status: 400 });
  const column = isCreate ? "a.wompi_reference" : "a.id";
  const attempt = await db
    .prepare(`SELECT a.id, a.wompi_reference, a.amount, s.wompi_source_id,
    s.billing_email FROM billing_attempts AS a JOIN card_payment_sources AS s ON s.user_id = a.user_id
    WHERE ${column} = ?`)
    .bind(key.value)
    .first<ProviderAttempt>();
  if (attempt === null) return new Response(null, { status: 404 });
  if (isCreate && !matchesCharge(Option.getOrThrow(charge), attempt)) {
    return new Response(null, { status: 400 });
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
};
const SourceCreation = Schema.Struct({
  type: Schema.Literal("CARD"),
  token: Schema.String,
  customer_email: Schema.String,
  acceptance_token: Schema.String,
  accept_personal_auth: Schema.String,
});
// @effect-diagnostics-next-line asyncFunction:off
const createSourceResponse = async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const body: unknown = await request.json();
  const source = Schema.decodeUnknownOption(SourceCreation)(body);
  if (Option.isNone(source)) return new Response(null, { status: 400 });
  const expected = merchantBody.data;
  if (
    source.value.token !== "tok_acceptance_first_card" ||
    source.value.customer_email !== "tarjeta@example.com" ||
    source.value.acceptance_token !== expected.presigned_acceptance.acceptance_token ||
    source.value.accept_personal_auth !== expected.presigned_personal_data_auth.acceptance_token
  ) {
    return new Response(null, { status: 400 });
  }
  return Response.json({ data: { id: firstCardSourceId, status: "PENDING" } }, { status: 201 });
};
export const providerResponse = (request: Request): Promise<Response> => {
  const requestUrl = request.url;
  if (requestUrl.includes("/v1/transactions")) return transactionResponse(request);
  if (requestUrl.includes("/v1/merchants/")) return Promise.resolve(Response.json(merchantBody));
  if (requestUrl.includes(`/v1/payment_sources/${firstCardSourceId}`)) {
    return Promise.resolve(
      Response.json({
        data: { id: firstCardSourceId, status: "AVAILABLE", customer_email: "tarjeta@example.com" },
      })
    );
  }
  if (requestUrl.endsWith("/v1/payment_sources")) return createSourceResponse(request);
  if (requestUrl.includes(`/v1/payment_sources/${sourceId}`)) {
    return Promise.resolve(
      Response.json({
        data: { id: sourceId, status: "AVAILABLE", customer_email: "usuario@example.com" },
      })
    );
  }
  return Promise.resolve(Response.json({ data: { id: sourceId, status: "PENDING" } }));
};
