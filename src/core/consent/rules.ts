import { DateTime, Effect } from "effect";
import type {
  ConsentInboundContent,
  DisclosureSnapshot,
  PendingConsentExchange,
  PolicySnapshot,
} from "./model";

/** The only three outcomes allowed before the consent gate performs any effect. */
export type ConsentReplyDecision =
  | Readonly<{ readonly _tag: "Accepted" }>
  | Readonly<{ readonly _tag: "Declined" }>
  | Readonly<{ readonly _tag: "Clarify" }>;

const acceptedReplies = new Set([
  "acepto",
  "si, acepto",
  "si acepto",
  "acepto el tratamiento de mis datos",
]);
const declinedReplies = new Set(["no", "no acepto", "no autorizo", "rechazo"]);

const normalizeReply = (text: string): string =>
  text
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/gu, "")
    .trim()
    .toLocaleLowerCase("es-CO")
    .replaceAll(/[.!]+$/gu, "")
    .replaceAll(/\s+/gu, " ");

/**
 * Classifies one decoded reply using a closed explicit grammar. A bare “sí” is
 * deliberately ambiguous and never authorizes personal-data processing.
 */
export const decideConsentReply = (
  content: ConsentInboundContent
): Effect.Effect<ConsentReplyDecision> => {
  if (content._tag === "Choice") {
    return Effect.succeed(
      content.choice === "accept" ? { _tag: "Accepted" } : { _tag: "Declined" }
    );
  }

  const reply = normalizeReply(content.text);
  if (declinedReplies.has(reply)) return Effect.succeed({ _tag: "Declined" });
  if (acceptedReplies.has(reply)) return Effect.succeed({ _tag: "Accepted" });
  return Effect.succeed({ _tag: "Clarify" });
};

type AwaitingDisclosureDelivery = Extract<
  PendingConsentExchange,
  { readonly _tag: "AwaitingDisclosureDelivery" }
>;

type ReadonlyPolicySnapshot = Readonly<PolicySnapshot>;

type ReadonlyDisclosureSnapshot = Omit<
  Readonly<DisclosureSnapshot>,
  "policy" | "purposes" | "dataCategories"
> & {
  readonly policy: ReadonlyPolicySnapshot;
  readonly purposes: ReadonlyArray<DisclosureSnapshot["purposes"][number]>;
  readonly dataCategories: ReadonlyArray<DisclosureSnapshot["dataCategories"][number]>;
};

type PendingConsentInput = Omit<
  Readonly<AwaitingDisclosureDelivery>,
  "_tag" | "caller" | "disclosure" | "expiresAt"
> & {
  readonly disclosure: ReadonlyDisclosureSnapshot;
};

type PendingConsentDraft = Omit<AwaitingDisclosureDelivery, "caller">;

/** Starts one caller-independent pending draft with the fixed 24-hour legal lifetime. */
export const makePendingConsentDraft = (
  input: PendingConsentInput
): Effect.Effect<PendingConsentDraft> =>
  Effect.succeed({
    _tag: "AwaitingDisclosureDelivery",
    ...input,
    disclosure: {
      ...input.disclosure,
      purposes: [...input.disclosure.purposes],
      dataCategories: [...input.disclosure.dataCategories],
    },
    expiresAt: DateTime.add(input.createdAt, { hours: 24 }),
  });

/** Treats the exact 24-hour boundary as expired, never as one final valid instant. */
export const hasPendingConsentExpired = (
  input: Readonly<{
    readonly pending: Readonly<{ readonly expiresAt: DateTime.Utc }>;
    readonly now: DateTime.Utc;
  }>
): Effect.Effect<boolean> =>
  Effect.succeed(DateTime.isGreaterThanOrEqualTo(input.now, input.pending.expiresAt));
