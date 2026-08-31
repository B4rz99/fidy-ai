import { Data, Effect, Redacted } from "effect";
import {
  BillingEmail,
  CardEnrollmentDecisions,
  type CardEnrollmentType,
  type PriceId,
  type SubscriptionEnrollmentClient,
} from "@/transport/client";
import { type CardFields, tokenizeCardWithWompi } from "@/transport/wompi-tokenization";

export type Enrollment = CardEnrollmentType;

class EnrollmentSubmissionFailed extends Data.TaggedError("EnrollmentSubmissionFailed")<{}> {}

export type PreparedEnrollment = Extract<Enrollment, { status: "prepared" }>;

export type EnrollmentGateway = Readonly<{
  prepare: (priceId: PriceId) => Promise<Enrollment>;
  submit: (
    enrollment: PreparedEnrollment,
    billingEmail: string,
    card?: CardFields
  ) => Promise<Enrollment>;
  status: (enrollmentId: PreparedEnrollment["enrollmentId"]) => Promise<Enrollment>;
}>;

/** Adapts the credentialed browser client and direct Wompi tokenizer into one UI workflow. */
export const makeEnrollmentGateway = (
  clientService: SubscriptionEnrollmentClient
): EnrollmentGateway => ({
  prepare: (priceId) =>
    clientService.execute((client) =>
      client.subscriptionEnrollment.prepare({ payload: { priceId } })
    ),
  status: (enrollmentId) =>
    clientService.execute((client) =>
      client.subscriptionEnrollment.status({ params: { enrollmentId } })
    ),
  submit: (enrollment, billingEmail, card) => {
    const common = {
      enrollmentId: enrollment.enrollmentId,
      billingEmail: BillingEmail.make(billingEmail),
      decisions: CardEnrollmentDecisions.make({
        acceptedEndUserPolicy: true,
        acceptedPersonalDataAuthorization: true,
        authorizedRecurringCharges: true,
      }),
    };
    if (enrollment.paymentSourceMode === "reuse") {
      return clientService.execute((client) =>
        client.subscriptionEnrollment.submit({
          payload: { paymentSourceMode: "reuse", ...common },
        })
      );
    }
    if (card === undefined) return Effect.runPromise(Effect.die("card fields are required"));
    return Effect.runPromise(
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
    );
  },
});
