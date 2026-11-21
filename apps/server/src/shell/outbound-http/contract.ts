import { type Cause, Data, type Effect, type Option, type Redacted } from "effect";
import { type EnrollmentMethod } from "~/core/subscription/contract";
import {
  type WhatsAppBusinessPhoneNumberId,
  type WhatsAppMediaId,
  type WhatsAppProviderMessageId,
} from "~/shell/channels/whatsapp/contract";

export type OutboundHttpFailureReason =
  | "response-body-failed"
  | "invalid-destination"
  | "response-too-large"
  | "transport-failed";

export class OutboundHttpFailure extends Data.TaggedError("OutboundHttpFailure")<{
  readonly reason: OutboundHttpFailureReason;
  readonly responseStatus: Option.Option<number>;
  readonly responseHeaders: Readonly<Record<string, string>>;
}> {}

export class OutboundHttpSetupError extends Data.TaggedError("OutboundHttpSetupError")<{
  readonly reason: "unavailable";
}> {}

export type OutboundHttpResponse = Readonly<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}>;

export type WompiTransactionBody = Readonly<{
  readonly amountInCents: number;
  readonly currency: string;
  readonly billingEmail: string;
  readonly sourceId: number;
  readonly reference: string;
  readonly method: EnrollmentMethod;
}>;

export type OutboundHttpRequest = Data.TaggedEnum<{
  KapsoMediaMetadata: {
    readonly mediaId: WhatsAppMediaId;
    readonly businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
  };
  KapsoMediaDownload: { readonly token: Redacted.Redacted<string> };
  KapsoMessageStatus: {
    readonly businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
    readonly messageId: WhatsAppProviderMessageId;
  };
  KapsoMessages: {
    readonly businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
    readonly body: string;
  };
  ResendEmailDelivery: { readonly idempotencyKey: string; readonly body: string };
  WompiMerchant: {};
  WompiNequiSandboxToken: { readonly outcome: "approved" | "declined" };
  WompiDaviplataSandboxToken: { readonly outcome: "approved" | "declined" };
  WompiDaviplataSandboxOtp: {
    readonly step: "send" | "confirm";
    readonly authorizationId: Redacted.Redacted<string>;
    readonly token: Redacted.Redacted<string>;
  };
  WompiNequiApproval: { readonly token: Redacted.Redacted<string> };
  WompiDaviplataApproval: { readonly token: Redacted.Redacted<string> };
  WompiCreatePaymentSource: { readonly body: string };
  WompiVoidPaymentSource: { readonly sourceId: number };
  WompiVerifyPaymentSource: { readonly sourceId: number };
  WompiCreateTransaction: { readonly body: WompiTransactionBody };
  WompiFindTransaction: { readonly transactionId: string };
  WompiSandboxRefund: { readonly body: string };
  WompiSandboxCardVoid: { readonly transactionId: string };
  CloudflareAccessSupportRecovery: { readonly body: string };
  CloudflareAccessSigningKeys: {};
}>;

export const OutboundHttpRequest = Data.taggedEnum<OutboundHttpRequest>();

export type ProviderOidcHttpRequest = Data.TaggedEnum<{
  SigningKeys: {};
  TokenExchange: {
    readonly code: Redacted.Redacted<string>;
    readonly verifier: Redacted.Redacted<string>;
  };
}>;

export const ProviderOidcHttpRequest = Data.taggedEnum<ProviderOidcHttpRequest>();

type BancolombiaBankTokenRequest = {
  readonly assertion: Redacted.Redacted<string>;
  readonly token: Redacted.Redacted<string>;
  readonly tokenType: "access_token" | "refresh_token";
};

export type BancolombiaSandboxHttpRequest = Data.TaggedEnum<{
  Discovery: {};
  Authenticate: { readonly assertion: Redacted.Redacted<string> };
  RevokeBankToken: BancolombiaBankTokenRequest;
  InspectBankToken: BancolombiaBankTokenRequest;
  BankSigningKeys: {};
  ExchangeBankCode: {
    readonly assertion: Redacted.Redacted<string>;
    readonly code: Redacted.Redacted<string>;
    readonly verifier: Redacted.Redacted<string>;
  };
  ReadBankConsent: {
    readonly bearer: Redacted.Redacted<string>;
    readonly consentId: string;
    readonly interactionId: string;
  };
  ReadBankAccounts: {
    readonly bearer: Redacted.Redacted<string>;
    readonly interactionId: string;
    readonly page: Option.Option<number>;
  };
  CreateConsent: {
    readonly bearer: Redacted.Redacted<string>;
    readonly payload: Redacted.Redacted<string>;
    readonly financialId: string;
    readonly customerIpAddress: Option.Option<string>;
    readonly interactionId: string;
  };
  PushAuthorization: {
    readonly assertion: Redacted.Redacted<string>;
    readonly clientId: string;
    readonly consentId: string;
    readonly state: string;
    readonly challenge: string;
  };
}>;

export const BancolombiaSandboxHttpRequest = Data.taggedEnum<BancolombiaSandboxHttpRequest>();

export type ProviderOidcHttpService = Readonly<{
  execute: (
    request: ProviderOidcHttpRequest
  ) => Effect.Effect<OutboundHttpResponse, OutboundHttpFailure | Cause.TimeoutError>;
}>;

export type CliReleaseHttpService = Readonly<{
  readLatest: () => Effect.Effect<OutboundHttpResponse, OutboundHttpFailure>;
}>;

export type BancolombiaSandboxHttpService = Readonly<{
  execute: (
    request: BancolombiaSandboxHttpRequest
  ) => Effect.Effect<OutboundHttpResponse, OutboundHttpFailure | Cause.TimeoutError>;
}>;

export type OpenAiHttpService = Readonly<{
  execute: (body: string) => Effect.Effect<OutboundHttpResponse, OutboundHttpFailure>;
}>;
