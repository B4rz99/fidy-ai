import { Data, Effect, Encoding, Option, Redacted, Schema } from "effect";
import {
  BillingEmail,
  CardEnrollmentDecisions,
  type CardEnrollmentType,
  type CardPaymentSubmissionType,
  PaymentRequestId,
  type PriceId,
  type SubscriptionEnrollmentClient,
} from "@/transport/client";
import { type CardFields, tokenizeCardWithWompi } from "@/transport/wompi-tokenization";
import { paymentSubmissionIsTerminal } from "./payment-status";

export type Enrollment = CardEnrollmentType;
export type PaymentSubmission = CardPaymentSubmissionType;

class EnrollmentSubmissionFailed extends Data.TaggedError("EnrollmentSubmissionFailed")<{}> {}

export type PreparedEnrollment = Extract<Enrollment, { status: "prepared" }>;

const uuidByteCount = 16;
const uuidVersionByteIndex = 6;
const uuidVariantByteIndex = 8;
const uuidVersionMask = 0x0f;
const uuidVersionBits = 0x40;
const uuidVariantMask = 0x3f;
const uuidVariantBits = 0x80;
const firstUuidSectionEnd = 8;
const secondUuidSectionEnd = 12;
const thirdUuidSectionEnd = 16;
const fourthUuidSectionEnd = 20;

const makePaymentRequestId = (): ReturnType<typeof PaymentRequestId.make> => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(uuidByteCount));
  bytes[uuidVersionByteIndex] =
    ((bytes[uuidVersionByteIndex] ?? 0) & uuidVersionMask) | uuidVersionBits;
  bytes[uuidVariantByteIndex] =
    ((bytes[uuidVariantByteIndex] ?? 0) & uuidVariantMask) | uuidVariantBits;
  const hex = Encoding.encodeHex(bytes);
  return PaymentRequestId.make(
    `${hex.slice(0, firstUuidSectionEnd)}-${hex.slice(firstUuidSectionEnd, secondUuidSectionEnd)}-${hex.slice(secondUuidSectionEnd, thirdUuidSectionEnd)}-${hex.slice(thirdUuidSectionEnd, fourthUuidSectionEnd)}-${hex.slice(fourthUuidSectionEnd)}`
  );
};

type PendingPayment = Extract<PaymentSubmission, { status: "payment-pending" }>;

export type EnrollmentGateway = Readonly<{
  prepare: (priceId: PriceId) => Promise<Enrollment>;
  submit: (
    enrollment: PreparedEnrollment,
    billingEmail: string,
    card?: CardFields
  ) => Promise<PaymentSubmission>;
  continue: (
    enrollmentId: PreparedEnrollment["enrollmentId"],
    billingEmail: string
  ) => Promise<PaymentSubmission>;
  observeBillingAttempt: (
    enrollmentId: PreparedEnrollment["enrollmentId"],
    billingAttemptId: PendingPayment["billingAttempt"]["id"]
  ) => Promise<PaymentSubmission>;
  status: (enrollmentId: PreparedEnrollment["enrollmentId"]) => Promise<Enrollment>;
}>;

type PaymentRequestStore = Map<string, ReturnType<typeof PaymentRequestId.make>>;
const paymentRequestStoragePrefix = "fidy.payment-request.";
type EnrollmentIdentity = Readonly<{ enrollmentId: PreparedEnrollment["enrollmentId"] }>;
const paymentRequestStorageKey = (enrollment: EnrollmentIdentity): string =>
  `${paymentRequestStoragePrefix}${enrollment.enrollmentId}`;

const paymentRequestFor = (
  paymentRequests: PaymentRequestStore,
  enrollment: EnrollmentIdentity
): ReturnType<typeof PaymentRequestId.make> => {
  const existing = paymentRequests.get(enrollment.enrollmentId);
  if (existing !== undefined) return existing;
  const persisted = Schema.decodeUnknownOption(PaymentRequestId)(
    globalThis.sessionStorage.getItem(paymentRequestStorageKey(enrollment))
  );
  if (Option.isSome(persisted)) {
    paymentRequests.set(enrollment.enrollmentId, persisted.value);
    return persisted.value;
  }
  const created = makePaymentRequestId();
  paymentRequests.set(enrollment.enrollmentId, created);
  globalThis.sessionStorage.setItem(paymentRequestStorageKey(enrollment), created);
  return created;
};

const completed = (
  paymentRequests: PaymentRequestStore,
  enrollment: EnrollmentIdentity,
  request: Promise<PaymentSubmission>
): Promise<PaymentSubmission> =>
  request.then((submission) => {
    if (paymentSubmissionIsTerminal(submission)) {
      paymentRequests.delete(enrollment.enrollmentId);
      globalThis.sessionStorage.removeItem(paymentRequestStorageKey(enrollment));
    }
    return submission;
  });

const makeSubmit =
  (
    clientService: SubscriptionEnrollmentClient,
    paymentRequests: PaymentRequestStore
  ): EnrollmentGateway["submit"] =>
  (enrollment, billingEmail, card) => {
    const common = {
      enrollmentId: enrollment.enrollmentId,
      paymentRequestId: paymentRequestFor(paymentRequests, enrollment),
      billingEmail: BillingEmail.make(billingEmail),
      decisions: CardEnrollmentDecisions.make({
        acceptedEndUserPolicy: true,
        acceptedPersonalDataAuthorization: true,
        authorizedRecurringCharges: true,
      }),
    };
    if (enrollment.paymentSourceMode === "reuse") {
      return completed(
        paymentRequests,
        enrollment,
        clientService.execute((client) =>
          client.subscriptionEnrollment.submit({
            payload: { paymentSourceMode: "reuse", ...common },
          })
        )
      );
    }
    if (card === undefined) return Effect.runPromise(Effect.die("card fields are required"));
    return completed(
      paymentRequests,
      enrollment,
      Effect.runPromise(
        tokenizeCardWithWompi(
          enrollment.wompiPublicKey,
          card,
          globalThis.fetch.bind(globalThis)
        ).pipe(
          Effect.map(Redacted.make),
          Effect.flatMap((cardToken) =>
            Effect.tryPromise({
              try: () =>
                clientService.execute((client) =>
                  client.subscriptionEnrollment.submit({
                    payload: { paymentSourceMode: "create", ...common, cardToken },
                  })
                ),
              catch: () => new EnrollmentSubmissionFailed(),
            })
          )
        )
      )
    );
  };

const makeContinue =
  (
    clientService: SubscriptionEnrollmentClient,
    paymentRequests: PaymentRequestStore
  ): EnrollmentGateway["continue"] =>
  (enrollmentId, billingEmail) => {
    const enrollment = { enrollmentId };
    return completed(
      paymentRequests,
      enrollment,
      clientService.execute((client) =>
        client.subscriptionEnrollment.submit({
          payload: {
            paymentSourceMode: "reuse",
            enrollmentId,
            paymentRequestId: paymentRequestFor(paymentRequests, enrollment),
            billingEmail: BillingEmail.make(billingEmail),
            decisions: CardEnrollmentDecisions.make({
              acceptedEndUserPolicy: true,
              acceptedPersonalDataAuthorization: true,
              authorizedRecurringCharges: true,
            }),
          },
        })
      )
    );
  };

/** Adapts the credentialed browser client and direct Wompi tokenizer into one UI workflow. */
export const makeEnrollmentGateway = (
  clientService: SubscriptionEnrollmentClient
): EnrollmentGateway => {
  const paymentRequests: PaymentRequestStore = new Map();
  return {
    continue: makeContinue(clientService, paymentRequests),
    observeBillingAttempt: (enrollmentId, billingAttemptId) =>
      completed(
        paymentRequests,
        { enrollmentId },
        clientService
          .execute((client) =>
            client.subscriptionEnrollment.billingAttempt({ params: { billingAttemptId } })
          )
          .then((billingAttempt) => ({
            status: "payment-pending" as const,
            enrollmentId,
            billingAttempt,
          }))
      ),
    prepare: (priceId) =>
      clientService.execute((client) =>
        client.subscriptionEnrollment.prepare({ payload: { priceId } })
      ),
    status: (enrollmentId) =>
      clientService.execute((client) =>
        client.subscriptionEnrollment.status({ params: { enrollmentId } })
      ),
    submit: makeSubmit(clientService, paymentRequests),
  };
};
