type KapsoIdentityChangeEvidence = Readonly<{
  providerMessageId: string;
  timestamp: string;
  previousBsuid: string;
  replacementBsuid: string;
  systemUserId: string;
  phoneNumber: string;
  includePhoneNumber: boolean;
  username: string;
  systemBody: string;
}>;

type KapsoIdentityChangeOverrides = Partial<KapsoIdentityChangeEvidence>;

const changedIdentity = (
  overrides: KapsoIdentityChangeOverrides
): Pick<KapsoIdentityChangeEvidence, "systemUserId" | "systemBody"> => {
  const previousBsuid = overrides.previousBsuid ?? "CO.573001234567";
  const replacementBsuid = overrides.replacementBsuid ?? "CO.573009876543";
  const username = overrides.username ?? "Ada";
  return {
    systemUserId: overrides.systemUserId ?? replacementBsuid,
    systemBody:
      overrides.systemBody ??
      `User ${username} changed from ${previousBsuid} to ${replacementBsuid}`,
  };
};

const messageEvidence = (
  overrides: KapsoIdentityChangeOverrides
): Pick<KapsoIdentityChangeEvidence, "providerMessageId" | "timestamp"> => ({
  providerMessageId: overrides.providerMessageId ?? "wamid.identity-change-001",
  timestamp: overrides.timestamp ?? "1775217600",
});

const phoneNumberEvidence = (
  overrides: KapsoIdentityChangeOverrides
): Readonly<Record<string, string>> =>
  overrides.includePhoneNumber === false ? {} : { wa_id: overrides.phoneNumber ?? "573009876543" };

/** Builds one raw Meta identity-change envelope, overriding only evidence relevant to a test. */
export const makeKapsoIdentityChangeBody = (
  overrides: KapsoIdentityChangeOverrides = {}
): Uint8Array => {
  const identity = changedIdentity(overrides);
  const message = messageEvidence(overrides);

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
                    id: message.providerMessageId,
                    timestamp: message.timestamp,
                    type: "system",
                    system: {
                      body: identity.systemBody,
                      ...phoneNumberEvidence(overrides),
                      user_id: identity.systemUserId,
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
