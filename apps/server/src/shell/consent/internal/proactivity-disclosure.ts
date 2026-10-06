import { Schema } from "effect";
import { DisclosureSnapshot } from "~/core/consent/contract";
import type { ProactivityOptInKind } from "~/shell/consent/contract";
import { currentDisclosureFacts } from "./current-disclosure";

const reminderText = `¿Quieres recibir gratis recordatorios de Fidy por WhatsApp para registrar tus movimientos? Por defecto se programan todos los días a las 18:00 en America/Bogota, incluso si ya registraste movimientos. Puedes cambiar la frecuencia o la hora. Si ignoras tres recordatorios entregados, preguntamos si quieres continuar; si ignoras dos más, pausamos los recordatorios.

Autorizas el uso de tu identidad de WhatsApp y de tus preferencias para enviar estos recordatorios mediante Kapso y Meta. Puedes rechazar sin afectar tu acceso a Fidy o revocar esta autorización cuando quieras. Esta autorización es independiente de los resúmenes semanales y las alertas de presupuesto. Política: https://app.fidyapp.com/politica

Elige únicamente la opción explícita de aceptar, rechazar o revocar correspondiente a esta solicitud. Ninguna otra respuesta concede autorización.`;
const budgetText = `¿Quieres recibir gratis alertas de presupuesto de Fidy por WhatsApp? Avisamos cuando las salidas registradas de la misma categoría y moneda alcanzan el 80% o el 100% de un presupuesto mensual. Cada umbral se avisa una vez al mes. No convertimos monedas ni enviamos alertas de umbrales anteriores a tu autorización. No es asesoría financiera.

Autorizas el uso de tus datos financieros registrados para generar y enviar estas alertas mediante Kapso y Meta. Puedes rechazar sin afectar tu acceso a Fidy o revocar esta autorización cuando quieras. Esta autorización es independiente de los resúmenes semanales y los recordatorios. Política: https://app.fidyapp.com/politica

Elige únicamente la opción explícita de aceptar, rechazar o revocar correspondiente a esta solicitud. Ninguna otra respuesta concede autorización.`;

export const proactivityDisclosure = (kind: ProactivityOptInKind): DisclosureSnapshot =>
  Schema.decodeSync(DisclosureSnapshot)({
    ...currentDisclosureFacts,
    revision: `${kind}-whatsapp-2026-10-05`,
    contentSha256:
      kind === "manual-entry-reminder"
        ? "b6b19d139d7cc400e40f6208aaad71329742a32dbe2523bb429378b0e179c8c1"
        : "87b495d09eca025dfb72014867aae5832c2bc231cf38c2811893b7e93a2eade6",
    text: kind === "manual-entry-reminder" ? reminderText : budgetText,
    purposes: [
      kind === "manual-entry-reminder"
        ? "Enviar recordatorios gratuitos de registro manual por WhatsApp"
        : "Generar y enviar alertas gratuitas de presupuesto por WhatsApp",
    ],
    dataCategories:
      kind === "manual-entry-reminder"
        ? ["Preferencias de recordatorios", "Identidad de WhatsApp y evidencia de la decisión"]
        : ["Datos financieros registrados", "Identidad de WhatsApp y evidencia de la decisión"],
    duration:
      "Hasta que revoques la autorización; la evidencia de la decisión se conserva para acreditar la autorización.",
    revocationMethod:
      "Elegir Revocar en una solicitud explícita de esta categoría o solicitarlo a obarboza@fidyapp.com.",
  });
