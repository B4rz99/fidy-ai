import { Function, Option, Schema } from "effect";
import { EmailForwardingLocalPart } from "~/core/ingestion/reference";

/** Normalizes a provider mailbox field without trusting its display-name syntax. */
export const normalizedMailbox = (recipient: string): string => {
  const angleStart = recipient.lastIndexOf("<");
  const angleEnd = recipient.lastIndexOf(">");
  return (
    angleStart >= 0 && angleEnd > angleStart ? recipient.slice(angleStart + 1, angleEnd) : recipient
  )
    .trim()
    .toLocaleLowerCase("en-US");
};

/** Returns a validated forwarding token only for the configured ingestion domain. */
export const forwardingLocalPartForDomain: {
  (recipient: string, domain: string): Option.Option<EmailForwardingLocalPart>;
  (domain: string): (recipient: string) => Option.Option<EmailForwardingLocalPart>;
} = Function.dual(
  2,
  (recipient: string, domain: string): Option.Option<EmailForwardingLocalPart> => {
    const normalized = normalizedMailbox(recipient);
    const separator = normalized.lastIndexOf("@");
    if (separator <= 0 || normalized.slice(separator + 1) !== domain.toLocaleLowerCase("en-US")) {
      return Option.none();
    }
    return Schema.decodeOption(EmailForwardingLocalPart)(normalized.slice(0, separator));
  }
);
