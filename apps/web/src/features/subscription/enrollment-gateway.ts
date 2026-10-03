import { Data, Effect, Option, Redacted, Schema } from "effect";
import { Hex } from "effect/encoding";
import {
  BillingEmail,
  type EnrollmentAvailability,
  EnrollmentDecisions,
  type EnrollmentMethod,
  type PaymentEnrollmentType,
  PaymentRequestId,
  type PaymentSubmissionType,
  type PriceId,
  type SubmitPaymentEnrollmentPayload,
  type SubscriptionEnrollmentClient,
} from "@/transport/client";
import { type CardFields, tokenizeCardWithWompi } from "@/transport/wompi-tokenization";
import { authorizeNequiWithWompi } from "@/transport/wompi-nequi";
import { type DaviplataFields, startDaviplataWithWompi } from "@/transport/wompi-daviplata";
import { type DaviplataChallenge, makeDaviplataChallenge } from "./daviplata-challenge";
import { paymentSubmissionIsTerminal } from "./payment-status";

export type Enrollment = PaymentEnrollmentType;
export type PaymentSubmission = PaymentSubmissionType;

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
  const hex = Hex.encode(bytes);
  return PaymentRequestId.make(
    `${hex.slice(0, firstUuidSectionEnd)}-${hex.slice(firstUuidSectionEnd, secondUuidSectionEnd)}-${hex.slice(secondUuidSectionEnd, thirdUuidSectionEnd)}-${hex.slice(thirdUuidSectionEnd, fourthUuidSectionEnd)}-${hex.slice(fourthUuidSectionEnd)}`
  );
};

type PendingPayment = Extract<PaymentSubmission, { status: "payment-pending" }>;

export type NequiFields = Readonly<{
  method: "nequi";
  phoneNumber: Redacted.Redacted<string>;
  onAwaiting: () => void;
  signal: AbortSignal;
}>;
export type PaymentFields = CardFields | NequiFields;

export type EnrollmentGateway = Readonly<{
  availability: () => Promise<EnrollmentAvailability>;
  startDaviplata: (
    enrollment: PreparedEnrollment,
    billingEmail: string,
    fields: DaviplataFields & Readonly<{ signal: AbortSignal }>
  ) => Promise<DaviplataChallenge>;
  prepare: (priceId: PriceId, method?: EnrollmentMethod) => Promise<Enrollment>;
  submit: (
    enrollment: PreparedEnrollment,
    billingEmail: string,
    fields?: PaymentFields
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
  resume: (enrollmentId: PreparedEnrollment["enrollmentId"]) => Promise<
    Option.Option<
      Readonly<{
        submission: PaymentSubmission;
        billingEmail: string;
      }>
    >
  >;
}>;

type PaymentRequestStore = Map<string, ReturnType<typeof PaymentRequestId.make>>;
const paymentRequestStoragePrefix = "fidy.payment-request.";
const billingEmailStoragePrefix = "fidy.billing-email.";
type EnrollmentIdentity = Readonly<{ enrollmentId: PreparedEnrollment["enrollmentId"] }>;
const paymentRequestStorageKey = (enrollment: EnrollmentIdentity): string =>
  `${paymentRequestStoragePrefix}${enrollment.enrollmentId}`;
const billingEmailStorageKey = (enrollment: EnrollmentIdentity): string =>
  `${billingEmailStoragePrefix}${enrollment.enrollmentId}`;

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
      globalThis.sessionStorage.removeItem(billingEmailStorageKey(enrollment));
    }
    return submission;
  });

type SubmissionFacts = Pick<
  SubmitPaymentEnrollmentPayload,
  "enrollmentId" | "paymentRequestId" | "billingEmail" | "decisions"
>;
const submissionFacts = (
  paymentRequests: PaymentRequestStore,
  enrollment: EnrollmentIdentity,
  billingEmail: string
): SubmissionFacts => ({
  enrollmentId: enrollment.enrollmentId,
  paymentRequestId: paymentRequestFor(paymentRequests, enrollment),
  billingEmail: BillingEmail.make(billingEmail),
  decisions: EnrollmentDecisions.make({
    acceptedEndUserPolicy: true,
    acceptedPersonalDataAuthorization: true,
    authorizedRecurringCharges: true,
  }),
});
const submitNewSource = (
  input: Readonly<{
    client: SubscriptionEnrollmentClient;
    enrollment: PreparedEnrollment;
    facts: SubmissionFacts;
    fields: PaymentFields;
  }>
): Promise<PaymentSubmission> => {
  const { client, enrollment, facts, fields } = input;
  if (enrollment.method === "nequi") {
    if (!("method" in fields)) {
      return Effect.runPromise(Effect.fail(new EnrollmentSubmissionFailed()));
    }
    return client.execute(
      (transport) =>
        authorizeNequiWithWompi({
          publicKey: enrollment.wompiPublicKey,
          phoneNumber: fields.phoneNumber,
          fetchImplementation: globalThis.fetch.bind(globalThis),
          onAwaiting: fields.onAwaiting,
        }).pipe(
          Effect.flatMap((nequiToken) =>
            transport.subscriptionEnrollment
              .submit({
                payload: {
                  paymentSourceMode: "create",
                  method: "nequi",
                  ...facts,
                  nequiToken,
                },
              })
              .pipe(Effect.ensuring(Effect.sync(() => Redacted.wipeUnsafe(nequiToken))))
          )
        ),
      { signal: fields.signal }
    );
  }
  if (enrollment.method !== "card" || "method" in fields) {
    return Effect.runPromise(Effect.fail(new EnrollmentSubmissionFailed()));
  }
  return client.execute((transport) =>
    tokenizeCardWithWompi(
      enrollment.wompiPublicKey,
      fields,
      globalThis.fetch.bind(globalThis)
    ).pipe(
      Effect.map(Redacted.make),
      Effect.flatMap((cardToken) =>
        transport.subscriptionEnrollment.submit({
          payload: {
            paymentSourceMode: "create",
            method: "card",
            ...facts,
            cardToken,
          },
        })
      )
    )
  );
};

const makeSubmit =
  (
    clientService: SubscriptionEnrollmentClient,
    paymentRequests: PaymentRequestStore
  ): EnrollmentGateway["submit"] =>
  (enrollment, billingEmail, fields) => {
    globalThis.sessionStorage.setItem(billingEmailStorageKey(enrollment), billingEmail);
    const common = submissionFacts(paymentRequests, enrollment, billingEmail);
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
    if (fields === undefined) {
      return Effect.runPromise(Effect.fail(new EnrollmentSubmissionFailed()));
    }
    return completed(
      paymentRequests,
      enrollment,
      submitNewSource({ client: clientService, enrollment, facts: common, fields })
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
            decisions: EnrollmentDecisions.make({
              acceptedEndUserPolicy: true,
              acceptedPersonalDataAuthorization: true,
              authorizedRecurringCharges: true,
            }),
          },
        })
      )
    );
  };

const makeStartDaviplata = (
  client: SubscriptionEnrollmentClient,
  paymentRequests: PaymentRequestStore
): EnrollmentGateway["startDaviplata"] => {
  const started = new Set<string>();
  return (enrollment, billingEmail, fields) =>
    client
      .execute(
        () =>
          Effect.gen(function* () {
            if (
              enrollment.method !== "daviplata" ||
              enrollment.paymentSourceMode !== "create" ||
              started.has(enrollment.enrollmentId)
            ) {
              Redacted.wipeUnsafe(fields.documentNumber);
              Redacted.wipeUnsafe(fields.productNumber);
              return yield* new EnrollmentSubmissionFailed();
            }
            started.add(enrollment.enrollmentId);
            const facts = submissionFacts(paymentRequests, enrollment, billingEmail);
            const signal = AbortSignal.any([fields.signal, client.signal]);
            const provider = yield* startDaviplataWithWompi({
              publicKey: enrollment.wompiPublicKey,
              policy: enrollment.daviplataOtpPolicy,
              fields,
              fetchImplementation: globalThis.fetch.bind(globalThis),
              signal,
              expiresAt: enrollment.expiresAt.epochMilliseconds,
            });
            globalThis.sessionStorage.setItem(billingEmailStorageKey(enrollment), billingEmail);
            return makeDaviplataChallenge({
              provider,
              client,
              submitApproved: (daviplataToken) =>
                completed(
                  paymentRequests,
                  enrollment,
                  client.execute(
                    (transport) =>
                      transport.subscriptionEnrollment.submit({
                        payload: {
                          ...facts,
                          paymentSourceMode: "create",
                          method: "daviplata",
                          daviplataToken,
                        },
                      }),
                    { signal }
                  )
                ),
            });
          }),
        { signal: fields.signal }
      )
      .finally(() => {
        Redacted.wipeUnsafe(fields.documentNumber);
        Redacted.wipeUnsafe(fields.productNumber);
      });
};

/** Adapts the credentialed browser client and direct Wompi tokenizer into one UI workflow. */
export const makeEnrollmentGateway = (
  clientService: SubscriptionEnrollmentClient
): EnrollmentGateway => {
  const paymentRequests: PaymentRequestStore = new Map();
  return {
    availability: () =>
      clientService.execute((client) => client.subscriptionEnrollment.availability({})),
    startDaviplata: makeStartDaviplata(clientService, paymentRequests),
    continue: makeContinue(clientService, paymentRequests),
    resume: (enrollmentId) => {
      const enrollment = { enrollmentId };
      const paymentRequest = Schema.decodeUnknownOption(PaymentRequestId)(
        globalThis.sessionStorage.getItem(paymentRequestStorageKey(enrollment))
      );
      const email = Schema.decodeUnknownOption(BillingEmail)(
        globalThis.sessionStorage.getItem(billingEmailStorageKey(enrollment))
      );
      if (Option.isNone(paymentRequest) || Option.isNone(email)) {
        return Promise.resolve(Option.none());
      }
      paymentRequests.set(enrollmentId, paymentRequest.value);
      return makeContinue(clientService, paymentRequests)(enrollmentId, email.value).then(
        (submission) => Option.some({ submission, billingEmail: email.value })
      );
    },
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
    prepare: (priceId, method = "card") =>
      clientService.execute((client) =>
        client.subscriptionEnrollment.prepare({ payload: { priceId, method } })
      ),
    status: (enrollmentId) =>
      clientService.execute((client) =>
        client.subscriptionEnrollment.status({ params: { enrollmentId } })
      ),
    submit: makeSubmit(clientService, paymentRequests),
  };
};
