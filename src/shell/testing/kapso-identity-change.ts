type KapsoIdentityChangeOverrides = Readonly<{
  providerMessageId?: string;
  timestamp?: string;
  previousBsuid?: string;
  replacementBsuid?: string;
  systemUserId?: string;
  phoneNumber?: string;
  includePhoneNumber?: boolean;
  username?: string;
  systemBody?: string;
}>;

/** Builds one raw Meta identity-change envelope, overriding only evidence relevant to a test. */
export const makeKapsoIdentityChangeBody = (
  overrides: KapsoIdentityChangeOverrides = {}
): Uint8Array => {
  const providerMessageId = overrides.providerMessageId ?? "wamid.identity-change-001";
  const timestamp = overrides.timestamp ?? "1775217600";
  const previousBsuid = overrides.previousBsuid ?? "CO.573001234567";
  const replacementBsuid = overrides.replacementBsuid ?? "CO.573009876543";
  const systemUserId = overrides.systemUserId ?? replacementBsuid;
  const phoneNumber = overrides.phoneNumber ?? "573009876543";
  const username = overrides.username ?? "Ada";
  const systemBody =
    overrides.systemBody ?? `User ${username} changed from ${previousBsuid} to ${replacementBsuid}`;

  return new TextEncoder().encode(
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                messages: [
                  {
                    id: providerMessageId,
                    timestamp,
                    type: "system",
                    system: {
                      body: systemBody,
                      ...(overrides.includePhoneNumber === false ? {} : { wa_id: phoneNumber }),
                      user_id: systemUserId,
                      type: "user_changed_user_id",
                    },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    })
  );
};
