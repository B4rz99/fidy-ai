import { fidyWhatsAppUrl } from "@/transport/client";

/** Uses the same Fidy destination as signup, with only the public pairing code. */
export const browserLoginPairingWhatsAppUrl = (publicCode: string): string => {
  const message = `Aprueba el código de inicio de sesión ${publicCode}`;
  const destination = new URL(fidyWhatsAppUrl);
  destination.searchParams.set("text", message);
  return destination.href;
};
