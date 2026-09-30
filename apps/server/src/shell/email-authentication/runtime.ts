import { Config, Context, Effect, Layer, Option, type Redacted, Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";
import { UserId } from "~/core/identity/contract";
import { WebSessionId } from "~/core/web-session/contract";

import type { CanonicalImplementationCaller } from "~/shell/_shared/canonical-implementation";

import { decideOperationAccess, getOperationPolicy } from "~/shell/_shared/operation-policy";

import { FidyApi } from "~/shell/api";

import { OutboundHttp, makeResendOutboundHttp } from "~/shell/outbound-http/operations";

import type { EmailDeliveryPortService } from "./contract";

import { EmailSendFailed, deliverySender } from "./internal/delivery";

/** The Worker binds its two D1 handlers to these declared operations, not to a copied route table. */
export const emailReplacementOperations = {
  request: FidyApi.groups.emailAuthentication.endpoints.requestEmailReplacement,
  complete: FidyApi.groups.emailAuthentication.endpoints.completeEmailReplacement,
} as const;

/** The browser WebSession is the sole authority for the canonical replacement invocation. */
export const browserReplacementCaller = (session: {
  readonly userId: string;
  readonly id: string;
}): CanonicalImplementationCaller => ({
  resolved: {
    subjectUserId: UserId.make(session.userId),
    capabilities: [],
    authorityRoot: "no-verified-whatsapp-authority",
    auditCaller: { _tag: "WebSession", webSessionId: WebSessionId.make(session.id) },
    fresh: true,
  },
  accessTier: "free",
  confirmationEvidence: () => Option.none(),
});

type ReplacementOperation = keyof typeof emailReplacementOperations;

/** Fail closed if the declaration's browser access policy diverges from Worker authorization. */
export const permitsFreshBrowserReplacement = (operation: ReplacementOperation): boolean => {
  const { access } = getOperationPolicy(emailReplacementOperations[operation]);
  return (
    access._tag === "FreshWebSessionOnly" &&
    decideOperationAccess(access, { _tag: "WebSession", fresh: true })._tag === "Allowed"
  );
};

/** Send onboarding verification with the supplied Resend key; no other provider or local stub is used. */
export const makeOnboardingEmailDelivery = (
  input: Readonly<{
    apiKey: Redacted.Redacted<string>;
    httpClient: HttpClient.HttpClient;
  }>
): EmailDeliveryPortService =>
  deliverySender({
    outboundHttp: makeResendOutboundHttp(input),
    from: "Fidy <obarboza@fidyapp.com>",
  });

export class EmailDeliveryPort extends Context.Service<
  EmailDeliveryPort,
  EmailDeliveryPortService
>()("@fidy/server/shell/email-authentication/runtime/EmailDeliveryPort") {
  static readonly layer = Layer.effect(
    EmailDeliveryPort,
    Effect.gen(function* () {
      const environment = yield* Config.String("NODE_ENV").pipe(Config.withDefault("development"));
      if (environment !== "production") {
        return EmailDeliveryPort.of({
          send: () => new EmailSendFailed({ certainty: "rejected", retryable: false }),
        });
      }
      const outboundHttp = yield* OutboundHttp;
      const fromEmail = yield* Config.schema(
        Schema.Literal("obarboza@fidyapp.com"),
        "RESEND_FROM_EMAIL"
      );
      const fromName = yield* Config.schema(Schema.Literal("Fidy"), "RESEND_FROM_NAME");
      return EmailDeliveryPort.of(
        deliverySender({ outboundHttp, from: `${fromName} <${fromEmail}>` })
      );
    })
  );
}
