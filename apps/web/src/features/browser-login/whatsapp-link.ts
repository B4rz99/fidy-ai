const currentFidyWhatsAppNumber = "+56920403095" as const;

/** Builds the public-code-only mobile action for Fidy's current deployed WhatsApp sandbox. */
export const browserLoginPairingWhatsAppUrl = (publicCode: string): string => {
  const digits = currentFidyWhatsAppNumber.replaceAll(/[^0-9]/gu, "");
  const message = `Aprueba el código de inicio de sesión ${publicCode}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
};
