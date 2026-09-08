import type { DateTime, Option } from "effect";
import type { CapturedInterpretationContext } from "~/core/_shared/captured-interpretation-context";
import type { InterpretationRevision } from "~/core/_shared/interpretation-revision";
import type { Currency } from "~/core/_shared/money";
import type {
  AccountHints,
  NotificationCurrencyBasis,
  NotificationFormatId,
} from "~/core/transactions/account-hints";
import type { EmailDocument } from "./document";

/** Financial facts a format must establish before the shared canonical decoder may trust them. */
export type FormatInterpretation = Readonly<{
  amount: string;
  currency: Currency;
  currencyBasis: NotificationCurrencyBasis;
  occurredAt: DateTime.Utc;
  accountHints: AccountHints;
}>;

/**
 * Private format-author interface. Recognition only nominates a candidate; `interpret` must verify
 * the complete evidenced structure and returns absence for malformed, conflicting, or unsafe data.
 */
export type NotificationEmailFormat = Readonly<{
  id: NotificationFormatId;
  revision: InterpretationRevision;
  routingAnchors: readonly [string, ...ReadonlyArray<string>];
  interpret: (
    document: EmailDocument,
    context: CapturedInterpretationContext
  ) => Option.Option<FormatInterpretation>;
}>;
