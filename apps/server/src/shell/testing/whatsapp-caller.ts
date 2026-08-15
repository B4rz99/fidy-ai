import { Option } from "effect";
import type { E164PhoneNumber } from "~/core/identity/reference";
import {
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "~/core/identity/reference";
import type { WhatsAppCaller } from "~/shell/channels/whatsapp/model";

/**
 * Builds integration-test caller evidence in `portfolio-test`: BSUID is `CO.` plus the phone's
 * digits, phone is present, and parent BSUID and username are absent.
 */
export const testWhatsAppCaller = (phoneNumber: E164PhoneNumber): WhatsAppCaller => ({
  businessPortfolioId: WhatsAppBusinessPortfolioId.make("portfolio-test"),
  businessScopedUserId: WhatsAppBusinessScopedUserId.make(`CO.${phoneNumber.slice(1)}`),
  parentBusinessScopedUserId: Option.none(),
  username: Option.none(),
  phoneNumber: Option.some(phoneNumber),
});
