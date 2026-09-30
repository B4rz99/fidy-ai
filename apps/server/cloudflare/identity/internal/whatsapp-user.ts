import { Option, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import type { PreparedIdentityRead, WhatsAppResolutionInput } from "../contract";

const SubjectRow = Schema.Struct({ user_id: UserId });

export const prepareWhatsAppResolution = ({
  db,
  portfolioId,
  bsuid,
}: WhatsAppResolutionInput): PreparedIdentityRead<UserId> => ({
  statement: db
    .prepare("SELECT user_id FROM whatsapp_identities WHERE portfolio_id = ? AND bsuid = ?")
    .bind(portfolioId, bsuid),
  decode: (raw: unknown): Option.Option<UserId> =>
    Option.map(Schema.decodeUnknownOption(SubjectRow)(raw), ({ user_id }) => user_id),
});
