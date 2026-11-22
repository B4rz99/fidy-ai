import { Data } from "effect";
import type { EmailAddress } from "@/transport/client";

export type EmailReplacementViewState = Data.TaggedEnum<{
  Editing: { readonly feedback: EditingFeedback; readonly draftEmail: string };
  Requesting: { readonly candidateEmail: EmailAddress };
  AwaitingCode: { readonly candidateEmail: EmailAddress };
  Completing: { readonly candidateEmail: EmailAddress };
  InvalidCode: { readonly candidateEmail: EmailAddress };
  FreshPairingRequired: {};
  Replaced: {};
  Uncertain: {};
  PreparationUnavailable: {};
  Disposed: {};
}>;

export const EmailReplacementViewState = Data.taggedEnum<EmailReplacementViewState>();

type EditingFeedback = "none" | "invalid-candidate" | "request-unavailable";
