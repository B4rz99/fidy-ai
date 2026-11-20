import type { DateTime, Option } from "effect";
import type {
  CapturedInterpretationContext,
  InterpretationRevision,
} from "~/core/interpretation-evidence/contract";
import type { Currency } from "~/core/_shared/money";
import type {
  AccountHints,
  NotificationCurrencyBasis,
  NotificationFormatId,
} from "~/core/transactions/contract";
import type { EmailDocument } from "./document";

export type FormatInterpretation = Readonly<{
  amount: string;
  currency: Currency;
  currencyBasis: NotificationCurrencyBasis;
  occurredAt: DateTime.Utc;
  accountHints: AccountHints;
}>;

export type NotificationEmailFormat = Readonly<{
  id: NotificationFormatId;
  revision: InterpretationRevision;
  routingAnchors: readonly [string, ...ReadonlyArray<string>];
  interpret: (
    document: EmailDocument,
    context: CapturedInterpretationContext
  ) => Option.Option<FormatInterpretation>;
}>;
