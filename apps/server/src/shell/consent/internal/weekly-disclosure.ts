import { DisclosureSnapshot } from "~/core/consent/contract";
import { Schema } from "effect";
import { currentDisclosureFacts } from "./current-disclosure";

const text = `¿Quieres recibir gratis tu resumen semanal de Fidy por WhatsApp? Cada semana muestra los ingresos y salidas registrados, separados por moneda, y las categorías con más salidas. No es asesoría financiera. Por defecto se programa los domingos a las 18:00 en America/Bogota. Si no hay movimientos, no enviamos resumen. Autorizas el uso de tus datos financieros registrados para generar y enviar este resumen mediante Kapso y Meta. Puedes rechazar sin afectar tu acceso a Fidy o revocar esta autorización cuando quieras. Política: https://app.fidyapp.com/politica Elige únicamente la opción explícita de aceptar, rechazar o revocar correspondiente a esta solicitud. Ninguna otra respuesta concede autorización.`;

export const weeklyDisclosure = (): DisclosureSnapshot =>
  Schema.decodeSync(DisclosureSnapshot)({
    ...currentDisclosureFacts,
    revision: "weekly-whatsapp-2026-11-07",
    contentSha256: "47cb79accbd1c00220c27d74ff4bc7d58dcfbb794b17736f86fda509c2856213",
    text,
    purposes: ["Generar y enviar el resumen semanal gratuito por WhatsApp"],
    dataCategories: [
      "Datos financieros registrados",
      "Identidad de WhatsApp y evidencia de la decisión",
    ],
    duration:
      "Hasta que revoques la autorización; la evidencia de la decisión se conserva para acreditar la autorización.",
    revocationMethod:
      "Elegir Revocar en una solicitud explícita del resumen semanal o solicitarlo a obarboza@fidyapp.com.",
  });
