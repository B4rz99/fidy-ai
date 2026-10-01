import type { EmailStatus } from "~/shell/consent/contract";

export const emailStatusMessages: Readonly<Record<EmailStatus, string>> = {
  awaiting_email:
    "Consentimiento registrado. Responde con tu correo electrónico para recibir el código de verificación.",
  awaiting_delivery: "Registramos tu correo; aún no se ha confirmado el envío del código.",
  sending: "El envío está en curso. Todavía no podemos confirmar si el proveedor lo aceptó.",
  awaiting_proof:
    "El proveedor aceptó la solicitud del código. Revisa tu correo; no podemos confirmar su llegada.",
  rejected: "El proveedor rechazó el envío. No se reenviará automáticamente; contacta a soporte.",
  ambiguous:
    "No podemos confirmar si el proveedor envió el código. No lo reenviamos automáticamente; contacta a soporte.",
};
